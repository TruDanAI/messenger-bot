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
// Tự động nhận diện thư mục lưu trữ: Ưu tiên env SHOPS_DIR -> /data/shops (Volume) -> ./shops (Local)
const SHOPS_DIR = process.env.SHOPS_DIR || (fs.existsSync('/data') ? '/data/shops' : path.join(ROOT_DIR, 'shops'));

// ========== MULTI-TENANT RUNTIME MANAGER ==========

function normalizeShopId(raw) {
  const id = String(raw ?? 'adult-shop').trim();
  if (!id || /[\\/]/.test(id)) return 'adult-shop';
  return id;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeConfig(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      merged[key] = [...value];
    } else if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = deepMergeConfig(base[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function buildDbRuntimeConfig(shopDoc) {
  if (!shopDoc) return {};
  const doc = typeof shopDoc.toObject === 'function' ? shopDoc.toObject() : shopDoc;
  return {
    shopName: doc.name || undefined,
    minAge: doc.minAge,
    policies: doc.policies,
    recommendations: doc.recommendations,
    keywordProducts: doc.keywordProducts,
    templates: doc.templates,
    intents: doc.intents,
    customPrompt: doc.customPrompt || '',
    menu_images: Array.isArray(doc.menu_images) ? [...doc.menu_images] : [],
    ...(isPlainObject(doc.configOverrides) ? doc.configOverrides : {})
  };
}

function loadShopRuntime(shopId, shopDoc = null) {
  const safeShopId = normalizeShopId(shopId);
  // Nếu dùng /data trực tiếp làm volume thì shops sẽ nằm ngay trong đó
  const shopDir = (SHOPS_DIR === '/data') ? path.join(SHOPS_DIR, safeShopId) : path.join(SHOPS_DIR, safeShopId);
  
  if (!fs.existsSync(SHOPS_DIR)) fs.mkdirSync(SHOPS_DIR, { recursive: true });
  
  if (!fs.existsSync(shopDir)) {
    fs.mkdirSync(shopDir, { recursive: true });
  }
  
  const imgDir = path.join(shopDir, 'images');
  if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

  const configPath = path.join(shopDir, 'config.js');
  const csvPath = path.join(shopDir, 'products.csv');
  
  // Tạo file config mặc định nếu chưa có (rất quan trọng khi dùng Volume trống)
  if (!fs.existsSync(configPath)) {
    const defaultBotConfig = `module.exports = { 
  shopName: "${safeShopId}", 
  menuImages: ["menu1.png", "menu2.png"],
  intents: { prepend: [], append: [] }
};`;
    fs.writeFileSync(configPath, defaultBotConfig, 'utf8');
  }
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, 'code,price,description,size,preorder,image\n', 'utf8');
  }

  // Luôn xóa cache để load dữ liệu mới nhất
  if (require.cache[require.resolve(configPath)]) delete require.cache[require.resolve(configPath)];
  const shopConfig = require(configPath);
  const products = loadProducts(csvPath);

  const customPath = path.join(shopDir, 'custom-intents.js');
  const prepend = [];
  const append = [];
  if (fs.existsSync(customPath)) {
    if (require.cache[require.resolve(customPath)]) delete require.cache[require.resolve(customPath)];
    const custom = require(customPath);
    if (Array.isArray(custom.prepend)) prepend.push(...custom.prepend);
    if (Array.isArray(custom.append)) append.push(...custom.append);
  }

  const dbConfig = buildDbRuntimeConfig(shopDoc);
  const mergedConfig = deepMergeConfig({
    ...shopConfig,
    intents: {
      ...(shopConfig.intents || {}),
      disabled: [...(shopConfig.intents?.disabled || [])],
      prepend: [...prepend, ...(shopConfig.intents?.prepend || [])],
      append: [...(shopConfig.intents?.append || []), ...append]
    }
  }, dbConfig);

  // If DB has intents, they should override or merge. For SaaS, DB is truth.
  if (dbConfig.intents) {
    if (dbConfig.intents.disabled) mergedConfig.intents.disabled = dbConfig.intents.disabled;
    if (dbConfig.intents.prepend) mergedConfig.intents.prepend = [...dbConfig.intents.prepend, ...mergedConfig.intents.prepend];
    if (dbConfig.intents.append) mergedConfig.intents.append = [...mergedConfig.intents.append, ...dbConfig.intents.append];
  }

  const rules = createRuleEngine({
    products,
    config: mergedConfig,
    contextStore: {
      getLastProductCode: userId => storage.getLastProductCode(userId),
      setLastProductCode: (userId, code) => storage.setLastProductCode(userId, code),
      getOrderDraft: userId => storage.getOrderDraft(userId),
      getSessionState: userId => storage.getSessionState(userId),
      setSessionState: (userId, state) => storage.setSessionState(userId, state),
      clearOrderDraft: userId => storage.clearOrderDraft(userId)
    }
  });

  return { shopId: safeShopId, shopDir, config: mergedConfig, products, rules };
}

const RUNTIME_CACHE = new Map();
function getShopRuntime(shopId, shopDoc = null) {
  const id = normalizeShopId(shopId);
  if (!RUNTIME_CACHE.has(id)) {
    RUNTIME_CACHE.set(id, loadShopRuntime(id, shopDoc));
  }
  return RUNTIME_CACHE.get(id);
}

// ========== UTILS & LEAD PARSING ==========

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const HANDOFF_MS = 30 * 60 * 1000;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 12000;
const AI_RETRY_ATTEMPTS = Number(process.env.AI_RETRY_ATTEMPTS) || 3;
const AI_RETRY_BASE_DELAY_MS = Number(process.env.AI_RETRY_BASE_DELAY_MS) || 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableAiError(err) {
  const status = err?.response?.status;
  if (status === 408 || status === 429) return true;
  if (status && status >= 500) return true;
  const code = String(err?.code || '').toUpperCase();
  return [
    'ECONNABORTED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ERR_NETWORK'
  ].includes(code) || !err?.response;
}

async function callGeminiWithRetry(apiKey, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  let lastError = null;

  for (let attempt = 1; attempt <= AI_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await axios.post(url, payload, { timeout: AI_TIMEOUT_MS });
    } catch (err) {
      lastError = err;
      if (!isRetryableAiError(err) || attempt >= AI_RETRY_ATTEMPTS) break;
      const jitter = Math.floor(Math.random() * 200);
      const delay = AI_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + jitter;
      await sleep(delay);
    }
  }

  throw lastError;
}

