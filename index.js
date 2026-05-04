require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const storage = require('./core/storage');
const { pushLeadToSheet, startSheetOutboxWorker } = require('./core/sheets-webhook');
const { loadProducts } = require('./core/products');
const { createRuleEngine } = require('./core/rules');

const ROOT_DIR = __dirname;

function normalizeShopId(raw) {
  const id = String(raw ?? 'adult-shop').trim();
  if (!id || /[\\/]/.test(id)) return 'adult-shop';
  return id;
}

/**
 * Nạp shops/<SHOP_ID>/config.js + products.csv + custom-intents.js (prepend/append).
 * SHOP_ID hoặc ACTIVE_SHOP trong .env; mặc định adult-shop.
 */
function loadShopRuntime(rootDir) {
  const shopId = normalizeShopId(process.env.SHOP_ID || process.env.ACTIVE_SHOP);
  const shopDir = path.join(rootDir, 'shops', shopId);
  if (!fs.existsSync(shopDir)) {
    throw new Error(`Shop không tồn tại: "${shopId}" (${shopDir})`);
  }
  const configPath = path.join(shopDir, 'config.js');
  const csvPath = path.join(shopDir, 'products.csv');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Thiếu shops/${shopId}/config.js`);
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Thiếu shops/${shopId}/products.csv`);
  }

  const shopConfig = require(configPath);
  const products = loadProducts(csvPath);

  const customPath = path.join(shopDir, 'custom-intents.js');
  const prepend = [];
  const append = [];
  if (fs.existsSync(customPath)) {
    const custom = require(customPath);
    if (Array.isArray(custom.prepend)) prepend.push(...custom.prepend);
    if (Array.isArray(custom.append)) append.push(...custom.append);
  }

  const mergedConfig = {
    ...shopConfig,
    intents: {
      ...(shopConfig.intents || {}),
      disabled: [...(shopConfig.intents?.disabled || [])],
      prepend: [...prepend, ...(shopConfig.intents?.prepend || [])],
      append: [...(shopConfig.intents?.append || []), ...append]
    }
  };

  return { shopId, shopDir, config: mergedConfig, products };
}

let shopRuntime;
try {
  shopRuntime = loadShopRuntime(ROOT_DIR);
} catch (err) {
  console.error('❌', err.message);
  process.exit(1);
}

const { shopId: ACTIVE_SHOP_ID, shopDir: SHOP_DIR, config: shopConfig, products } = shopRuntime;

const rules = createRuleEngine({
  products,
  config: shopConfig,
  contextStore: {
    getLastProductCode: userId => storage.getLastProductCode(userId),
    setLastProductCode: (userId, code) => storage.setLastProductCode(userId, code),
    getOrderDraft: userId => storage.getOrderDraft(userId),
    // State machine: rules.js suy ra IDLE/PRODUCT_SELECTED/COLLECTING_INFO/READY_TO_CONFIRM
    // từ orderDraft + lastProductCode, chỉ có CONFIRMED là cần lưu tường minh.
    getSessionState: userId => storage.getSessionState(userId),
    setSessionState: (userId, state) => storage.setSessionState(userId, state),
    clearOrderDraft: userId => storage.clearOrderDraft(userId)
  }
});
const {
  buildDeterministicReply,
  buildFallbackReply,
  extractPhone,
  extractRequestedProductCodes,
  looksLikePhone,
  normalizeText,
  shouldSilenceAfterCompleteOrder,
  wantsHuman,
  wantsKeywordImage,
  wantsMenuImages,
  wantsProductImage,
  render,
  STATES
} = rules;

// ========== ENV ==========
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_PAGE_TOKEN   = process.env.FB_PAGE_TOKEN;
const FB_APP_SECRET   = process.env.FB_APP_SECRET;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const USE_GEMINI      = String(process.env.USE_GEMINI || 'true').toLowerCase() !== 'false';
const PORT            = process.env.PORT || 3000;
const ADMIN_EXPORT_TOKEN = process.env.ADMIN_EXPORT_TOKEN || '';
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
  process.env.RENDER_EXTERNAL_URL ||
  '';

