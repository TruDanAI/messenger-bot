require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const storage = require('./storage');
const { pushLeadToSheet } = require('./sheets-webhook');
const { loadProducts } = require('./products');
const { createRuleEngine } = require('./rules');

const ROOT_DIR = path.join(__dirname, '..');

// ========== CONSTANTS & ENV ==========
const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const IMAGE_COOLDOWN_MS = 5 * 60 * 1000; // 5 phút mỗi loại ảnh / mỗi user
const IMAGE_CACHE_SWEEP_MS = 60 * 1000; // dọn rác mỗi 1 phút
const HANDOFF_MS = 30 * 60 * 1000; // 30 phút
const BOT_MESSAGE_METADATA = 'shop-bot:auto-reply';

const FB_PAGE_TOKEN   = process.env.FB_PAGE_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
  process.env.RENDER_EXTERNAL_URL ||
  '';

// ========== MULTI-TENANT ENGINE FACTORY ==========
const engineCache = new Map();
const GLOBAL_IMAGE_INDEX = new Map();

function normalizeShopId(raw) {
  const id = String(raw ?? 'adult-shop').trim();
  if (!id || /[\\/]/.test(id)) return 'adult-shop';
  return id;
}

function getShopEngine(shopIdRaw) {
  const shopId = normalizeShopId(shopIdRaw);
  if (engineCache.has(shopId)) return engineCache.get(shopId);

  const shopDir = path.join(ROOT_DIR, 'shops', shopId);
  if (!fs.existsSync(shopDir)) {
    throw new Error(`Shop không tồn tại: "${shopId}" (${shopDir})`);
  }

  const configPath = path.join(shopDir, 'config.js');
  const csvPath = path.join(shopDir, 'products.csv');
  if (!fs.existsSync(configPath)) throw new Error(`Thiếu ${configPath}`);
  if (!fs.existsSync(csvPath)) throw new Error(`Thiếu ${csvPath}`);

  const localConfig = require(configPath);
  const products = loadProducts(csvPath);

  const customPath = path.join(shopDir, 'custom-intents.js');
  const prepend = [];
  const append = [];
  if (fs.existsSync(customPath)) {
    const custom = require(customPath);
    if (Array.isArray(custom.prepend)) prepend.push(...custom.prepend);
    if (Array.isArray(custom.append)) append.push(...custom.append);
  }

  const mergedLocalConfig = {
    ...localConfig,
    intents: {
      ...(localConfig.intents || {}),
      disabled: [...(localConfig.intents?.disabled || [])],
      prepend: [...prepend, ...(localConfig.intents?.prepend || [])],
      append: [...(localConfig.intents?.append || []), ...append]
    }
  };

  const rules = createRuleEngine({
    products,
    config: mergedLocalConfig,
    contextStore: {
      getLastProductCode: userId => storage.getLastProductCode(userId),
      setLastProductCode: (userId, code) => storage.setLastProductCode(userId, code),
      getOrderDraft: userId => storage.getOrderDraft(userId),
      getSessionState: userId => storage.getSessionState(userId),
      setSessionState: (userId, state) => storage.setSessionState(userId, state),
      clearOrderDraft: userId => storage.clearOrderDraft(userId)
    }
  });

  const imageDirs = [
    path.join(shopDir, 'images'),
    path.join(__dirname, 'images'),
    path.join(__dirname, 'assets'),
    path.join(__dirname, '..')
  ].filter(dir => fs.existsSync(dir));

  const imageIndex = new Map();
  for (const dir of imageDirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => e.name);
    } catch {
      continue;
    }

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!ALLOWED_IMAGE_EXT.has(ext)) continue;
      if (!imageIndex.has(file.toLowerCase())) {
        const fullPath = path.join(dir, file);
        imageIndex.set(file.toLowerCase(), fullPath);
        GLOBAL_IMAGE_INDEX.set(file.toLowerCase(), fullPath);
      }
    }
  }

  const engine = {
    shopId,
    shopDir,
    localConfig: mergedLocalConfig,
    products,
    rules,
    imageIndex
  };

  engineCache.set(shopId, engine);
  return engine;
}

