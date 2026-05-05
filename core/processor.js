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

function loadShopRuntime(shopId) {
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

  const mergedConfig = {
    ...shopConfig,
    intents: {
      ...(shopConfig.intents || {}),
      disabled: [...(shopConfig.intents?.disabled || [])],
      prepend: [...prepend, ...(shopConfig.intents?.prepend || [])],
      append: [...(shopConfig.intents?.append || []), ...append]
    }
  };

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
function getShopRuntime(shopId) {
  const id = normalizeShopId(shopId);
  if (!RUNTIME_CACHE.has(id)) {
    RUNTIME_CACHE.set(id, loadShopRuntime(id));
  }
  return RUNTIME_CACHE.get(id);
}

// ========== UTILS & LEAD PARSING ==========

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const HANDOFF_MS = 30 * 60 * 1000;

function getPublicImageUrl(shopId, filename, baseUrlOverride = '') {
  const baseRaw = baseUrlOverride || PUBLIC_BASE_URL;
  if (!baseRaw || !filename) return null;
  const base = baseRaw.replace(/\/+$/, '');

  // Nếu filename đã là URL (bắt đầu bằng http hoặc /static)
  if (filename.startsWith('http') || filename.startsWith('/static')) {
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

function buildSystemPrompt(shopConfig, products) {
  const lines = products.map(p => `- ${p.code} | ${p.price} | ${p.description}`).join('\n');
  return `Bạn là nhân viên tư vấn của ${shopConfig.shopName || 'shop'}.\nDANH SÁCH SẢN PHẨM:\n${lines}\nHãy trả lời ngắn gọn, tự nhiên.`;
}

// ========== MESSAGE HANDLING CORE ==========

async function handleMessage(shopConfig, messageData) {
  const { event, baseUrlOverride } = messageData;
  const senderId = event.sender?.id;
  const shopId = shopConfig._id;
  const runtime = getShopRuntime(shopId);
  const { rules, products, config } = runtime;

  if (event.message?.is_echo) return;

  const mid = event.message?.mid;
  if (mid && storage.seenMid(mid)) return;
  if (mid) storage.markMid(mid);

  if (storage.inHandoff(senderId)) return;

  let userText = null;
  if (event.message?.text) userText = event.message.text;
  else if (event.postback?.payload) userText = event.postback.payload;
  if (!userText) return;

  console.log(`📩 [${shopId}][${senderId}]: ${userText}`);

  if (rules.wantsHuman(userText)) {
    storage.setHandoff(senderId, Date.now() + HANDOFF_MS);
    await sendMessage(senderId, rules.render('humanHandoff'), shopConfig);
    return;
  }

  // 1. Gửi ảnh (nếu có yêu cầu)
  const imageFiles = [];
  if (rules.wantsMenuImages(userText)) {
    // Ưu tiên menu_images từ Database, nếu rỗng mới dùng mặc định
    const menus = (config.menu_images && config.menu_images.length) 
                  ? config.menu_images 
                  : (config.menuImages || ['menu1.png', 'menu2.png']);
    imageFiles.push(...menus);
  }
  const kwImg = rules.wantsKeywordImage(userText);
  if (kwImg) imageFiles.push(kwImg);
  const prodImgCode = rules.wantsProductImage(userText);
  if (prodImgCode) {
    const p = products.find(i => String(i.code).toUpperCase() === String(prodImgCode).toUpperCase());
    if (p?.image) imageFiles.push(p.image);
  }

  for (const file of [...new Set(imageFiles)]) {
    const url = getPublicImageUrl(shopId, file, baseUrlOverride);
    if (url) await sendImage(senderId, url, shopConfig);
  }

  // 2. Xử lý logic hội thoại & Lead
  const leadDetails = buildLeadDetails(userText, senderId, rules);
  if (leadDetails.phone || (leadDetails.name && leadDetails.address)) {
    // 🆕 Quan trọng: Cập nhật vào Draft State để bot "nhớ" thông tin cho session
    storage.mergeOrderDraft(senderId, leadDetails);
    storage.appendCustomer({ type: 'lead', senderId, ...leadDetails, at: new Date().toISOString() });
  }

  const deterministic = rules.buildDeterministicReply(userText, senderId);
  if (deterministic) {
    await sendMessage(senderId, deterministic, shopConfig);
    
    // Nếu vừa xác nhận đơn, gửi alert
    if (storage.getSessionState(senderId) === rules.STATES.CONFIRMED) {
      const alertData = { ...leadDetails, shopName: shopConfig.name };
      // pushLeadToSheet, sendTelegramAlert... (giản lược để an toàn)
    }
  } else if (shopConfig.features?.enableAI) {
    const systemPrompt = buildSystemPrompt(config, products);
    const history = storage.getHistory(senderId).map(h => ({ role: h.role === 'bot' ? 'model' : 'user', parts: [{ text: h.text }] }));
    history.push({ role: 'user', parts: [{ text: userText }] });
    
    const apiKey = shopConfig.credentials?.geminiApiKey || process.env.GEMINI_API_KEY;
    const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: history
    });
    const aiReply = res.data.candidates[0].content.parts[0].text;
    await sendMessage(senderId, aiReply, shopConfig);
  } else {
    await sendMessage(senderId, rules.buildFallbackReply(userText, senderId), shopConfig);
  }
}

// ========== FB API ==========

async function sendMessage(recipientId, text, shopConfig) {
  const token = shopConfig.credentials?.fbPageToken;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      recipient: { id: recipientId },
      message: { text }
    });
    storage.appendHistory(recipientId, { role: 'bot', text });
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
