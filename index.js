require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const products = require('./products.json');
const storage = require('./storage');

// ========== ENV ==========
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_PAGE_TOKEN   = process.env.FB_PAGE_TOKEN;
const FB_APP_SECRET   = process.env.FB_APP_SECRET;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const GEMINI_MODEL    = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PORT            = process.env.PORT || 3000;
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
  process.env.RENDER_EXTERNAL_URL ||
  '';

const required = { FB_VERIFY_TOKEN, FB_PAGE_TOKEN, GEMINI_API_KEY };
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
      index.set(file.toLowerCase(), path.join(dir, file));
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
  const lines = products.map(p => {
    const parts = [
      p.code,
      p.price,
      p.description,
      p.size,
      p.weight,
      p.gift ? `Tặng ${p.gift}` : '',
      p.preorder ? 'HÀNG ĐẶT 15-20 ngày' : ''
    ].filter(Boolean);
    return `- ${parts.join(' | ')}`;
  }).join('\n');

  return `Bạn là nhân viên tư vấn bán hàng thân thiện, nhiệt tình của Shop đồ chơi người lớn dành cho nam giới (18+). Hãy tư vấn tự nhiên, gần gũi như người thật, dùng ngôn ngữ thoải mái, không quá formal.

DANH SÁCH SẢN PHẨM:
${lines}

CHÍNH SÁCH:
- Miễn ship tất cả sản phẩm
- Gói kín, không ghi nội dung bên ngoài (bảo mật tuyệt đối)
- Hàng đặt cần đặt cọc, giao 15-20 ngày
- Thanh toán: COD hoặc chuyển khoản

QUY TẮC BẮT BUỘC:
- TUYỆT ĐỐI không bịa sản phẩm hoặc giá ngoài danh sách trên
- Nếu khách hỏi sản phẩm không có, nói thẳng "shop chưa có" rồi gợi ý mẫu gần nhất
- Trả lời ngắn gọn, tự nhiên. KHÔNG liệt kê dài dòng trừ khi khách hỏi hết danh sách
- Dùng emoji vừa phải cho thân thiện
- Ngôn ngữ kín đáo, không phản cảm
- Chỉ tư vấn cho khách đủ 18 tuổi
- Hệ thống tự động gửi ảnh khi khách hỏi "menu", "danh sách", "ảnh", "hình", hoặc nhắc tên mã sản phẩm cụ thể (vd MÃ8, ma8) hoặc nói về "gel/bôi trơn". KHÔNG được nói "em là AI không gửi ảnh được" hay xin lỗi vì không có ảnh — cứ tư vấn bằng chữ bình thường, ảnh sẽ được gửi tự động kèm tin nhắn của em

CÁCH TƯ VẤN:
- Nếu khách chưa rõ nhu cầu: hỏi ngân sách, thích nhỏ gọn hay to, có pin/rung không
- Gợi ý 1-2 sản phẩm phù hợp ngân sách, không spam cả danh sách
- Khi khách muốn chốt đơn: hỏi tên + địa chỉ + số điện thoại
- Khi đã đủ thông tin: xác nhận lại sản phẩm + giá + tên + sđt + địa chỉ trước khi kết thúc
- Nếu khách muốn gặp nhân viên thật: trả lời "Em chuyển anh/chị qua nhân viên tư vấn nhé" và dừng tư vấn`;
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

async function callGemini(userId, userMessage) {
  const history = storage.getHistory(userId);
  history.push({ role: 'user', parts: [{ text: userMessage }] });

  // Giữ tối đa 20 tin nhắn để tiết kiệm token
  if (history.length > 20) history.splice(0, history.length - 20);

  const res = await postGeminiWithRetry(history);

  const botReply = res.data.candidates?.[0]?.content?.parts?.[0]?.text
    || 'Xin lỗi anh/chị, em chưa hiểu ý. Anh/chị có thể nói rõ hơn không ạ? 😊';

  history.push({ role: 'model', parts: [{ text: botReply }] });
  storage.setHistory(userId, history);

  return botReply;
}

