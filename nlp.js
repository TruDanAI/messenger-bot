// Lớp tiền xử lý NLP nhẹ — gom toàn bộ logic chuẩn hóa văn bản, slang, fuzzy match,
// và regex địa chỉ Việt Nam vào đây để rules.js chỉ tập trung vào "intent → reply".

// ===== Normalize cơ bản =====
function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

// ===== Dictionary teencode / từ lóng =====
// Mỗi entry: [regex, replacement]. Regex chạy trên text ĐÃ normalize (đã bỏ dấu, lowercase).
// Lưu ý: chỉ giữ những thay thế an toàn, không mơ hồ. Ví dụ "k" có thể là "không" hoặc
// đơn vị "nghìn" — chỉ thay khi có ngữ cảnh rõ (đứng trước động từ phổ biến).
const SLANG_RULES = [
  // Địa chỉ
  [/\b(?:dc|d\/c|dchi|diachi)\b/g, 'dia chi'],
  [/\bdia\s+chi\b/g, 'dia chi'],
  // Số điện thoại
  [/\b(?:sdt|sodt|so\s*dt|sodienthoai)\b/g, 'so dien thoai'],
  // Phủ định
  [/\b(?:ko|kho|khong)\b/g, 'khong'],
  [/\bk\b(?=\s+(?:lay|chot|mua|hieu|biet|can|muon|nho|to|co|the|sao|nen|nhan|ship|ok|phai|duoc|nhe))/g, 'khong'],
  // Đơn vị tiền (giữ nguyên cấu trúc số): "300 cành" -> "300 nghin"
  [/(\d)\s*canh\b/g, '$1 nghin'],
  // Khẩu ngữ phổ biến
  [/\bcmt\b/g, 'binh luan']
];

function expandSlang(normalizedText) {
  let text = normalizedText;
  for (const [pattern, replacement] of SLANG_RULES) {
    text = text.replace(pattern, replacement);
  }
  // Gộp khoảng trắng dư.
  return text.replace(/\s+/g, ' ').trim();
}

// Pipeline gọi 1 lần ở mỗi handler: normalize + expand slang.
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

// ===== Levenshtein distance (vanilla, đủ nhanh cho tin nhắn ngắn) =====
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
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

// ===== Trích mã sản phẩm =====
// Pass 1: regex các mẫu hay gặp (ma 8, mau 8, max 8, m8, sp8, san pham 8...).
// Pass 2 (fuzzy): tách token có chứa số, so sánh Levenshtein với danh sách mã đã biết.
//   - Ngưỡng: ≤ 4 ký tự cho phép sai 1, > 4 cho phép sai 2.
function extractRequestedProductCodes(text, knownCodes = []) {
  const t = preprocess(text);
  const codes = new Set();

  // Pass 1: regex tường minh.
  const re = /\b(?:ma|mau|max|sp|san\s*pham|m)\s*0*(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    codes.add(`MÃ${Number(m[1])}`);
  }

  // Pass 2: fuzzy với danh sách mã có sẵn (chỉ chạy khi cần thiết).
  if (knownCodes.length) {
    const tokens = t
      .split(/\s+/)
      .map(tok => tok.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(tok => tok && /\d/.test(tok) && tok.length <= 6);

    const normalizedKnown = knownCodes.map(code => ({
      code,
      normalized: normalizeText(code).replace(/\s+/g, '')
    }));

    for (const token of tokens) {
      // Bỏ qua token đã hit ở Pass 1 (số khớp chính xác).
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

// ===== Detect câu hỏi (để phân biệt "cung cấp" vs "hỏi") =====
const QUESTION_RE = /\?|\bo\s*dau\b|\bcho\s*nao\b|\bnao\s*vay\b|\bcua\s*shop\b|\bcua\s*ban\b|\bbao\s*nhieu\b|\bla\s*gi\b|\bcai\s*gi\b|\bnhu\s*the\s*nao\b|\btai\s*sao\b|\bvi\s*sao\b|\bsao\s*lai\b/;

function isQuestion(text) {
  const raw = String(text || '');
  if (raw.includes('?')) return true;
  const t = preprocess(raw);
  return QUESTION_RE.test(t);
}

// ===== Address detection (regex VN nâng cao) =====
// Chạy trên text đã normalize/preprocess.
const ADDRESS_KEYWORDS_RE = /\b(?:so\s*nha|ngo|ngach|hem|kiet|duong|thon|xom|ap|phuong|xa|quan|huyen|tinh|tp|thanh\s*pho|ho\s*chi\s*minh|ha\s*noi|sai\s*gon|bac\s*ninh|hai\s*phong|da\s*nang|can\s*tho|nha\s*trang|hue|vung\s*tau|bien\s*hoa|thu\s*duc)\b/;

const ADDRESS_HINT_RE = /\b(?:dia\s*chi|giao\s*ve|ship\s*ve|o\s+tai|noi\s*nhan|cho\s*nhan|nha\s+so)\b/;

// "Looks like" — bao gồm cả người hỏi địa chỉ ("địa chỉ shop ở đâu?")
function looksLikeAddress(text) {
  const t = preprocess(text);
  if (ADDRESS_HINT_RE.test(t)) return true;
  if (ADDRESS_KEYWORDS_RE.test(t)) return true;
  // Fallback: có dấu phẩy/gạch + tên khu hành chính tối thiểu (xã/phường).
  if (/[-,].+[-,]/.test(t) && /\b(?:xa|phuong|huyen|quan)\b/.test(t)) return true;
  return false;
}

// "Provides address" — true KHI người dùng đang CUNG CẤP địa chỉ (không phải hỏi).
// Khắc phục bug: "địa chỉ shop ở đâu?" trước đây trả về true.
function providesAddress(text) {
  if (!looksLikeAddress(text)) return false;
  if (isQuestion(text)) return false;

  const t = preprocess(text);
  // Loại các trường hợp "địa chỉ shop", "địa chỉ cửa hàng" — đây là user hỏi về shop.
  if (/\bdia\s*chi\s+(?:shop|cua\s*hang|ban|cong\s*ty)\b/.test(t)) return false;
  if (/\b(?:shop|cua\s*hang)\s+o\s+dau\b/.test(t)) return false;
  return true;
}

// ===== Helper provided/asked detectors =====
function providesName(text) {
  const t = preprocess(text);
  // Bỏ anchor `$` để match cả khi tên nằm giữa câu (vd: "em tên An, sđt 0987...").
  return /\b(?:minh|em|anh|chi|toi)\s*(?:ten|la)\s+[\p{L}\s]{2,40}/u.test(t)
    || /\bten\s*(?:nguoi\s*nhan)?\s*(?:la|:)\s*[\p{L}\s]{2,40}/u.test(t);
}

module.exports = {
  // Text utils
  normalizeText,
  expandSlang,
  preprocess,
  // Phone
  looksLikePhone,
  extractPhone,
  // Codes
  extractRequestedProductCodes,
  levenshtein,
  // Address
  looksLikeAddress,
  providesAddress,
  providesName,
  isQuestion,
  ADDRESS_KEYWORDS_RE,
  ADDRESS_HINT_RE
};