// ========= HELPERS =========

function getImageFilename(engine, baseName) {
  const clean = String(baseName || '').trim();
  if (!clean) return null;

  const hasExt = ALLOWED_IMAGE_EXT.has(path.extname(clean).toLowerCase());
  if (hasExt) {
    return engine.imageIndex.has(clean.toLowerCase()) ? clean : null;
  }

  for (const ext of ALLOWED_IMAGE_EXT) {
    const withExt = `${clean}${ext}`;
    if (engine.imageIndex.has(withExt.toLowerCase())) return withExt;
  }
  return null;
}

function getPublicImageUrl(filename, baseUrlOverride = '') {
  const baseRaw = baseUrlOverride || PUBLIC_BASE_URL;
  if (!baseRaw || !filename) return null;
  const base = baseRaw.replace(/\/+$/, '');
  return `${base}/media/${encodeURIComponent(filename)}`;
}

function buildSystemPrompt(engine, shopConfigDB) {
  const mergedConfig = { ...engine.localConfig, ...shopConfigDB };
  if (typeof mergedConfig.buildSystemPrompt === 'function') {
    return mergedConfig.buildSystemPrompt(engine.products);
  }
  const lines = engine.products.map(p => {
    const parts = [
      p.code,
      p.price,
      p.description,
      p.size,
      p.weight,
      p.gift ? `Tặng ${p.gift}` : '',
      p.preorder ? 'Hàng đặt' : ''
    ].filter(Boolean);
    return `- ${parts.join(' | ')}`;
  }).join('\n');

  return `Bạn là nhân viên tư vấn bán hàng thân thiện của ${mergedConfig.shopName || 'shop'}.

DANH SÁCH SẢN PHẨM:
${lines}

Hãy trả lời ngắn gọn, tự nhiên; chỉ dùng sản phẩm và giá trong danh sách; xưng hô anh/chị nhất quán.`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGeminiErrorInfo(err) {
  const error = err?.response?.data?.error || {};
  return {
    httpStatus: err?.response?.status,
    code: error.code,
    status: error.status,
    message: error.message || err?.message || 'Unknown Gemini error'
  };
}

function isGeminiRetryableError(err) {
  const info = getGeminiErrorInfo(err);
  const message = String(info.message || '').toLowerCase();
  return info.httpStatus === 503
    || info.code === 503
    || info.status === 'UNAVAILABLE'
    || message.includes('high demand')
    || message.includes('temporarily unavailable')
    || message.includes('timeout');
}

async function postGeminiWithRetry(history, engine, shopConfigDB) {
  const maxAttempts = 3;
  let lastErr;
  
  const apiKey = shopConfigDB.credentials?.geminiApiKey || GEMINI_API_KEY;
  const model = GEMINI_MODEL;
  const prompt = shopConfigDB.customPrompt || buildSystemPrompt(engine, shopConfigDB);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          system_instruction: { parts: [{ text: prompt }] },
          contents: history,
          generationConfig: { temperature: 0.8, maxOutputTokens: 800 }
        },
        { timeout: 20000 }
      );
    } catch (err) {
      lastErr = err;
      if (!isGeminiRetryableError(err) || attempt === maxAttempts) break;
      const delayMs = 1000 * (2 ** (attempt - 1));
      const info = getGeminiErrorInfo(err);
      console.warn(`⚠️  Gemini tạm quá tải, retry ${attempt}/${maxAttempts - 1} sau ${delayMs}ms: ${info.message}`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function sanitizeGeminiReply(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  s = s.replace(/\s*\([^)]*(?:hệ\s*thống|tự\s*động|he\s*thong|tu\s*dong)[^)]*\)/gi, '');
  s = s.replace(/\banh\s*\/\s*em\b/gi, 'anh/chị');
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
}

