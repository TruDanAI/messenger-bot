// core/nlp.js
// Lớp tiền xử lý NLP nhẹ — gom toàn bộ logic chuẩn hóa văn bản, slang, fuzzy match,
// và giờ là HYBRID INTENT DETECTION (Regex -> LLM fallback).

const axios = require('axios');

/** ====== CONFIG & CACHE ====== */
const INTENTS = [
  'ASK_PRICE',
  'ASK_STOCK',
  'ASK_PRODUCT',
  'ASK_SHIPPING',
  'BUY_INTENT',
  'FOLLOW_UP',
  'BROADCAST_SENT',
  'REPLY_AFTER_BROADCAST',
  'UNKNOWN'
];

const _intentCache = new Map(); 
const CACHE_TTL_MS = 60 * 1000; // 60s
const MAX_TEXT_LEN = 200;

// ===== Normalize cơ bản =====
function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim()
    .slice(0, MAX_TEXT_LEN);
}

// ===== Dictionary teencode / từ lóng =====
const SLANG_RULES = [
  [/\b(?:dc|d\/c|dchi|diachi)\b/g, 'dia chi'],
  [/\bdia\s+chi\b/g, 'dia chi'],
  [/\b(?:sdt|sodt|so\s*dt|sodienthoai)\b/g, 'so dien thoai'],
  [/\b(?:ko|kho|khong)\b/g, 'khong'],
  [/\bk\b(?=\s+(?:lay|chot|mua|hieu|biet|can|muon|nho|to|co|the|sao|nen|nhan|ship|ok|phai|duoc|nhe))/g, 'khong'],
  [/(\d)\s*canh\b/g, '$1 nghin'],
  [/\bcmt\b/g, 'binh luan']
];

