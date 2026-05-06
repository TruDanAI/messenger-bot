require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const storage = require('./storage');
const { pushLeadToSheet } = require('./sheets-webhook');
const { loadProducts } = require('./products');
const { createRuleEngine } = require('./rules');
const { trackIntent, logUnknown } = require('./analytics');
const nlp = require('./nlp');

const ROOT_DIR = path.join(__dirname, '..');
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
    if (Array.isArray(value)) merged[key] = [...value];
    else if (isPlainObject(value) && isPlainObject(base[key])) merged[key] = deepMergeConfig(base[key], value);
    else merged[key] = value;
  }
  return merged;
}

function buildDbRuntimeConfig(shopDoc) {
  if (!shopDoc) return {};
  const doc = typeof shopDoc.toObject === 'function' ? shopDoc.toObject() : shopDoc;
  return {
    shopName: doc.name,
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

async function loadShopRuntime(shopId, shopDoc = null) {
  const safeShopId = normalizeShopId(shopId);
  const shopDir = path.join(SHOPS_DIR, safeShopId);
  if (!fs.existsSync(SHOPS_DIR)) fs.mkdirSync(SHOPS_DIR, { recursive: true });
  if (!fs.existsSync(shopDir)) fs.mkdirSync(shopDir, { recursive: true });
  
  const configPath = path.join(shopDir, 'config.js');
  const csvPath = path.join(shopDir, 'products.csv');
  
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `module.exports = { shopName: "${safeShopId}", intents: { prepend: [], append: [] } };`, 'utf8');
  }
  if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, 'code,price,description,size,preorder,image\n', 'utf8');
  }

  if (require.cache[require.resolve(configPath)]) delete require.cache[require.resolve(configPath)];
  const shopConfig = require(configPath);
  
  // SỬ DỤNG MONGODB PRODUCTS
  const { getProductsForShop } = require('./products');
  const products = await getProductsForShop(safeShopId, csvPath);

  const dbConfig = buildDbRuntimeConfig(shopDoc);
  const mergedConfig = deepMergeConfig(shopConfig, dbConfig);

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
async function getShopRuntime(shopId, shopDoc = null) {
  const id = normalizeShopId(shopId);
  if (!RUNTIME_CACHE.has(id)) {
    const rt = await loadShopRuntime(id, shopDoc);
    RUNTIME_CACHE.set(id, rt);
  }
  return RUNTIME_CACHE.get(id);
}

// ========== UTILS & AI CORE ==========

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const HANDOFF_MS = 30 * 60 * 1000;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 12000;

async function callGemini(apiKey, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  return axios.post(url, payload, { timeout: AI_TIMEOUT_MS });
}

function getPublicImageUrl(shopId, filename, baseUrlOverride = '') {
  const baseRaw = baseUrlOverride || PUBLIC_BASE_URL;
  if (!baseRaw || !filename) return null;
  const base = baseRaw.replace(/\/+$/, '');
  if (filename.startsWith('http') || filename.startsWith('/static') || filename.startsWith('/media')) {
    return filename.startsWith('/') ? `${base}${filename}` : filename;
  }
  return `${base}/media/${shopId}/${encodeURIComponent(filename)}`;
}

// ========== SALES OPTIMIZER LOGIC ==========

const CTA_POOL = [
  'mình lấy mẫu này để em giữ hàng cho mình nhé?',
  'em giữ hàng/size giúp mình nhé ạ?',
  'mình chốt luôn mẫu này để em lên đơn giao sớm cho mình nhé?',
  'anh/chị muốn em lên đơn luôn cho mình không ạ?'
];

function pickCTA(userId) {
  // Simple pseudo-random based on userId length to vary a bit
  const idx = userId.length % CTA_POOL.length;
  return CTA_POOL[idx];
}

function validateOutput(text, data) {
  if (!text) return false;
  // Đảm bảo có giá và có CTA (hoặc ít nhất là đúng format ngắn gọn)
  const hasPrice = data.product ? text.includes(data.product.price.split('.')[0]) : true;
  return hasPrice && text.length < 300;
}