const required = { FB_VERIFY_TOKEN, FB_PAGE_TOKEN };
if (USE_GEMINI) required.GEMINI_API_KEY = GEMINI_API_KEY;
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('❌ Thiếu biến môi trường bắt buộc:', missing.join(', '));
  console.error('   Hãy điền vào file .env (local) hoặc Variables trên Railway/Render.');
  process.exit(1);
}
if (!FB_APP_SECRET) {
  console.warn('⚠️  Chưa set FB_APP_SECRET — webhook sẽ KHÔNG xác thực chữ ký.');
  console.warn('   Khuyến nghị thêm để tránh request giả từ ngoài.');
}

// ========== APP ==========
const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ========== IMAGE SERVING ==========
const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const IMAGE_DIRS = [
  path.join(SHOP_DIR, 'images'),
  path.join(__dirname, 'images'),
  path.join(__dirname, 'assets'),
  path.join(__dirname, '..')
].filter(dir => fs.existsSync(dir));

function buildImageIndex() {
  const index = new Map();
  for (const dir of IMAGE_DIRS) {
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
      // Ưu tiên ảnh trong shop hiện tại, tránh bị thư mục global ghi đè.
      if (!index.has(file.toLowerCase())) {
        index.set(file.toLowerCase(), path.join(dir, file));
      }
    }
  }
  return index;
}

const IMAGE_INDEX = buildImageIndex();

function getImageFilename(baseName) {
  const clean = String(baseName || '').trim();
  if (!clean) return null;

  const hasExt = ALLOWED_IMAGE_EXT.has(path.extname(clean).toLowerCase());
  if (hasExt) {
    return IMAGE_INDEX.has(clean.toLowerCase()) ? clean : null;
  }

  for (const ext of ALLOWED_IMAGE_EXT) {
    const withExt = `${clean}${ext}`;
    if (IMAGE_INDEX.has(withExt.toLowerCase())) return withExt;
  }
  return null;
}

function getPublicImageUrl(filename, baseUrlOverride = '') {
  const baseRaw = baseUrlOverride || PUBLIC_BASE_URL;
  if (!baseRaw || !filename) return null;
  const base = baseRaw.replace(/\/+$/, '');
  return `${base}/media/${encodeURIComponent(filename)}`;
}

app.get('/media/:filename', (req, res) => {
  const filename = req.params.filename;
  const fullPath = IMAGE_INDEX.get(String(filename || '').toLowerCase());
  if (!fullPath) return res.sendStatus(404);
  res.sendFile(fullPath);
});