function getPublicImageUrl(shopId, filename, baseUrlOverride = '') {
  const baseRaw = baseUrlOverride || PUBLIC_BASE_URL;
  if (!baseRaw || !filename) return null;
  const base = baseRaw.replace(/\/+$/, '');

  // Nếu filename đã là URL hoặc path public nội bộ.
  if (filename.startsWith('http') || filename.startsWith('/static') || filename.startsWith('/media')) {
    return filename.startsWith('/') ? `${base}${filename}` : filename;
  }

  return `${base}/media/${shopId}/${encodeURIComponent(filename)}`;
}

// Giữ lại các hàm xử lý lead phức tạp từ phiên bản trước
function cleanLeadPart(text) {
  return String(text || '').trim().replace(/^[:\-\s,]+|[:\-\s,]+$/g, '');
}

function stripLeadPrefixes(text) {
  return String(text || '').replace(/^(?:tên người nhận|ten nguoi nhan|người nhận|nguoi nhan|tên|ten|địa chỉ|dia chi|dc|ship về|ship ve|giao về|giao ve)[:\-\s,]+/i, '').trim();
}

function splitNameAndAddress(text) {
  const rest = stripLeadPrefixes(text);
  const commaParts = rest.split(/[,;\n]/).map(p => p.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    return { name: cleanLeadPart(commaParts[0]), address: cleanLeadPart(commaParts.slice(1).join(', ')) };
  }
  return { name: cleanLeadPart(rest), address: '' };
}

function buildLeadDetails(userText, senderId, rules) {
  const productCode = rules.extractRequestedProductCodes(userText)[0] || storage.getLastProductCode(senderId) || '';
  const phone = rules.extractPhone(userText);
  const parsed = splitNameAndAddress(userText);
  return { productCode, phone, name: parsed.name, address: parsed.address };
}

function shopImageExists(shopId, filename) {
  if (!filename) return false;
  return fs.existsSync(path.join(SHOPS_DIR, shopId, 'images', filename));
}

function buildSystemPrompt(shopConfig, products) {
  let prompt = '';
  if (typeof shopConfig.buildSystemPrompt === 'function') {
    prompt = shopConfig.buildSystemPrompt(products);
  } else {
    const lines = products.map(p => `- ${p.code} | ${p.price} | ${p.description}`).join('\n');
    prompt = `Bạn là nhân viên tư vấn của ${shopConfig.shopName || 'shop'}.\nDANH SÁCH SẢN PHẨM:\n${lines}\nHãy trả lời ngắn gọn, tự nhiên.`;
  }

  if (shopConfig.customPrompt) {
    prompt = `${prompt}\n\nTU CHINH THEM:\n${shopConfig.customPrompt}`;
  }
  return prompt;
}

// ========== MESSAGE HANDLING CORE ==========