async function callGemini(userId, userMessage, engine, shopConfigDB) {
  const history = storage.getHistory(userId);
  history.push({ role: 'user', parts: [{ text: userMessage }] });

  if (history.length > 20) history.splice(0, history.length - 20);

  const res = await postGeminiWithRetry(history, engine, shopConfigDB);

  const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text
    || 'Xin lỗi anh/chị, em chưa hiểu ý. Anh/chị có thể nói rõ hơn không ạ? 😊';
  const botReply = sanitizeGeminiReply(raw) || raw;
  storage.setHistory(userId, history);

  return botReply;
}

async function postFb(payload, attempts = 2, options = {}) {
  const timeout = options.timeout || 10000;
  const token = options.fbPageToken || FB_PAGE_TOKEN;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await axios.post(
        `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`,
        payload,
        { timeout }
      );
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) break;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

async function sendMessage(recipientId, text, shopConfigDB) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, 1900));
    text = text.slice(1900);
  }
  for (const chunk of chunks) {
    await postFb({
      recipient: { id: recipientId },
      message: { text: chunk, metadata: BOT_MESSAGE_METADATA }
    }, 2, { fbPageToken: shopConfigDB?.credentials?.fbPageToken });
  }
}

async function sendImage(recipientId, imageUrl, shopConfigDB) {
  if (!imageUrl) return;
  await postFb({
    recipient: { id: recipientId },
    message: {
      metadata: BOT_MESSAGE_METADATA,
      attachment: {
        type: 'image',
        payload: { url: imageUrl, is_reusable: true }
      }
    }
  }, 2, { fbPageToken: shopConfigDB?.credentials?.fbPageToken });
}

function showTyping(recipientId, shopConfigDB) {
  return postFb(
    { recipient: { id: recipientId }, sender_action: 'typing_on' },
    1,
    { timeout: 5000, fbPageToken: shopConfigDB?.credentials?.fbPageToken }
  ).catch(() => {});
}

function isBotEcho(event) {
  const message = event.message || {};
  return message.metadata === BOT_MESSAGE_METADATA;
}

function getEchoCustomerId(event) {
  return event.recipient?.id || event.sender?.id || '';
}

function getImageFilenameForProduct(product, engine, shopConfigDB) {
  if (product?.imageFile) {
    const direct = getImageFilename(engine, product.imageFile);
    if (direct) return direct;
  }

  const code = String(product?.code || '');
  const maMatch = code.match(/(\d{1,2})/);
  if (maMatch) {
    const n = Number(maMatch[1]);
    const candidates = [`ma${n}`, `mã${n}`, `MA${n}`, `MÃ${n}`];
    for (const name of candidates) {
      const f = getImageFilename(engine, name);
      if (f) return f;
    }
  }

  const mergedConfig = { ...engine.localConfig, ...shopConfigDB };
  const extras = typeof mergedConfig.productImageExtraNames === 'function'
    ? mergedConfig.productImageExtraNames(product)
    : [];
  for (const name of extras) {
    const f = getImageFilename(engine, name);
    if (f) return f;
  }
  return null;
}

const recentlySentImages = new Map();
function pruneRecentlySentImages(now = Date.now()) {
  const expireBefore = now - IMAGE_COOLDOWN_MS;
  for (const [key, at] of recentlySentImages.entries()) {
    if (at <= expireBefore) recentlySentImages.delete(key);
  }
}

const imageCacheGcTimer = setInterval(() => {
  pruneRecentlySentImages();
}, IMAGE_CACHE_SWEEP_MS);
imageCacheGcTimer.unref?.();

function shouldSendImage(userId, filename) {
  pruneRecentlySentImages();
  const key = `${userId}:${filename}`;
  const last = recentlySentImages.get(key);
  if (last && Date.now() - last < IMAGE_COOLDOWN_MS) return false;
  recentlySentImages.set(key, Date.now());
  return true;
}