async function formatWithAI({ shopName, intent, data, userId, apiKey, history, products, shopId }) {
  // 1. Check Quota trước khi gọi AI
  const Shop = require('./models/Shop');
  const shop = await Shop.findById(shopId);
  if (shop && shop.aiUsage >= shop.aiQuota && shop.aiQuota > 0) {
    console.log(`⚠️ Shop ${shopId} hết Quota AI.`);
    return null; // Trả về null để fallback sang deterministic
  }

  const cta = pickCTA(userId);
  const productInfo = data.product ? `Sản phẩm: ${data.product.code}, Giá: ${data.product.price}, Mô tả: ${data.product.description}` : 'Sản phẩm trong menu shop';
  
  const prompt = `
Bạn là nhân viên bán hàng chuyên nghiệp của ${shopName}.
Nhiệm vụ: Trả lời NGẮN GỌN (1-2 câu), tự nhiên, giống người thật. Luôn hướng khách mua hàng.

Dữ liệu:
- Intent: ${intent}
- Chi tiết: ${productInfo}
- Tình trạng: ${data.stock || 'Sẵn hàng'}

Quy tắc:
- Không nói dài dòng.
- Không bịa thông tin.
- Luôn kết thúc bằng câu hỏi nhẹ để dẫn dắt mua hàng.
- Trả lời bằng tiếng Việt, thân thiện (dùng "dạ", "ạ").
- Câu chốt (CTA): "${cta}"

Trả lời:`.trim();

  try {
    const startTime = Date.now();
    const res = await callGemini(apiKey, {
      system_instruction: { parts: [{ text: prompt }] },
      contents: history.slice(-4) // Chỉ lấy 4 câu gần nhất để AI có ngữ cảnh
    });
    const latency = Date.now() - startTime;
    let text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    // Guardrail: Nếu AI quên CTA hoặc quá dài, dùng fallback deterministic
    if (!validateOutput(text, data)) throw new Error('AI output invalid');

    // 2. Atomic Update Usage (Chống Race Condition)
    const Shop = require('./models/Shop');
    const updateResult = await Shop.updateOne(
      { _id: shopId, $or: [{ aiQuota: 0 }, { $expr: { $lt: ["$aiUsage", "$aiQuota"] } }] },
      { $inc: { aiUsage: 1 } }
    );

    if (updateResult.modifiedCount === 0 && shop.aiQuota > 0) {
       throw new Error('Quota exceeded during processing');
    }

    // 3. Log AI Response kèm Latency
    const MessageLog = require('./models/MessageLog');
    await MessageLog.create({ shopId, userId, role: 'model', text, intent, latency });

    return text;
  } catch (err) {
    console.error('⚠️ AI Formatter Fail:', err.message);
    return `Dạ ${data.product?.code || 'mẫu này'} hiện giá ${data.product?.price || 'ưu đãi'}, shop đang sẵn hàng ạ. ${cta}`;
  }
}

// ========== MESSAGE HANDLING CORE ==========