async function handleMessage(shopConfig, messageData) {
  const { event, baseUrlOverride } = messageData;
  const senderId = event.sender?.id;
  const shopId = shopConfig._id;
  const stateUserId = `${shopId}:${senderId}`;
  const runtime = getShopRuntime(shopId, shopConfig);
  const { rules, products, config } = runtime;

  if (event.message?.is_echo) return;

  const mid = event.message?.mid;
  if (mid && storage.seenMid(mid)) return;
  if (mid) storage.markMid(mid);

  if (storage.inHandoff(stateUserId)) return;

  let userText = null;
  if (event.message?.text) userText = event.message.text;
  else if (event.postback?.payload) userText = event.postback.payload;
  if (!userText) return;

  console.log(`📩 [${shopId}][${senderId}]: ${userText}`);

  if (rules.wantsHuman(userText)) {
    storage.setHandoff(stateUserId, Date.now() + HANDOFF_MS);
    await sendMessage(senderId, rules.render('humanHandoff'), shopConfig, stateUserId);
    return;
  }

  // 1. Gửi ảnh (nếu có yêu cầu)
  const imageFiles = [];
  if (rules.wantsMenuImages(userText)) {
    // Ưu tiên menu_images từ Database, fallback về cấu hình/file mặc định nếu tồn tại thật.
    const menus = (shopConfig.menu_images && shopConfig.menu_images.length)
      ? shopConfig.menu_images
      : (config.menu_images && config.menu_images.length)
        ? config.menu_images
        : (config.menuImages && config.menuImages.length)
          ? config.menuImages
          : ['menu1.png', 'menu2.png'];
    imageFiles.push(...menus);
  }
  const kwImg = rules.wantsKeywordImage(userText);
  if (kwImg) imageFiles.push(kwImg);
  const prodImgRequested = rules.wantsProductImage(userText);
  const prodImgCode = prodImgRequested
    ? (rules.extractRequestedProductCodes(userText)[0] || storage.getLastProductCode(stateUserId) || '')
    : '';
  if (prodImgCode) {
    const p = products.find(i => String(i.code).toUpperCase() === String(prodImgCode).toUpperCase());
    if (p?.image) imageFiles.push(p.image);
  }

  for (const file of [...new Set(imageFiles)]) {
    // Với fallback cũ, chỉ skip nếu file mặc định thực sự không tồn tại.
    if ((file === 'menu1.png' || file === 'menu2.png') && !shopImageExists(shopId, file)) {
      console.log(`⚠️ Bỏ qua gửi ảnh mặc định ${file} do chưa được cấu hình.`);
      continue;
    }
    const url = getPublicImageUrl(shopId, file, baseUrlOverride);
    if (url) await sendImage(senderId, url, shopConfig);
  }

  // 2. Xử lý logic hội thoại & Lead
  const leadDetails = buildLeadDetails(userText, stateUserId, rules);
  if (leadDetails.phone || (leadDetails.name && leadDetails.address)) {
    // 🆕 Quan trọng: Cập nhật vào Draft State để bot "nhớ" thông tin cho session
    storage.mergeOrderDraft(stateUserId, leadDetails);
    storage.appendCustomer({ type: 'lead', senderId, ...leadDetails, at: new Date().toISOString() });
  }

  const deterministic = rules.buildDeterministicReply(userText, stateUserId);
  if (deterministic) {
    await sendMessage(senderId, deterministic, shopConfig, stateUserId);
    
    // Nếu vừa xác nhận đơn, gửi alert
    if (storage.getSessionState(stateUserId) === rules.STATES.CONFIRMED) {
      const alertData = { ...leadDetails, shopName: shopConfig.name };
      // pushLeadToSheet, sendTelegramAlert... (giản lược để an toàn)
    }
  } else if (shopConfig.features?.enableAI) {
    const systemPrompt = buildSystemPrompt(config, products);
    const history = storage.getHistory(stateUserId).map(h => ({ role: h.role === 'bot' ? 'model' : 'user', parts: [{ text: h.text }] }));
    history.push({ role: 'user', parts: [{ text: userText }] });
    
    const apiKey = shopConfig.credentials?.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn(`⚠️ [AI_DISABLED] shop=${shopId} missing Gemini API key`);
      await sendMessage(senderId, rules.buildFallbackReply(userText, stateUserId), shopConfig, stateUserId);
      return;
    }
    try {
      const res = await callGeminiWithRetry(apiKey, {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history
      });
      const aiReply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiReply) throw new Error('Gemini trả về rỗng');
      await sendMessage(senderId, aiReply, shopConfig, stateUserId);
    } catch (err) {
      console.error(`❌ [AI_FAIL] shop=${shopId} sender=${senderId}:`, err.response?.status || err.code || err.message);
      await sendMessage(senderId, rules.buildFallbackReply(userText, stateUserId), shopConfig, stateUserId);
    }
  } else {
    await sendMessage(senderId, rules.buildFallbackReply(userText, stateUserId), shopConfig, stateUserId);
  }
}

// ========== FB API ==========

async function sendMessage(recipientId, text, shopConfig, stateUserId = recipientId) {
  const token = shopConfig.credentials?.fbPageToken;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      recipient: { id: recipientId },
      message: { text }
    });
    storage.appendHistory(stateUserId, { role: 'bot', text });
  } catch (err) {
    console.error('❌ SendMessage Fail:', err.response?.data || err.message);
  }
}

async function sendImage(recipientId, url, shopConfig) {
  const token = shopConfig.credentials?.fbPageToken;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      recipient: { id: recipientId },
      message: { attachment: { type: 'image', payload: { url, is_reusable: true } } }
    });
  } catch (err) {
    console.error('❌ SendImage Fail:', err.response?.data || err.message);
  }
}

module.exports = { handleMessage, storage, getShopRuntime, RUNTIME_CACHE };