// ========== SYSTEM PROMPT ==========
function buildSystemPrompt() {
  if (typeof shopConfig.buildSystemPrompt === 'function') {
    return shopConfig.buildSystemPrompt(products);
  }
  const lines = products.map(p => {
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

  return `Bạn là nhân viên tư vấn bán hàng thân thiện của ${shopConfig.shopName || 'shop'}.

DANH SÁCH SẢN PHẨM:
${lines}

Hãy trả lời ngắn gọn, tự nhiên; chỉ dùng sản phẩm và giá trong danh sách; xưng hô anh/chị nhất quán.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

// ========== HÀM GỌI GEMINI ==========
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

async function postGeminiWithRetry(history) {
  const maxAttempts = 3;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
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

/** Bỏ phần model hay lặp từ system prompt (meta kỹ thuật / xưng hô sai). */
function sanitizeGeminiReply(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  s = s.replace(/\s*\([^)]*(?:hệ\s*thống|tự\s*động|he\s*thong|tu\s*dong)[^)]*\)/gi, '');
  s = s.replace(/\banh\s*\/\s*em\b/gi, 'anh/chị');
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
}

async function callGemini(userId, userMessage) {
  const history = storage.getHistory(userId);
  history.push({ role: 'user', parts: [{ text: userMessage }] });

  // Giữ tối đa 20 tin nhắn để tiết kiệm token
  if (history.length > 20) history.splice(0, history.length - 20);

  const res = await postGeminiWithRetry(history);

  const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text
    || 'Xin lỗi anh/chị, em chưa hiểu ý. Anh/chị có thể nói rõ hơn không ạ? 😊';
  const botReply = sanitizeGeminiReply(raw) || raw;
  storage.setHistory(userId, history);

  return botReply;
}

// ========== HÀM GỬI TIN NHẮN FB ==========
const BOT_MESSAGE_METADATA = 'shop-bot:auto-reply';

async function postFb(payload, attempts = 2, options = {}) {
  const timeout = options.timeout || 10000;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await axios.post(
        `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`,
        payload,
        { timeout }
      );
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      // Chỉ retry khi lỗi tạm thời (network / 5xx). 4xx (token sai, recipient lạ) thì fail nhanh.
      if (status && status >= 400 && status < 500) break;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

async function sendMessage(recipientId, text) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, 1900));
    text = text.slice(1900);
  }

  for (const chunk of chunks) {
    await postFb({
      recipient: { id: recipientId },
      message: { text: chunk, metadata: BOT_MESSAGE_METADATA }
    });
  }
}

async function sendImage(recipientId, imageUrl) {
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
  });
}

function showTyping(recipientId) {
  // Fire-and-forget: lỗi typing không chặn flow trả lời chính
  return postFb(
    { recipient: { id: recipientId }, sender_action: 'typing_on' },
    1,
    { timeout: 5000 }
  ).catch(() => {});
}

// ========== XÁC THỰC CHỮ KÝ FB ==========
function verifySignature(req) {
  if (!FB_APP_SECRET) return true;
  const sig = req.get('X-Hub-Signature-256');
  if (!sig || !sig.startsWith('sha256=') || !req.rawBody) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', FB_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ========== HUMAN HANDOFF ==========
const HANDOFF_MS = 30 * 60 * 1000; // 30 phút

function isBotEcho(event) {
  const message = event.message || {};
  // Human replies from Meta Inbox can also include app_id, so only trust
  // the metadata we attach to messages sent by this bot.
  return message.metadata === BOT_MESSAGE_METADATA;
}

function getEchoCustomerId(event) {
  return event.recipient?.id || event.sender?.id || '';
}

function inferBaseUrlFromRequest(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const host = req.get('host');
  if (!host) return '';
  const proto = req.protocol || 'https';
  return `${proto}://${host}`;
}

function getImageFilenameForProduct(product) {
  if (product?.imageFile) {
    const direct = getImageFilename(product.imageFile);
    if (direct) return direct;
  }

  const code = String(product?.code || '');
  const maMatch = code.match(/(\d{1,2})/);
  if (maMatch) {
    const n = Number(maMatch[1]);
    const candidates = [`ma${n}`, `mã${n}`, `MA${n}`, `MÃ${n}`];
    for (const name of candidates) {
      const f = getImageFilename(name);
      if (f) return f;
    }
  }

  const extras = typeof shopConfig.productImageExtraNames === 'function'
    ? shopConfig.productImageExtraNames(product)
    : [];
  for (const name of extras) {
    const f = getImageFilename(name);
    if (f) return f;
  }
  return null;
}

// ========== ANTI-SPAM ẢNH ==========
const IMAGE_COOLDOWN_MS = 5 * 60 * 1000; // 5 phút mỗi loại ảnh / mỗi user
const IMAGE_CACHE_SWEEP_MS = 60 * 1000; // dọn rác mỗi 1 phút
const recentlySentImages = new Map(); // key = `${userId}:${filename}` -> timestamp

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
  // Quét nhanh theo đường nóng để Map không phình nếu traffic cao bất thường.
  pruneRecentlySentImages();
  const key = `${userId}:${filename}`;
  const last = recentlySentImages.get(key);
  if (last && Date.now() - last < IMAGE_COOLDOWN_MS) return false;
  recentlySentImages.set(key, Date.now());
  return true;
}

function buildRequestedImages(userText, userId) {
  const files = [];
  const reasons = [];

  if (wantsMenuImages(userText)) {
    const menu1 = getImageFilename('menu1');
    const menu2 = getImageFilename('menu2');
    if (menu1) { files.push(menu1); reasons.push('menu1'); }
    if (menu2) { files.push(menu2); reasons.push('menu2'); }
  }

  if (wantsKeywordImage(userText, 'gel')) {
    const gel = getImageFilename('gel');
    if (gel) { files.push(gel); reasons.push('gel'); }
  }

  const maCodes = extractRequestedProductCodes(userText);
  if (maCodes.length) {
    const byCode = new Map(products.map(p => [String(p.code || '').toUpperCase(), p]));
    for (const code of maCodes) {
      const p = byCode.get(code.toUpperCase());
      if (!p) continue;
      const file = getImageFilenameForProduct(p);
      if (file) { files.push(file); reasons.push(code); }
    }
  }

  // Nếu khách chỉ nói "xem ảnh" sau khi vừa hỏi/chốt một mã, gửi lại ảnh của mã gần nhất thay vì menu.
  if (!files.length && wantsProductImage(userText)) {
    const lastCode = storage.getLastProductCode(userId);
    const product = products.find(p => String(p.code || '').toUpperCase() === String(lastCode || '').toUpperCase());
    const file = getImageFilenameForProduct(product);
    if (file) { files.push(file); reasons.push(lastCode); }
  }

  const unique = [...new Set(files)].slice(0, 6);
  return unique.filter(f => shouldSendImage(userId, f));
}

function buildRequestedImageUrls(userText, userId, baseUrlOverride = '') {
  const files = buildRequestedImages(userText, userId);
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

function isProbablyIncompleteReply(reply, userText) {
  const text = String(reply || '').trim();
  if (!text) return true;

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

  return {
    name: cleanLeadPart(name),
    address
  };
}

function splitByPlusWithPhone(text) {
  const raw = cleanLeadPart(text);
  if (!/\+/.test(raw)) return null;

  const parts = raw
    .split(/\s*\+\s*/)
    .map(part => stripLeadPrefixes(part))
    .map(part => cleanLeadPart(part))
    .filter(Boolean);

  if (parts.length < 2) return null;

  const phoneIdx = parts.findIndex(part => Boolean(extractPhone(part)));
  if (phoneIdx < 0) return null;

  const name = cleanLeadPart(parts.slice(0, phoneIdx).join(' '));
  const address = cleanLeadPart(parts.slice(phoneIdx + 1).join(', '));
  return { name, address };
}

function splitNameAndAddress(text) {
  const plusFormat = splitByPlusWithPhone(text);
  if (plusFormat) return plusFormat;

  const withoutPhone = String(text || '').replace(/(?:\+?84|0)\d{8,10}/g, ' ');
  const explicit = splitExplicitOrderFields(withoutPhone);
  if (explicit) return explicit;

  const prefixed = prefixedLeadPart(withoutPhone);
  if (prefixed) return { name: prefixed.name || '', address: prefixed.address || '' };

  const lines = withoutPhone
    .split(/\r?\n/)
    .map(line => stripLeadPrefixes(line))
    .filter(Boolean);

  if (lines.length >= 2) {
    return {
      name: lines[0],
      address: cleanLeadPart(lines.slice(1).join(', '))
    };
  }

  const rest = stripLeadPrefixes(lines[0] || withoutPhone);
  if (!rest) return { name: '', address: '' };

  const commaParts = rest
    .split(/[,;]+/)
    .map(part => stripLeadPrefixes(part))
    .filter(Boolean);
  if (commaParts.length >= 2) {
    return {
      name: commaParts[0],
      address: cleanLeadPart(commaParts.slice(1).join(', '))
    };
  }

  const addressStart = normalizeText(rest).search(/\b(so|nha|ngo|ngach|duong|thon|xom|ap|xa|phuong|huyen|quan|tinh|tp|thanh pho)\b/i);
  if (addressStart > 0) {
    return {
      name: cleanLeadPart(rest.slice(0, addressStart)),
      address: cleanLeadPart(rest.slice(addressStart))
    };
  }

  const parts = rest.split(/\s+/);
  if (parts.length <= 3) return { name: rest, address: '' };
  return {
    name: cleanLeadPart(parts.slice(0, 2).join(' ')),
    address: cleanLeadPart(parts.slice(2).join(' '))
  };
}

function normalizeLeadTextField(text) {
  return cleanLeadPart(
    String(text || '')
      .replace(/(?:\+?84|0)\d{8,10}/g, ' ')
      .replace(/\s*\+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
  );
}

function buildDepositMessage(senderId) {
  const draft = storage.getOrderDraft(senderId);
  const productCode = String(draft.productCode || storage.getLastProductCode(senderId) || 'mã shop đã tư vấn').trim();
  return `Dạ em đã nhận đủ thông tin đơn hàng ${productCode}. Để bảo mật thông tin và đẩy đơn nhanh, shop áp dụng quy định cọc trước 50k tiền ship (hoặc thanh toán full để được freeship). Anh/chị quét mã QR dưới đây và ghi nội dung CK là SĐT của anh/chị nhé. Chuyển xong nhắn "ok" hoặc gửi bill để em cho hàng đi luôn ạ!`;
}

function getShopQrImageUrl(baseUrlOverride = '') {
  const qrPath = path.join(SHOP_DIR, 'images', 'qr-thanh-toan.png');
  if (!fs.existsSync(qrPath)) return null;
  return getPublicImageUrl('qr-thanh-toan.png', baseUrlOverride);
}

/**
 * Khóa idempotent cho Google Sheet: retry webhook cùng tin nhắn → cùng key.
 * - Có mid (Meta): SHA-256(`fbmid:` + mid) — an toàn nhất, ổn định qua mọi lần retry.
 * - Không mid (hiếm, ví dụ postback): SHA-256 snapshot đơn + nội dung tin nhắn chuẩn hoá.
 */
function buildSheetDedupeKey(senderId, messageId, userText) {
  const mid = String(messageId || '').trim();
  if (mid) {
    return crypto.createHash('sha256').update(`fbmid:${mid}`, 'utf8').digest('hex');
  }

  const draft = storage.getOrderDraft(senderId);
  const codeRaw = String(draft.productCode || storage.getLastProductCode(senderId) || '').trim();
  const fingerprint = [
    'nomid',
    senderId,
    normalizeText(String(userText || '')),
    draft.updatedAt || '',
    String(draft.name || '').trim(),
    String(draft.phone || '').trim(),
    String(draft.address || '').trim(),
    codeRaw
  ].join('\x1e');

  return crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex');
}

/** Lead đồng bộ Sheet khi đơn CONFIRMED: cùng trường với orderDraft + mô tả sản phẩm nếu có. */
function buildConfirmedSheetLead(senderId, opts = {}) {
  const { messageId = '', userText = '' } = opts;
  const draft = storage.getOrderDraft(senderId);
  const codeRaw = String(draft.productCode || storage.getLastProductCode(senderId) || '').trim();
  const codeUpper = codeRaw.toUpperCase();
  const product = products.find(p => String(p.code || '').toUpperCase() === codeUpper);
  const desc = String(product?.description || '').trim();
  const productInterest = product
    ? (desc ? `${product.code} — ${desc}` : String(product.code || ''))
    : codeRaw;

  return {
    dedupeKey: buildSheetDedupeKey(senderId, messageId, userText),
    senderId,
    name: String(draft.name || '').trim(),
    phone: String(draft.phone || '').trim(),
    address: String(draft.address || '').trim(),
    productCode: codeRaw,
    productInterest,
    confirmedAt: new Date().toISOString()
  };
}

function buildLeadDetails(userText, senderId) {
  const mentionedCode = extractRequestedProductCodes(userText)[0] || '';
  const productCode = mentionedCode || storage.getLastProductCode(senderId) || '';
  const phone = extractPhone(userText);
  const addressChangeMatch = String(userText || '').match(/(?:đổi|doi|sửa|sua|cập\s*nhật|cap\s*nhat|chuyển|chuyen)\s*(?:địa\s*chỉ|dia\s*chi|dc)?\s*(?:sang|thành|thanh|là|la|:)\s*(.+)$/i);
  const hasLeadPrefix = /(?:^|\n)\s*(?:tên người nhận|ten nguoi nhan|người nhận|nguoi nhan|tên|ten|địa chỉ|dia chi|dc|ship về|ship ve|giao về|giao ve)(?:\s|:|$)/i
    .test(userText);
  const addressOnly = !phone && /[,;]/.test(userText) && /\b(xã|xa|phường|phuong|huyện|huyen|quận|quan|tỉnh|tinh|tp|thành phố|thanh pho)\b/i
    .test(normalizeText(userText));
  const parsed = addressChangeMatch
    ? { name: '', address: cleanLeadPart(addressChangeMatch[1]) }
    : phone || hasLeadPrefix
    ? splitNameAndAddress(userText)
    : addressOnly
      ? { name: '', address: cleanLeadPart(stripLeadPrefixes(userText)) }
      : { name: '', address: '' };

  return {
    productCode,
    phone,
    name: normalizeLeadTextField(parsed.name),
    address: normalizeLeadTextField(parsed.address)
  };
}

async function sendTelegramAlert(leadData) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;

    const text = `🚨 CÓ ĐƠN HÀNG MỚI!
👤 Tên: ${leadData.name || 'Không có'}
📞 SĐT: ${leadData.phone || 'Không có'}
🏠 Địa chỉ: ${leadData.address || 'Không có'}
📦 Sản phẩm: ${leadData.productCode || 'Không có'}`;

    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: text
    });
  } catch (err) {
    console.error('❌ Lỗi gửi Telegram alert:', err.response?.data || err.message);
  }
}