// ========== HÀM GỬI TIN NHẮN FB ==========
async function sendMessage(recipientId, text) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, 1900));
    text = text.slice(1900);
  }

  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`,
      { recipient: { id: recipientId }, message: { text: chunk } },
      { timeout: 10000 }
    );
  }
}

async function sendImage(recipientId, imageUrl) {
  if (!imageUrl) return;
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`,
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'image',
          payload: { url: imageUrl, is_reusable: true }
        }
      }
    },
    { timeout: 10000 }
  );
}

function showTyping(recipientId) {
  // Fire-and-forget: lỗi typing không chặn flow trả lời chính
  return axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_TOKEN}`,
    { recipient: { id: recipientId }, sender_action: 'typing_on' },
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

function wantsHuman(text) {
  return /(nhân\s*viên|admin|người\s*thật|tư\s*vấn\s*viên|gặp\s*ng\s*thật)/i.test(text);
}

function looksLikePhone(text) {
  return /(?:\+?84|0)\d{8,10}/.test(text);
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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

function wantsMenuImages(text) {
  const t = normalizeText(text);
  return /(xem|gui|cho|coi|tham\s*khao).*(menu|bang gia|danh muc|danh sach|hinh|anh|catalog|san pham|cac san pham|mau|hang)/.test(t)
    || /\bmenu\b/.test(t)
    || /\bcatalog\b/.test(t)
    || /\bdanh\s*sach\s*san\s*pham\b/.test(t)
    || /\bcac\s*san\s*pham\b/.test(t);
}

function wantsGelImage(text) {
  const t = normalizeText(text);
  return /\bgel\b/.test(t)
    || /\bboi\s*tron\b/.test(t)
    || /\blub(ricant)?\b/.test(t);
}

function extractRequestedMaCodes(text) {
  const t = normalizeText(text);
  const codes = new Set();
  const re = /\bma\s*0*(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(t))) {
    codes.add(`MÃ${Number(m[1])}`);
  }
  return [...codes];
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

  if (/gel/i.test(code)) {
    const gelNames = ['goi gel boi tron', 'goi-gel-boi-tron', 'gel boi tron', 'gel-boi-tron'];
    for (const name of gelNames) {
      const f = getImageFilename(name);
      if (f) return f;
    }
  }
  return null;
}

// ========== ANTI-SPAM ẢNH ==========
const IMAGE_COOLDOWN_MS = 5 * 60 * 1000; // 5 phút mỗi loại ảnh / mỗi user
const recentlySentImages = new Map(); // key = `${userId}:${filename}` -> timestamp

function shouldSendImage(userId, filename) {
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

  if (wantsGelImage(userText)) {
    const gel = getImageFilename('gel');
    if (gel) { files.push(gel); reasons.push('gel'); }
  }

  const maCodes = extractRequestedMaCodes(userText);
  if (maCodes.length) {
    const byCode = new Map(products.map(p => [String(p.code || '').toUpperCase(), p]));
    for (const code of maCodes) {
      const p = byCode.get(code.toUpperCase());
      if (!p) continue;
      const file = getImageFilenameForProduct(p);
      if (file) { files.push(file); reasons.push(code); }
    }
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

function buildFallbackReply(userText) {
  const t = normalizeText(userText);
  const requestedCodes = extractRequestedMaCodes(userText);
  const byCode = new Map(products.map(p => [String(p.code || '').toUpperCase(), p]));

  const wantsVibration = /\brung\b|co\s*pin|sac\s*pin/.test(t);
  const wantsLarge = /\bto\b|\blon\b|kich\s*thuoc\s*lon|size\s*lon/.test(t);
  const budgetMatch = t.match(/(?:ngan\s*sach\s*)?(\d{2,4})\s*k\b/);
  const budget = budgetMatch ? Number(budgetMatch[1]) : null;

  if (budget && budget <= 200 && (wantsVibration || wantsLarge)) {
    return 'Dạ với ngân sách khoảng 200k thì shop chưa có mẫu vừa to vừa có rung ạ. Gần nhất là MÃ10 giá 150k, nhỏ gọn nhưng không rung. Nếu anh/chị muốn có rung thì nên lên MÃ2 giá 300k, nhỏ gọn và có pin/rung. Anh/chị muốn em gửi ảnh MÃ10 hay MÃ2 để so sánh không ạ?';
  }

  if (wantsVibration && !requestedCodes.length) {
    return 'Dạ nếu anh/chị ưu tiên có rung/có pin thì shop có MÃ2 giá 300k và MÃ8 giá 680k. MÃ2 nhỏ gọn tiết kiệm hơn, MÃ8 cao cấp hơn vì có sạc pin, làm ấm và nhiều chế độ rung. Anh/chị muốn xem ảnh mẫu nào ạ?';
  }

  if (requestedCodes.length) {
    const listed = requestedCodes
      .map(code => byCode.get(code.toUpperCase()))
      .filter(Boolean)
      .slice(0, 2)
      .map(p => `- ${p.code}: ${p.price} | ${p.description}`)
      .join('\n');
    if (listed) {
      return `Dạ hệ thống đang đông nên em trả lời chậm chút ạ 🙏\nAnh/chị xem nhanh thông tin:\n${listed}\nEm sẽ tư vấn kỹ hơn ngay khi hệ thống ổn định.`;
    }
  }

  if (wantsGelImage(userText)) {
    return 'Dạ shop có Gel bôi trơn 150k/chai 200ml, em đã gửi ảnh kèm rồi ạ. Anh/chị muốn em giữ 1 chai để chốt đơn luôn không ạ?';
  }

  if (wantsMenuImages(userText)) {
    return 'Dạ em đã gửi menu ảnh rồi ạ. Anh/chị xem mẫu nào ưng thì nhắn mã (ví dụ: MÃ8) để em tư vấn nhanh giá và ưu nhược điểm nhé.';
  }

  return 'Dạ hệ thống đang đông nên em phản hồi chậm chút ạ 🙏 Anh/chị nhắn lại nhu cầu (mã sản phẩm hoặc ngân sách), em sẽ tư vấn ngay.';
}

function formatProductLine(product) {
  const details = [
    product.description,
    product.size ? `size ${product.size}` : '',
    product.gift ? `tặng ${product.gift}` : '',
    product.preorder ? 'hàng đặt 15-20 ngày' : ''
  ].filter(Boolean).join(', ');

  return `${product.code}: ${product.price}${details ? ` - ${details}` : ''}`;
}

function buildDeterministicReply(userText) {
  const t = normalizeText(userText);
  const requestedCodes = extractRequestedMaCodes(userText);
  const byCode = new Map(products.map(p => [String(p.code || '').toUpperCase(), p]));

  const wantsVibration = /\brung\b|co\s*pin|sac\s*pin/.test(t);
  const wantsLarge = /\bto\b|\blon\b|kich\s*thuoc\s*lon|size\s*lon/.test(t);
  const wantsPhoto = /\banh\b|\bhinh\b|\bxem\b|\bcoi\b|\bgui\b|\bmenu\b|\bdanh\s*sach\b/.test(t);
  const budgetMatch = t.match(/(?:ngan\s*sach\s*)?(\d{2,4})\s*k\b/);
  const budget = budgetMatch ? Number(budgetMatch[1]) : null;

  if (budget && budget <= 200 && (wantsVibration || wantsLarge)) {
    return 'Dạ với ngân sách khoảng 200k thì shop chưa có mẫu vừa to vừa có rung ạ. Gần nhất là MÃ10 giá 150k, nhỏ gọn nhưng không rung. Nếu anh/chị muốn có rung thì nên lên MÃ2 giá 300k, nhỏ gọn và có pin/rung. Anh/chị muốn em gửi ảnh MÃ10 hay MÃ2 để so sánh không ạ?';
  }

  if (requestedCodes.length) {
    const found = requestedCodes
      .map(code => byCode.get(code.toUpperCase()))
      .filter(Boolean);

    if (found.length) {
      const lines = found.slice(0, 3).map(formatProductLine).join('\n');
      return `Dạ em gửi thông tin nhanh cho anh/chị nhé:\n${lines}\n${wantsPhoto ? 'Em cũng gửi ảnh mẫu kèm theo rồi ạ.' : 'Anh/chị muốn xem ảnh hoặc chốt mẫu nào thì nhắn em mã đó nhé.'}`;
    }
  }

  if (wantsGelImage(userText)) {
    return 'Dạ shop có Gel bôi trơn 150k/chai 200ml, mua gel được tặng thêm 5 gói gel nhỏ ạ. Em gửi ảnh kèm theo rồi nhé.';
  }

  if (wantsMenuImages(userText)) {
    return 'Dạ em gửi menu ảnh sản phẩm cho anh/chị rồi ạ. Anh/chị xem mẫu nào ưng thì nhắn mã (ví dụ MÃ8 hoặc ma8), em báo giá và tư vấn nhanh hơn nhé.';
  }

  if (wantsVibration) {
    return 'Dạ nếu anh/chị ưu tiên có rung/có pin thì shop có MÃ2 giá 300k và MÃ8 giá 680k. MÃ2 tiết kiệm hơn, MÃ8 cao cấp hơn vì có sạc pin, làm ấm và nhiều chế độ rung. Anh/chị muốn xem ảnh mẫu nào ạ?';
  }

  return null;
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

  // Echo: tin do page gửi đi → nhân viên đang trả lời tay → tạm dừng bot
  if (event.message?.is_echo) {
    storage.setHandoff(senderId, Date.now() + HANDOFF_MS);
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
    storage.appendOrder({
      type: 'handoff_request',
      senderId,
      text: userText,
      at: new Date().toISOString()
    });
    try {
      await sendMessage(senderId, 'Dạ em chuyển anh/chị qua nhân viên tư vấn hỗ trợ kỹ hơn nhé. Anh/chị chờ một chút ạ 🙏');
    } catch {}
    return;
  }

  // Nhận diện sđt → ghi lead vào orders.jsonl để nhân viên xem lại
  if (looksLikePhone(userText)) {
    storage.appendOrder({
      type: 'lead',
      senderId,
      text: userText,
      history: storage.getHistory(senderId).slice(-10),
      at: new Date().toISOString()
    });
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

    let reply = buildDeterministicReply(userText);
    if (reply) {
      console.log('⚡ Trả lời rule-based, không gọi Gemini');
    } else {
      reply = await callGemini(senderId, userText);
    }
    if (isProbablyIncompleteReply(reply, userText)) {
      console.warn(`⚠️  Gemini trả lời có vẻ bị cụt, dùng fallback. Reply gốc: ${reply.replace(/\n/g, ' ')}`);
      reply = buildFallbackReply(userText);
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
        const fallback = buildFallbackReply(userText);
        await sendMessage(senderId, fallback);
        console.log(`🛟 Fallback do Gemini lỗi (${geminiInfo.status || geminiInfo.code || geminiInfo.httpStatus}): ${fallback.slice(0, 120).replace(/\n/g, ' ')}`);
      } catch {}
      return;
    }
    try {
      await sendMessage(senderId, 'Xin lỗi anh/chị, hệ thống đang bận. Vui lòng thử lại sau nhé! 🙏');
    } catch {}
  }
}

// ========== HEALTH CHECK ==========
app.get('/', (_req, res) => res.send('🤖 Shop Bot đang chạy!'));
app.get('/healthz', (_req, res) => res.json({
  ok: true,
  products: products.length,
  uptime: Math.round(process.uptime())
}));

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

const server = app.listen(PORT, async () => {
  console.log(`🚀 Bot đang chạy tại port ${PORT} (sản phẩm: ${products.length}, model: ${GEMINI_MODEL})`);
  await checkPageToken();
});

function shutdown(signal) {
  console.log(`🛑 Nhận ${signal}, đang dừng server...`);
  server.close(() => {
    console.log('✅ Server đã dừng gọn.');
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