function buildRequestedImages(userText, userId, engine, shopConfigDB) {
  const files = [];
  const { wantsMenuImages, wantsKeywordImage, extractRequestedProductCodes, wantsProductImage } = engine.rules;

  if (wantsMenuImages(userText)) {
    const menu1 = getImageFilename(engine, 'menu1');
    const menu2 = getImageFilename(engine, 'menu2');
    if (menu1) files.push(menu1);
    if (menu2) files.push(menu2);
  }

  if (wantsKeywordImage(userText, 'gel')) {
    const gel = getImageFilename(engine, 'gel');
    if (gel) files.push(gel);
  }

  const maCodes = extractRequestedProductCodes(userText);
  if (maCodes.length) {
    const byCode = new Map(engine.products.map(p => [String(p.code || '').toUpperCase(), p]));
    for (const code of maCodes) {
      const p = byCode.get(code.toUpperCase());
      if (!p) continue;
      const file = getImageFilenameForProduct(p, engine, shopConfigDB);
      if (file) files.push(file);
    }
  }

  if (!files.length && wantsProductImage(userText)) {
    const lastCode = storage.getLastProductCode(userId);
    const product = engine.products.find(p => String(p.code || '').toUpperCase() === String(lastCode || '').toUpperCase());
    const file = getImageFilenameForProduct(product, engine, shopConfigDB);
    if (file) files.push(file);
  }

  const unique = [...new Set(files)].slice(0, 6);
  return unique.filter(f => shouldSendImage(userId, f));
}

function buildRequestedImageUrls(userText, userId, baseUrlOverride, engine, shopConfigDB) {
  const files = buildRequestedImages(userText, userId, engine, shopConfigDB);
  return files
    .map(file => ({ file, url: getPublicImageUrl(file, baseUrlOverride) }))
    .filter(x => x.url);
}

function shouldUseFallbackReply(err) {
  const info = getGeminiErrorInfo(err);
  const message = String(info.message || '').toLowerCase();
  return info.httpStatus === 429
    || info.httpStatus === 503
    || info.code === 429
    || info.code === 503
    || info.status === 'RESOURCE_EXHAUSTED'
    || info.status === 'UNAVAILABLE'
    || message.includes('quota')
    || message.includes('resource_exhausted')
    || message.includes('high demand')
    || message.includes('unavailable');
}

function isProbablyIncompleteReply(reply, userText, engine) {
  const text = String(reply || '').trim();
  if (!text) return true;

  const { normalizeText } = engine.rules;
  const normalizedReply = normalizeText(text);
  const normalizedUserText = normalizeText(userText);
  const looksLikeBudgetAdvice = /\b\d{2,4}\s*k\b/.test(normalizedUserText)
    || normalizedUserText.includes('ngan sach')
    || normalizedReply.includes('ngan sach');

  const endsAbruptly = !/([.!?。😊🙏]|(ạ|nhé|nha)\s*)$/i.test(text)
    || /\b(với|voi|thì|thi|là|la|nếu|neu|và|va|nhưng|nhung|k|200k|300k)$/i.test(normalizedReply);

  return looksLikeBudgetAdvice && text.length < 180 && endsAbruptly;
}

function cleanLeadPart(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:nhé|nhe|nha|ạ|a)$/i, '')
    .replace(/\s+(?:shop|ad|minh|mình|anh|chị|chi|em)\s*(?:ơi|oi)?$/i, '')
    .replace(/^[,:;\-\s]+|[,:;\-\s]+$/g, '')
    .trim();
}

function stripLeadPrefixes(text) {
  return cleanLeadPart(text)
    .replace(/^(?:tên người nhận|ten nguoi nhan|người nhận|nguoi nhan|tên|ten)\s*(?:là|la|:)?\s*/i, '')
    .replace(/^(?:địa chỉ|dia chi|dc|ship về|ship ve|giao về|giao ve)\s*(?:là|la|:)?\s*/i, '')
    .trim();
}