// ========== WEBHOOK VERIFY (Meta yêu cầu) ==========
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ========== NHẬN TIN NHẮN ==========
app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    console.warn('⚠️  Sai chữ ký webhook, từ chối request.');
    return res.sendStatus(403);
  }

  res.sendStatus(200); // Trả 200 ngay để Meta không retry

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const inferredBaseUrl = inferBaseUrlFromRequest(req);
      handleEvent(event, inferredBaseUrl).catch(err => {
        console.error('❌ handleEvent:', err.response?.data || err.message);
      });
    }
  }
});

async function handleEvent(event, baseUrlOverride = '') {
  const senderId = event.sender?.id;
  if (!senderId) return;

  // Echo: tin bot tự gửi thì bỏ qua; tin page/người trực gửi tay thì tạm dừng đúng khách.
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

  // Dedup theo message id (Meta có thể retry)
  const mid = event.message?.mid;
  if (mid && storage.seenMid(mid)) return;
  if (mid) storage.markMid(mid);

  // Đang trong khoảng human handoff → bot không trả lời
  if (storage.inHandoff(senderId)) {
    console.log(`⏸️  Bỏ qua tin (handoff): ${senderId}`);
    return;
  }

  let userText = null;
  if (event.message?.text) userText = event.message.text;
  else if (event.postback?.payload) userText = event.postback.payload;
  if (!userText) return;

  console.log(`📩 [${senderId}]: ${userText}`);

  // Khách yêu cầu gặp nhân viên → tạm dừng bot, ghi log
  if (wantsHuman(userText)) {
    storage.setHandoff(senderId, Date.now() + HANDOFF_MS);
    storage.appendCustomer({
      type: 'handoff_request',
      senderId,
      phone: '',
      text: userText,
      at: new Date().toISOString()
    });
    try {
      await sendMessage(senderId, render('humanHandoff'));
    } catch {}
    return;
  }

  // Nhận diện sđt → ghi lead vào customers.csv để nhân viên xem lại.
  // Phần storage tự xếp hàng ghi file để nhiều khách nhắn cùng lúc không làm lẫn dòng CSV.
  const leadDetails = buildLeadDetails(userText, senderId);
  const prevOrderDraft = storage.getOrderDraft(senderId);
  const hasOrderDetail = Boolean(
    leadDetails.productCode || leadDetails.phone || leadDetails.name || leadDetails.address
  );
  const mergedOrderDraft = hasOrderDetail
    ? storage.mergeOrderDraft(senderId, leadDetails)
    : {};
  const currentLead = Object.keys(mergedOrderDraft).length ? mergedOrderDraft : leadDetails;

  // CONFIRMED lưu từ phiên trước + khách gửi đơn mới → xóa cờ để "ok" lại tạo transition và đẩy Sheet.
  const substantiveLead = Boolean(leadDetails.phone || leadDetails.name || leadDetails.address);
  const productChanged = Boolean(
    leadDetails.productCode &&
    String(leadDetails.productCode).toUpperCase() !== String(prevOrderDraft.productCode || '').toUpperCase()
  );
  if (
    storage.getSessionState(senderId) === STATES.CONFIRMED &&
    (substantiveLead || productChanged)
  ) {
    storage.setSessionState(senderId, '');
  }

  if (looksLikePhone(userText)) {
    storage.appendCustomer({
      type: 'lead',
      senderId,
      ...currentLead,
      phone: currentLead.phone || leadDetails.phone,
      text: userText,
      history: storage.getHistory(senderId).slice(-10),
      at: new Date().toISOString()
    });
  } else if ((leadDetails.name || leadDetails.address) && currentLead.phone && currentLead.name && currentLead.address) {
    storage.appendCustomer({
      type: 'lead_update',
      senderId,
      ...currentLead,
      text: userText,
      history: storage.getHistory(senderId).slice(-10),
      at: new Date().toISOString()
    });
  }

  const sessionBeforeConfirm = storage.getSessionState(senderId);
  if (shouldSilenceAfterCompleteOrder(userText, senderId)) {
    const nowConfirmed = storage.getSessionState(senderId) === STATES.CONFIRMED;
    const justConfirmed = nowConfirmed && sessionBeforeConfirm !== STATES.CONFIRMED;
    if (justConfirmed) {
      console.log(`📤 Đơn vừa CONFIRMED — gửi lead lên Google Sheet (${senderId}).`);
      const confirmedLead = buildConfirmedSheetLead(senderId, { messageId: mid || '', userText });
      void pushLeadToSheet(confirmedLead);
      sendTelegramAlert(confirmedLead);
      try {
        await sendMessage(senderId, buildDepositMessage(senderId));
        const qrUrl = getShopQrImageUrl(baseUrlOverride);
        if (qrUrl) {
          await sendImage(senderId, qrUrl);
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
    showTyping(senderId);

    // Chạy song song: vừa gửi ảnh vừa gọi Gemini để bớt độ trễ
    const images = buildRequestedImageUrls(userText, senderId, baseUrlOverride);
    imagePromise = (async () => {
      for (const { file, url } of images) {
        try {
          await sendImage(senderId, url);
          console.log(`🖼️  Gửi ảnh: ${file}`);
        } catch (e) {
          const msg = e.response?.data?.error?.message || e.message;
          console.error(`❌ Gửi ảnh ${file} fail: ${msg}`);
        }
      }
    })();

    let reply = buildDeterministicReply(userText, senderId);
    if (reply) {
      console.log('⚡ Trả lời rule-based, không gọi Gemini');
    } else if (!USE_GEMINI) {
      reply = buildFallbackReply(userText, senderId);
      console.log('🧩 USE_GEMINI=false, dùng fallback rule-based');
    } else {
      reply = await callGemini(senderId, userText);
    }
    if (isProbablyIncompleteReply(reply, userText)) {
      console.warn(`⚠️  Gemini trả lời có vẻ bị cụt, dùng fallback. Reply gốc: ${reply.replace(/\n/g, ' ')}`);
      reply = buildFallbackReply(userText, senderId);
    }
    console.log(`🤖 reply: ${reply.slice(0, 120).replace(/\n/g, ' ')}`);
    await imagePromise; // đợi ảnh xong rồi mới gửi text để text xuất hiện sau ảnh
    await sendMessage(senderId, reply);
    console.log(`✉️  Đã gửi tin tới ${senderId}`);
  } catch (err) {
    const geminiInfo = getGeminiErrorInfo(err);
    console.error('❌ Lỗi xử lý tin:', err.response?.data || err.message || geminiInfo);
    if (shouldUseFallbackReply(err)) {
      try {
        await imagePromise;
        const fallback = buildFallbackReply(userText, senderId);
        await sendMessage(senderId, fallback);
        console.log(`🛟 Fallback do Gemini lỗi (${geminiInfo.status || geminiInfo.code || geminiInfo.httpStatus}): ${fallback.slice(0, 120).replace(/\n/g, ' ')}`);
      } catch {}
      return;
    }
    try {
      await sendMessage(senderId, render('systemBusy'));
    } catch {}
  }
}

// ========== HEALTH CHECK ==========
app.get('/', (_req, res) => res.send('🤖 Shop Bot đang chạy!'));
app.get('/healthz', (_req, res) => res.json({
  ok: true,
  shop: ACTIVE_SHOP_ID,
  products: products.length,
  uptime: Math.round(process.uptime())
}));

// ========== ADMIN EXPORT ==========
function requireAdminToken(req, res) {
  if (!ADMIN_EXPORT_TOKEN) {
    res.status(503).send('ADMIN_EXPORT_TOKEN chưa được cấu hình.');
    return false;
  }
  const token = req.query.token || req.get('x-admin-token');
  if (token !== ADMIN_EXPORT_TOKEN) {
    res.sendStatus(401);
    return false;
  }
  return true;
}

app.get('/admin/customers.csv', (req, res) => {
  if (!requireAdminToken(req, res)) return;

  const file = storage.getCustomersFile();
  if (!fs.existsSync(file)) {
    return res.status(404).send('Chưa có file customers.csv.');
  }

  res.download(file, 'customers.csv');
});

// Debug: xem session/order draft hiện tại của 1 user. Hữu ích khi nhân viên cần tra soát.
app.get('/admin/state/:userId', (req, res) => {
  if (!requireAdminToken(req, res)) return;
  const userId = req.params.userId;
  res.json({
    userId,
    inHandoff: storage.inHandoff(userId),
    lastProductCode: storage.getLastProductCode(userId),
    orderDraft: storage.getOrderDraft(userId),
    sessionState: storage.getSessionState(userId),
    historyLength: storage.getHistory(userId).length
  });
});

// Kiểm tra Page Token lúc khởi động
async function checkPageToken() {
  try {
    await axios.get(
      `https://graph.facebook.com/v19.0/me/messenger_profile?fields=greeting&access_token=${FB_PAGE_TOKEN}`,
      { timeout: 5000 }
    );
    console.log('✅ Page Token có quyền pages_messaging — sẵn sàng gửi tin');
  } catch (err) {
    const e = err.response?.data?.error;
    console.warn(`⚠️  Page Token có vấn đề: ${e?.message || err.message}`);
    console.warn('   Bot vẫn chạy, nhưng có thể KHÔNG gửi được tin tới Messenger.');
  }
}

let server = null;

function shutdown(signal) {
  console.log(`🛑 Nhận ${signal}, đang dừng server...`);
  if (!server) process.exit(0);

  server.close(() => {
    console.log('✅ Server đã dừng gọn.');
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 8000).unref();
}

if (require.main === module) {
  server = app.listen(PORT, async () => {
    console.log(`🚀 Bot shop="${ACTIVE_SHOP_ID}" port ${PORT} (sản phẩm: ${products.length}, Gemini: ${USE_GEMINI ? GEMINI_MODEL : 'off'})`);
    await checkPageToken();
    startSheetOutboxWorker();
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  buildDeterministicReply,
  buildFallbackReply,
  buildLeadDetails
};