async function handleMessage(shopConfig, messageData) {
  const { event, baseUrlOverride, correlationId } = messageData;
  const senderId = event.sender?.id;
  const shopId = shopConfig._id;
  const stateUserId = `${shopId}:${senderId}`;
  
  const runtime = await getShopRuntime(shopId, shopConfig);
  const { rules, products, config } = runtime;

  if (event.message?.is_echo) return;
  const mid = event.message?.mid;
  if (mid && storage.seenMid(mid)) return;
  if (mid) storage.markMid(mid);

  if (storage.inHandoff(stateUserId)) return;

  const userText = event.message?.text || event.postback?.payload;
  if (!userText) return;

  console.log(`📩 [${shopId}][${senderId}]: ${userText}`);

  // 0. Log Raw Message
  const MessageLog = require('./models/MessageLog');
  await MessageLog.create({ shopId, userId: senderId, role: 'user', text: userText, intent: 'PENDING' });

  // 1. Intent Detection (Hybrid)
  const apiKey = shopConfig.credentials?.geminiApiKey || process.env.GEMINI_API_KEY;
  const intent = await nlp.detectIntent(userText, stateUserId, apiKey, storage);
  
  // 2. Tracking & Analytics
  
  // Kiểm tra xem khách có vừa nhận được Broadcast không để tính ROI
  const FunnelEvent = require('./models/FunnelEvent');
  const lastBroadcast = await FunnelEvent.findOne({ 
    userId: senderId, 
    shopId, 
    intent: 'BROADCAST_SENT',
    timestamp: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Trong vòng 24h
  }).sort({ timestamp: -1 });

  const finalIntent = (lastBroadcast && intent !== 'UNKNOWN') ? 'REPLY_AFTER_BROADCAST' : intent;

  // Trích xuất doanh thu tiềm năng nếu là BUY_INTENT
  let revenue = 0;
  if (finalIntent === 'BUY_INTENT') {
    const lastCode = storage.getLastProductCode(stateUserId);
    const p = products.find(i => String(i.code).toUpperCase() === String(lastCode).toUpperCase());
    if (p && p.price) {
      revenue = parseInt(String(p.price).replace(/[^\d]/g, '')) || 0;
    }
  }

  await FunnelEvent.create({ 
    shopId, 
    userId: senderId, 
    intent: finalIntent, 
    value: revenue,
    source: lastBroadcast ? 'broadcast' : 'bot' 
  });

  if (intent === 'UNKNOWN') logUnknown(shopId, senderId, userText);

  // Cập nhật intent vào log gần nhất
  await MessageLog.updateOne({ shopId, userId: senderId, role: 'user' }, { $set: { intent: finalIntent } }, { sort: { createdAt: -1 } });

  // Cập nhật Lead tracking cho Auto Follow-up
  const Lead = require('./models/Lead');
  const updateData = { lastInteractionAt: new Date(), followUpCount: 0 }; // Reset follow-up khi có tương tác mới
  if (intent === 'ASK_PRICE') updateData.lastAskPriceAt = new Date();
  if (intent === 'BUY_INTENT') updateData.lastBuyIntentAt = new Date();
  
  await Lead.updateOne(
    { shopId, senderId: senderId },
    { $set: updateData },
    { upsert: true }
  );

  // 3. Human Handoff Check
  if (rules.wantsHuman(userText)) {
    storage.setHandoff(stateUserId, Date.now() + HANDOFF_MS);
    await sendMessage(senderId, rules.render('humanHandoff'), shopConfig, stateUserId);
    return;
  }

  // 4. Handle Images (Menu, Product)
  const imageFiles = [];
  if (intent === 'ASK_PRODUCT' || rules.wantsMenuImages(userText)) {
    const menus = (shopConfig.menu_images?.length) ? shopConfig.menu_images : ['menu1.png', 'menu2.png'];
    imageFiles.push(...menus);
  }
  const requestedCodes = rules.extractRequestedProductCodes(userText);
  if (requestedCodes.length || intent === 'ASK_PRICE' || intent === 'ASK_STOCK') {
    const code = requestedCodes[0] || storage.getLastProductCode(stateUserId);
    if (code) {
      const p = products.find(i => String(i.code).toUpperCase() === String(code).toUpperCase());
      if (p?.image) imageFiles.push(p.image);
      if (p) storage.setLastProductCode(stateUserId, p.code);
    }
  }

  for (const file of [...new Set(imageFiles)]) {
    const url = getPublicImageUrl(shopId, file, baseUrlOverride);
    if (url) await sendImage(senderId, url, shopConfig);
  }

  // 5. Response Strategy
  
  // A. BUY_INTENT hoặc Information Providing (Name/Phone/Address) -> Deterministic (No AI)
  const isProvidingInfo = nlp.providesName(userText) || nlp.providesAddress(userText) || nlp.looksLikePhone(userText);
  
  if (intent === 'BUY_INTENT' || isProvidingInfo) {
    const deterministic = rules.buildDeterministicReply(userText, stateUserId);
    if (deterministic) {
      await sendMessage(senderId, deterministic, shopConfig, stateUserId);
      return;
    }
  }

  // B. Information Requests (Price, Stock, Shipping) -> AI Formatter
  if (['ASK_PRICE', 'ASK_STOCK', 'ASK_SHIPPING', 'ASK_PRODUCT'].includes(intent) && shopConfig.features?.enableAI) {
    const lastCode = storage.getLastProductCode(stateUserId);
    const product = products.find(p => p.code === lastCode);
    const history = storage.getHistory(stateUserId);
    
    const aiReply = await formatWithAI({
      shopName: shopConfig.name,
      intent,
      data: { product, stock: product?.preorder ? 'Hàng đặt' : 'Sẵn hàng' },
      userId: senderId,
      apiKey,
      history,
      products,
      shopId
    });
    
    await sendMessage(senderId, aiReply, shopConfig, stateUserId);
    return;
  }

  // C. Fallback (Rule-based first, then full AI)
  const deterministic = rules.buildDeterministicReply(userText, stateUserId);
  if (deterministic) {
    await sendMessage(senderId, deterministic, shopConfig, stateUserId);
  } else if (shopConfig.features?.enableAI) {
    // Full AI Fallback for complex questions
    const systemPrompt = `Bạn là nhân viên tư vấn của ${shopConfig.name}. Hãy trả lời ngắn gọn, tự nhiên và luôn hướng khách mua hàng.`;
    const history = storage.getHistory(stateUserId).map(h => ({ role: h.role === 'bot' ? 'model' : 'user', parts: [{ text: h.text }] }));
    history.push({ role: 'user', parts: [{ text: userText }] });
    
    try {
      const res = await callGemini(apiKey, {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: history.slice(-10)
      });
      const aiReply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      await sendMessage(senderId, aiReply || 'Dạ shop nghe ạ, mình cần em hỗ trợ gì thêm không ạ?', shopConfig, stateUserId);
    } catch (err) {
      await sendMessage(senderId, rules.buildFallbackReply(userText, stateUserId), shopConfig, stateUserId);
    }
  } else {
    await sendMessage(senderId, rules.buildFallbackReply(userText, stateUserId), shopConfig, stateUserId);
  }
}

// ========== FB API ==========

async function sendMessage(recipientId, text, shopConfig, stateUserId = recipientId) {
  const token = shopConfig.credentials?.fbPageToken;
  if (!token) return;
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
  if (!token) return;
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