function prefixedLeadPart(text) {
  const raw = cleanLeadPart(text);
  const name = raw.match(/^(?:tên người nhận|ten nguoi nhan|người nhận|nguoi nhan|tên|ten)\s*(?:là|la|:)?\s*(.+)$/i);
  if (name) return { name: cleanLeadPart(name[1]) };

  const address = raw.match(/^(?:địa chỉ|dia chi|dc|ship về|ship ve|giao về|giao ve)\s*(?:là|la|:)?\s*(.+)$/i);
  if (address) return { address: cleanLeadPart(address[1]) };

  return null;
}

function splitExplicitOrderFields(text) {
  const raw = cleanLeadPart(text);
  const addressMatch = raw.match(/^(.*?)\b(?:và\s*)?(?:địa chỉ|dia chi|dc|ship về|ship ve|giao về|giao ve)\s*(?:là|la|:)?\s*(.+)$/i);
  if (!addressMatch) return null;

  const name = stripLeadPrefixes(addressMatch[1]).replace(/\b(và|va)$/i, '').trim();
  const address = cleanLeadPart(addressMatch[2]);
  if (!address) return null;

  return { name: cleanLeadPart(name), address };
}

function splitByPlusWithPhone(text, engine) {
  const raw = cleanLeadPart(text);
  if (!/\+/.test(raw)) return null;

  const parts = raw.split(/\s*\+\s*/)
    .map(part => stripLeadPrefixes(part))
    .map(part => cleanLeadPart(part))
    .filter(Boolean);

  if (parts.length < 2) return null;

  const phoneIdx = parts.findIndex(part => Boolean(engine.rules.extractPhone(part)));
  if (phoneIdx < 0) return null;

  const name = cleanLeadPart(parts.slice(0, phoneIdx).join(' '));
  const address = cleanLeadPart(parts.slice(phoneIdx + 1).join(', '));
  return { name, address };
}

function splitNameAndAddress(text, engine) {
  const plusFormat = splitByPlusWithPhone(text, engine);
  if (plusFormat) return plusFormat;

  const withoutPhone = String(text || '').replace(/(?:\+?84|0)\d{8,10}/g, ' ');
  const explicit = splitExplicitOrderFields(withoutPhone);
  if (explicit) return explicit;

  const prefixed = prefixedLeadPart(withoutPhone);
  if (prefixed) return { name: prefixed.name || '', address: prefixed.address || '' };

  const lines = withoutPhone.split(/\r?\n/).map(line => stripLeadPrefixes(line)).filter(Boolean);

  if (lines.length >= 2) {
    return { name: lines[0], address: cleanLeadPart(lines.slice(1).join(', ')) };
  }

  const rest = stripLeadPrefixes(lines[0] || withoutPhone);
  if (!rest) return { name: '', address: '' };

  const commaParts = rest.split(/[,;]+/).map(part => stripLeadPrefixes(part)).filter(Boolean);
  if (commaParts.length >= 2) {
    return { name: commaParts[0], address: cleanLeadPart(commaParts.slice(1).join(', ')) };
  }

  const addressStart = engine.rules.normalizeText(rest).search(/\b(so|nha|ngo|ngach|duong|thon|xom|ap|xa|phuong|huyen|quan|tinh|tp|thanh pho)\b/i);
  if (addressStart > 0) {
    return { name: cleanLeadPart(rest.slice(0, addressStart)), address: cleanLeadPart(rest.slice(addressStart)) };
  }

  const parts = rest.split(/\s+/);
  if (parts.length <= 3) return { name: rest, address: '' };
  return { name: cleanLeadPart(parts.slice(0, 2).join(' ')), address: cleanLeadPart(parts.slice(2).join(' ')) };
}

function normalizeLeadTextField(text) {
  return cleanLeadPart(
    String(text || '').replace(/(?:\+?84|0)\d{8,10}/g, ' ').replace(/\s*\+\s*/g, ' ').replace(/\s{2,}/g, ' ')
  );
}