function expandSlang(normalizedText) {
  let text = normalizedText;
  for (const [pattern, replacement] of SLANG_RULES) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function preprocess(text) {
  return expandSlang(normalizeText(text));
}

// ===== Phone =====
function looksLikePhone(text) {
  return /(?:\+?84|0)\d{8,10}/.test(text);
}

function extractPhone(text) {
  const match = String(text || '').match(/(?:\+?84|0)\d{8,10}/);
  return match ? match[0] : '';
}

// ===== Levenshtein distance =====
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) dp[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

// ===== Trích mã sản phẩm =====
function extractRequestedProductCodes(text, knownCodes = []) {
  const t = preprocess(text);
  const codes = new Set();
  const re = /\b(?:ma|mau|max|sp|san\s*pham|m)\s*0*(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    codes.add(`MÃ${Number(m[1])}`);
  }
  if (knownCodes.length) {
    const tokens = t.split(/\s+/).map(tok => tok.replace(/[^\p{L}\p{N}]/gu, '')).filter(tok => tok && /\d/.test(tok) && tok.length <= 6);
    const normalizedKnown = knownCodes.map(code => ({ code, normalized: normalizeText(code).replace(/\s+/g, '') }));
    for (const token of tokens) {
      const numMatch = token.match(/^\D*(\d{1,2})\D*$/);
      if (numMatch) {
        const exact = `MÃ${Number(numMatch[1])}`;
        if (codes.has(exact)) continue;
      }
      let best = { code: null, dist: Infinity };
      for (const { code, normalized } of normalizedKnown) {
        const dist = levenshtein(token, normalized);
        if (dist < best.dist) best = { code, dist };
      }
      if (!best.code) continue;
      const target = normalizedKnown.find(k => k.code === best.code).normalized;
      const threshold = target.length <= 4 ? 1 : 2;
      if (best.dist <= threshold) codes.add(best.code);
    }
  }
  return [...codes];
}

// ===== Detect câu hỏi =====
const QUESTION_RE = /\?|\bo\s*dau\b|\bcho\s*nao\b|\bnao\s*vay\b|\bcua\s*shop\b|\bcua\s*ban\b|\bbao\s*nhieu\b|\bla\s*gi\b|\bcai\s*gi\b|\bnhu\s*the\s*nao\b|\btai\s*sao\b|\bvi\s*sao\b|\bsao\s*lai\b/;
function isQuestion(text) {
  if (String(text || '').includes('?')) return true;
  return QUESTION_RE.test(preprocess(text));
}

// ===== Address detection =====
function providesAddress(text) {
  const t = preprocess(text);
  const ADDRESS_KEYWORDS_RE = /\b(?:so\s*nha|ngo|ngach|hem|kiet|duong|thon|xom|ap|phuong|xa|quan|huyen|tinh|tp|thanh\s*pho|ho\s*chi\s*minh|ha\s*noi|sai\s*gon|bac\s*ninh|hai\s*phong|da\s*nang|can\s*tho|nha\s*trang|hue|vung\s*tau|bien\s*hoa|thu\s*duc)\b/;
  const ADDRESS_HINT_RE = /\b(?:dia\s*chi|giao\s*ve|ship\s*ve|o\s+tai|noi\s*nhan|cho\s*nhan|nha\s+so)\b/;
  if (isQuestion(text)) return false;
  if (/\bdia\s*chi\s+(?:shop|cua\s*hang|ban|cong\s*ty)\b/.test(t)) return false;
  if (/\b(?:shop|cua\s*hang)\s+o\s+dau\b/.test(t)) return false;
  return ADDRESS_HINT_RE.test(t) || ADDRESS_KEYWORDS_RE.test(t) || (/[-,].+[-,]/.test(t) && /\b(?:xa|phuong|huyen|quan)\b/.test(t));
}

function providesName(text) {
  const t = preprocess(text);
  return /\b(?:minh|em|anh|chi|toi)\s*(?:ten|la)\s+[\p{L}\s]{2,40}/u.test(t) || /\bten\s*(?:nguoi\s*nhan)?\s*(?:la|:)\s*[\p{L}\s]{2,40}/u.test(t);
}

/** ====== HYBRID INTENT DETECTION ====== */

function detectIntentRule(t) {
  if (/(gia|bao nhieu|bn|bao nhieu tien|nhieu tien|lua|bao nhiu|may tien|gia sao)/.test(t)) return { intent: 'ASK_PRICE', confidence: 0.9 };
  if (/(con khong|het hang|size|con size|con k|con ko|het hang)/.test(t)) return { intent: 'ASK_STOCK', confidence: 0.85 };
  if (/(ship|giao hang|bao lau|may ngay|ship bao lau|phi ship|mien ship)/.test(t)) return { intent: 'ASK_SHIPPING', confidence: 0.85 };
  if (/(mua|lay|chot|dat|order|ok lay|chot luon|mua hang|dat hang)/.test(t)) return { intent: 'BUY_INTENT', confidence: 0.95 };
  if (/(co gi|ban gi|mau nao|san pham|catalog|danh muc)/.test(t)) return { intent: 'ASK_PRODUCT', confidence: 0.7 };
  return { intent: 'UNKNOWN', confidence: 0.3 };
}

async function classifyWithGemini(rawText, apiKey) {
  const prompt = `Phân loại ý định khách hàng vào 1 trong các nhãn sau:
- ASK_PRICE: Hỏi giá tiền
- ASK_STOCK: Hỏi còn hàng không, size gì
- ASK_PRODUCT: Xem thêm mẫu, catalog
- ASK_SHIPPING: Hỏi phí ship, thời gian giao
- BUY_INTENT: Chốt đơn, mua hàng, lấy hàng
- FOLLOW_UP: Phản hồi sau khi được nhắc
- UNKNOWN: Các câu hỏi khác

Chỉ trả về ĐÚNG 1 NHÃN duy nhất, không giải thích gì thêm.
Câu khách nhắn: "${rawText}"`;

  for (let i = 0; i < 2; i++) {
    try {
      const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 4000 });
      const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase();
      if (INTENTS.includes(raw)) return { intent: raw, confidence: 0.8 };
    } catch (err) { if (i === 1) break; }
  }
  return { intent: 'UNKNOWN', confidence: 0.1 };
}

async function detectIntent(text, userId, apiKey, storage) {
  const normalized = preprocess(text);
  
  // Cache check
  const cached = _intentCache.get(normalized);
  if (cached && Date.now() < cached.expiry) return cached.intent;

  // Rule-based (Dùng text đã xóa dấu để regex chính xác hơn)
  const rule = detectIntentRule(normalized);
  let finalIntent = rule.intent;

  if (rule.confidence < 0.85) {
    // LLM fallback (DÙNG TEXT GỐC CÓ DẤU để AI khôn hơn)
    const llm = await classifyWithGemini(text, apiKey);
    if (llm.confidence >= 0.6) finalIntent = llm.intent;
  }

  // Context enrich
  const lastProduct = storage?.getLastProductCode?.(userId);
  if (finalIntent === 'UNKNOWN' && /(size|còn không|còn k|còn ko|con ko)/.test(normalized) && lastProduct) {
    finalIntent = 'ASK_STOCK';
  }

  // Cache set
  _intentCache.set(normalized, { intent: finalIntent, expiry: Date.now() + CACHE_TTL_MS });

  return finalIntent;
}

module.exports = {
  normalizeText,
  expandSlang,
  preprocess,
  looksLikePhone,
  extractPhone,
  extractRequestedProductCodes,
  levenshtein,
  isQuestion,
  providesAddress,
  providesName,
  detectIntent,
  detectIntentRule
};