function buildDepositMessage(senderId) {
  const draft = storage.getOrderDraft(senderId);
  const productCode = String(draft.productCode || storage.getLastProductCode(senderId) || 'mã shop đã tư vấn').trim();
  return `Dạ em đã nhận đủ thông tin đơn hàng ${productCode}. Để bảo mật thông tin và đẩy đơn nhanh, shop áp dụng quy định cọc trước 50k tiền ship (hoặc thanh toán full để được freeship). Anh/chị quét mã QR dưới đây và ghi nội dung CK là SĐT của anh/chị nhé. Chuyển xong nhắn "ok" hoặc gửi bill để em cho hàng đi luôn ạ!`;
}

function getShopQrImageUrl(engine, baseUrlOverride = '') {
  const qrPath = path.join(engine.shopDir, 'images', 'qr-thanh-toan.png');
  if (!fs.existsSync(qrPath)) return null;
  return getPublicImageUrl('qr-thanh-toan.png', baseUrlOverride);
}

function buildSheetDedupeKey(senderId, messageId, userText, engine) {
  const mid = String(messageId || '').trim();
  if (mid) return crypto.createHash('sha256').update(`fbmid:${mid}`, 'utf8').digest('hex');

  const draft = storage.getOrderDraft(senderId);
  const codeRaw = String(draft.productCode || storage.getLastProductCode(senderId) || '').trim();
  const fingerprint = [
    'nomid', senderId, engine.rules.normalizeText(String(userText || '')),
    draft.updatedAt || '', String(draft.name || '').trim(), String(draft.phone || '').trim(),
    String(draft.address || '').trim(), codeRaw
  ].join('\x1e');

  return crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex');
}

function buildConfirmedSheetLead(senderId, engine, opts = {}) {
  const { messageId = '', userText = '' } = opts;
  const draft = storage.getOrderDraft(senderId);
  const codeRaw = String(draft.productCode || storage.getLastProductCode(senderId) || '').trim();
  const codeUpper = codeRaw.toUpperCase();
  const product = engine.products.find(p => String(p.code || '').toUpperCase() === codeUpper);
  const desc = String(product?.description || '').trim();
  const productInterest = product ? (desc ? `${product.code} — ${desc}` : String(product.code || '')) : codeRaw;

  return {
    dedupeKey: buildSheetDedupeKey(senderId, messageId, userText, engine),
    senderId,
    name: String(draft.name || '').trim(),
    phone: String(draft.phone || '').trim(),
    address: String(draft.address || '').trim(),
    productCode: codeRaw,
    productInterest,
    confirmedAt: new Date().toISOString()
  };
}

function buildLeadDetails(userText, senderId, engine) {
  const { extractRequestedProductCodes, extractPhone } = engine.rules;
  const mentionedCode = extractRequestedProductCodes(userText)[0] || '';
  const productCode = mentionedCode || storage.getLastProductCode(senderId) || '';
  const phone = extractPhone(userText);
  const addressChangeMatch = String(userText || '').match(/(?:đổi|doi|sửa|sua|cập\s*nhật|cap\s*nhat|chuyển|chuyen)\s*(?:địa\s*chỉ|dia\s*chi|dc)?\s*(?:sang|thành|thanh|là|la|:)\s*(.+)$/i);
  const hasLeadPrefix = /(?:^|\n)\s*(?:tên người nhận|ten nguoi nhan|người nhận|nguoi nhan|tên|ten|địa chỉ|dia chi|dc|ship về|ship ve|giao về|giao ve)(?:\s|:|$)/i.test(userText);
  const addressOnly = !phone && /[,;]/.test(userText) && /\b(xã|xa|phường|phuong|huyện|huyen|quận|quan|tỉnh|tinh|tp|thành phố|thanh pho)\b/i.test(engine.rules.normalizeText(userText));
  const parsed = addressChangeMatch
    ? { name: '', address: cleanLeadPart(addressChangeMatch[1]) }
    : phone || hasLeadPrefix
    ? splitNameAndAddress(userText, engine)
    : addressOnly
      ? { name: '', address: cleanLeadPart(stripLeadPrefixes(userText)) }
      : { name: '', address: '' };

  return {
    productCode, phone,
    name: normalizeLeadTextField(parsed.name),
    address: normalizeLeadTextField(parsed.address)
  };
}

async function sendTelegramAlert(leadData, shopConfigDB) {
  try {
    const botToken = shopConfigDB?.credentials?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = shopConfigDB?.credentials?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId || !shopConfigDB?.features?.enableTelegram) return;

    const text = `🚨 CÓ ĐƠN HÀNG MỚI (Shop: ${shopConfigDB.name})!
👤 Tên: ${leadData.name || 'Không có'}
📞 SĐT: ${leadData.phone || 'Không có'}
🏠 Địa chỉ: ${leadData.address || 'Không có'}
📦 Sản phẩm: ${leadData.productCode || 'Không có'}`;

    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text });
  } catch (err) {
    console.error('❌ Lỗi gửi Telegram alert:', err.response?.data || err.message);
  }
}

// ========== MAIN HANDLER ==========

async function handleMessage(shopConfigDB, messageData) {
  const { event, baseUrlOverride } = messageData;
  const senderId = event.sender?.id;
  if (!senderId) return;

  if (event.message?.is_echo) {
    if (!isBotEcho(event)) {
      const customerId = getEchoCustomerId(event);
      if (customerId) {
        storage.setHandoff(customerId, Date.now() + HANDOFF_MS);
        console.log(`⏸️  Bật handoff do người trực trả lời: ${customerId}`);
      }
    }
    return;
  }

  const mid = event.message?.mid;
  if (mid && storage.seenMid(mid)) return;
  if (mid) storage.markMid(mid);

  if (storage.inHandoff(senderId)) {
    console.log(`⏸️  Bỏ qua tin (handoff): ${senderId}`);
    return;
  }

  let userText = null;
  if (event.message?.text) userText = event.message.text;
  else if (event.postback?.payload) userText = event.postback.payload;
  if (!userText) return;

  console.log(`📩 [${senderId}]: ${userText}`);

  // Fetch engine dynamically
  const engine = getShopEngine(shopConfigDB._id);
  const { rules } = engine;
  const STATES = rules.STATES;

  if (rules.wantsHuman(userText)) {
    storage.setHandoff(senderId, Date.now() + HANDOFF_MS);
    storage.appendCustomer({ type: 'handoff_request', senderId, phone: '', text: userText, at: new Date().toISOString() });
    try { await sendMessage(senderId, rules.render('humanHandoff'), shopConfigDB); } catch {}
    return;
  }

  const leadDetails = buildLeadDetails(userText, senderId, engine);
  const prevOrderDraft = storage.getOrderDraft(senderId);
  const hasOrderDetail = Boolean(leadDetails.productCode || leadDetails.phone || leadDetails.name || leadDetails.address);
  const mergedOrderDraft = hasOrderDetail ? storage.mergeOrderDraft(senderId, leadDetails) : {};
  const currentLead = Object.keys(mergedOrderDraft).length ? mergedOrderDraft : leadDetails;

  const substantiveLead = Boolean(leadDetails.phone || leadDetails.name || leadDetails.address);
  const productChanged = Boolean(leadDetails.productCode && String(leadDetails.productCode).toUpperCase() !== String(prevOrderDraft.productCode || '').toUpperCase());
  if (storage.getSessionState(senderId) === STATES.CONFIRMED && (substantiveLead || productChanged)) {
    storage.setSessionState(senderId, '');
  }

  if (rules.looksLikePhone(userText)) {
    storage.appendCustomer({ type: 'lead', senderId, ...currentLead, phone: currentLead.phone || leadDetails.phone, text: userText, history: storage.getHistory(senderId).slice(-10), at: new Date().toISOString() });
  } else if ((leadDetails.name || leadDetails.address) && currentLead.phone && currentLead.name && currentLead.address) {
    storage.appendCustomer({ type: 'lead_update', senderId, ...currentLead, text: userText, history: storage.getHistory(senderId).slice(-10), at: new Date().toISOString() });
  }

  const sessionBeforeConfirm = storage.getSessionState(senderId);
  if (rules.shouldSilenceAfterCompleteOrder(userText, senderId)) {
    const nowConfirmed = storage.getSessionState(senderId) === STATES.CONFIRMED;
    const justConfirmed = nowConfirmed && sessionBeforeConfirm !== STATES.CONFIRMED;
    if (justConfirmed) {
      console.log(`📤 Đơn vừa CONFIRMED — gửi lead lên Google Sheet (${senderId}).`);
      const confirmedLead = buildConfirmedSheetLead(senderId, engine, { messageId: mid || '', userText });
      void pushLeadToSheet(confirmedLead);
      sendTelegramAlert(confirmedLead, shopConfigDB);
      try {
        await sendMessage(senderId, buildDepositMessage(senderId), shopConfigDB);
        const qrUrl = getShopQrImageUrl(engine, baseUrlOverride);
        if (qrUrl) {
          await sendImage(senderId, qrUrl, shopConfigDB);
          console.log(`🧾 Đã gửi QR thanh toán cho ${senderId}`);
        }
      } catch (err) {
        console.error('❌ Lỗi gửi hướng dẫn cọc/QR:', err.response?.data || err.message);
      }
    }
    console.log(`⏸️  Bỏ qua tin xác nhận ngắn sau khi đã đủ thông tin đơn: ${senderId}`);
    return;
  }

  let imagePromise = Promise.resolve();
  try {
    showTyping(senderId, shopConfigDB);

    const images = buildRequestedImageUrls(userText, senderId, baseUrlOverride, engine, shopConfigDB);
    imagePromise = (async () => {
      for (const { file, url } of images) {
        try {
          await sendImage(senderId, url, shopConfigDB);
          console.log(`🖼️  Gửi ảnh: ${file}`);
        } catch (e) {
          console.error(`❌ Gửi ảnh ${file} fail: ${e.response?.data?.error?.message || e.message}`);
        }
      }
    })();

    let reply = rules.buildDeterministicReply(userText, senderId);
    if (reply) {
      console.log('⚡ Trả lời rule-based, không gọi Gemini');
    } else if (!shopConfigDB.features.enableAI) {
      reply = rules.buildFallbackReply(userText, senderId);
      console.log('🧩 enableAI=false (theo Gói cước), dùng fallback rule-based');
    } else {
      reply = await callGemini(senderId, userText, engine, shopConfigDB);
    }

    if (isProbablyIncompleteReply(reply, userText, engine)) {
      console.warn(`⚠️  Gemini trả lời bị cụt, dùng fallback. Reply gốc: ${reply.replace(/\n/g, ' ')}`);
      reply = rules.buildFallbackReply(userText, senderId);
    }

    console.log(`🤖 reply: ${reply.slice(0, 120).replace(/\n/g, ' ')}`);
    await imagePromise;
    await sendMessage(senderId, reply, shopConfigDB);
    console.log(`✉️  Đã gửi tin tới ${senderId}`);
  } catch (err) {
    const geminiInfo = getGeminiErrorInfo(err);
    console.error('❌ Lỗi xử lý tin:', err.response?.data || err.message || geminiInfo);
    if (shouldUseFallbackReply(err)) {
      try {
        await imagePromise;
        const fallback = rules.buildFallbackReply(userText, senderId);
        await sendMessage(senderId, fallback, shopConfigDB);
        console.log(`🛟 Fallback do Gemini lỗi (${geminiInfo.status || geminiInfo.code || geminiInfo.httpStatus}): ${fallback.slice(0, 120).replace(/\n/g, ' ')}`);
      } catch {}
      return;
    }
    try { await sendMessage(senderId, rules.render('systemBusy'), shopConfigDB); } catch {}
  }
}

module.exports = {
  handleMessage,
  storage,
  IMAGE_INDEX: GLOBAL_IMAGE_INDEX // Export global image index cho index.js
};
