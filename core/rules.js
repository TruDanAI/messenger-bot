// rules.js — Engine trả lời rule-based cho ZenBot SaaS.
//
// Kiến trúc:
//   1. Văn bản trả lời tách hoàn toàn sang `responses.js` (template hóa).
//   2. Tiền xử lý NLP (normalize/slang/fuzzy/address) tách sang `nlp.js`.
//   3. `buildDeterministicReply` duyệt qua mảng `intentRouters`
//      (Chain of Responsibility / Middleware).
//   4. State machine: IDLE -> PRODUCT_SELECTED -> COLLECTING_INFO ->
//      READY_TO_CONFIRM -> CONFIRMED.
//   5. Config-driven (SaaS multi-tenant):
//      - `config.intents.disabled = ['AGE_POLICY', ...]` tắt rule không cần.
//      - `config.intents.prepend = [...]` chèn rule custom lên trên built-in.
//      - `config.intents.append  = [...]` chèn rule custom xuống cuối.
//      - `config.templates`        override từng template cụ thể.
//      - `config.formatProductLine`  override formatter dòng sản phẩm.
//      - `config.formatComparisonLine` override formatter dòng so sánh.
//      - `config.wantsLarge`       plugin detector thay thế built-in.
//      - `config.wantsVibration`   plugin detector (đối xứng với wantsLarge).
//      - `config.recommendations`  override danh sách gợi ý theo group.
//      - `config.budgetTightThreshold` ngưỡng "ngân sách thấp" (mặc định: giá thấp nhất trong catalogue).
//      Nhờ vậy 1 shop mới chỉ cần thư mục `shops/<id>/` (config + products + custom-intents),
//      KHÔNG cần đụng vào core/.

'use strict';

const defaultConfig = {
  shopName: 'shop',
  minAge: 18,
  policies: {
    freeShipping: true,
    privacy: '',
    payment: '',
    preorderDays: '',
    orderInfoFields: 'tên người nhận + SĐT + địa chỉ giao hàng'
  },
  keywordProducts: {},
  intents: {},
  templates: {},
  recommendations: {},
  // Plugin points — override tại shops/<id>/config.js nếu cần.
  wantsLarge: null,       // function(normalizedText, rawText) => boolean
  wantsVibration: null,   // function(normalizedText, rawText) => boolean
  formatProductLine: null,    // function(product, config) => string
  formatComparisonLine: null, // function(product, config) => string
  budgetTightThreshold: null  // number (đơn vị: k). null = tự tính từ giá thấp nhất.
};

const { TEMPLATES: DEFAULT_TEMPLATES, renderTemplate } = require('./responses');
const {
  normalizeText,
  preprocess,
  looksLikePhone,
  extractPhone,
  extractRequestedProductCodes: extractCodesRaw,
  providesAddress,
  providesName,
  isQuestion
} = require('./nlp');

// ===== Session states =====
const STATES = {
  IDLE: 'IDLE',
  PRODUCT_SELECTED: 'PRODUCT_SELECTED',
  COLLECTING_INFO: 'COLLECTING_INFO',
  READY_TO_CONFIRM: 'READY_TO_CONFIRM',
  CONFIRMED: 'CONFIRMED'
};

// LRU cap để tránh memory leak khi server chạy lâu.
const LAST_PRODUCT_LRU_LIMIT = 5000;

// ===== Pure helpers (không phụ thuộc engine instance) =====
function explainPrice(price) {
  const text = String(price || '').trim();
  const m = text.match(/^(\d+)\.(\d{3})k$/);
  if (m) return `${text} là ${Number(m[1])} triệu ${Number(m[2])} nghìn`;
  return text;
}

function missingOrderFields(order) {
  const missing = [];
  if (!order?.name)    missing.push('tên người nhận');
  if (!order?.phone)   missing.push('SĐT');
  if (!order?.address) missing.push('địa chỉ giao hàng');
  return missing;
}

function compactProductName(product) {
  return product ? `${product.code} giá ${explainPrice(product.price)}` : 'mẫu anh/chị chọn';
}

// ===== Detector functions =====
function asksWhyRepeatedInfo(text) {
  const t = preprocess(text);
  return /(gui|dua|nhan).*(ten|sdt|so\s*dien\s*thoai|dia\s*chi).*(roi|r|ma)/.test(t)
    || /(sao|tai\s*sao|vi\s*sao).*(hoi|bao|nhan).*(lai|nua)/.test(t);
}

function rejectsOrderIntent(text) {
  const t = preprocess(text);
  return /\b(chua|khong|ko|k)\s*(chot|mua|lay|dat|len\s*don)\b/.test(t)
    || /(noi|bao)\s*vay\s*thoi/.test(t)
    || /tham\s*khao\s*thoi/.test(t);
}

function wantsAddressChange(text) {
  const t = preprocess(text);
  if (/(doi|sua|cap\s*nhat|chuyen).*(dia\s*chi|noi\s*nhan|cho\s*nhan)/.test(t)) return true;
  if (/(doi|sua|cap\s*nhat|chuyen)\b.*\bsang\b.*(xa|phuong|huyen|quan|tinh|tp|thanh\s*pho|ha\s*noi|sai\s*gon|ho\s*chi\s*minh|bac\s*ninh|hai\s*phong|da\s*nang)/.test(t)) return true;
  return false;
}

function isNonCommittalReaction(text) {
  const raw = String(text || '').trim();
  const t = preprocess(raw).trim();
  return /^(?:o|oh|a|ah|ua|u|uh|ha|haha|hihi|hehe|ok|oke|oki|okay|vang|da|ko|khong)(?:\s+(?:a|shop|nhe|nha))?$/.test(t)
    || /^[\s:;)(.\-!?👍👌😊😅😂🤣]+$/u.test(raw);
}

function wantsHuman(text) {
  const t = preprocess(text);
  return /\b(?:nhan\s*vien|admin|nguoi\s*that|tu\s*van\s*vien|gap\s*ng\s*that|ctv|cong\s*tac\s*vien)\b/.test(t);
}

function wantsMenuImages(text) {
  const t = preprocess(text);
  return /(xem|gui|cho|coi|tham\s*khao).*(menu|bang\s*gia|danh\s*muc|danh\s*sach|catalog|san\s*pham|cac\s*san\s*pham|hang)/.test(t)
    || /\bmenu\b/.test(t)
    || /\bcatalog\b/.test(t)
    || /\bdanh\s*sach\s*san\s*pham\b/.test(t)
    || /\bcac\s*san\s*pham\b/.test(t);
}

function wantsProductImage(text) {
  const t = preprocess(text);
  return /\b(?:anh|hinh|photo)\b/.test(t);
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wantsKeywordImage(text, keyword, config = {}) {
  const t = preprocess(text);
  const triggers = config.keywordTriggers?.[keyword];
  if (typeof triggers === 'function') return triggers(t, text);
  if (triggers instanceof RegExp) return triggers.test(t);
  const kw = String(keyword || '').trim();
  if (!kw) return false;
  return new RegExp(`\\b${escapeRegExp(kw)}\\b`).test(t);
}

function isOrderIntent(text) {
  const t = preprocess(text);
  if (/(?:ma|mau|loai)\s*nao/.test(t)) return false;
  if (/nen\s*(?:mua|lay|chon)\b/.test(t)) return false;
  return /\b(?:chot|lay|dat|mua|giu|len\s*don)\b/.test(t);
}

function isBudgetPresenceQuestion(text) {
  const t = preprocess(text);
  if (/\b(?:khong|chua)\s+(?:co|con)\b.*\bma\b.*\bduoi\b/.test(t)) return true;
  if (/\b(?:co|con)\s+(?:cac\s*)?ma\s+nao\b.*\bduoi\b/.test(t)) return true;
  if (/\bma\s+nao\b.*\bduoi\b/.test(t)) return true;
  if (/\bduoi\b.*\d{2,4}\s*(?:k|nghin|ngan|cu|c)\b/.test(t)) return true;
  if (/\btren\b.*\d{2,4}\s*(?:k|nghin|ngan|cu|c)\b/.test(t)) return true;
  return false;
}

function isPriceClarification(text) {
  const t = preprocess(text);
  if (/(?:bao\s*nhieu|may\s*tien|gia\s*(?:nhieu|sao|the\s*nao|bao\s*nhieu)|bao\s*gia)/.test(t)) return true;
  const hasPriceKeyword = /\bgia\b/.test(t);
  const hasPriceAmount  = /(?:\d+\s*(?:trieu|tr|k)\b|\d+\.\d+k\b)/.test(t);
  const hasLooseMarker  = isQuestion(text)
    || /\b(?:hay|la|phai|dung|ha|vay|nhi)\b/.test(t)
    || (hasPriceAmount && /\d+\s*(?:k|nghin|ngan|c)\s+a\s*$/i.test(t));
  const hasStrongMarker = /\b(?:khong|ko)\b/.test(t) && !/(?:khong|chua)\s+(?:co|con)\b/.test(t);
  const hasClarificationMarker = hasLooseMarker || hasStrongMarker;
  if (hasPriceKeyword && !hasPriceAmount) return true;
  if ((hasPriceKeyword || hasPriceAmount) && hasClarificationMarker) {
    if (isBudgetPresenceQuestion(text)) return false;
    return true;
  }
  return false;
}

function wantsShippingPrivacy(text) {
  const t = preprocess(text);
  return /(?:bao\s*mat|kin\s*dao|goi\s*kin|dong\s*goi|lo\s*hang|ten\s*shop|noi\s*dung|nhay\s*cam|ship\s*co\s*kin)/.test(t);
}

function wantsPaymentInfo(text) {
  const t = preprocess(text);
  return /(?:cod|thanh\s*toan|tra\s*tien|chuyen\s*khoan|ck|coc|dat\s*coc|nhan\s*hang\s*tra\s*tien)/.test(t);
}

function wantsDeliveryTime(text) {
  const t = preprocess(text);
  return /(?:bao\s*lau|may\s*ngay|khi\s*nao|giao\s*hang|nhan\s*hang|thoi\s*gian|hang\s*dat|co\s*san|con\s*hang)/.test(t);
}

function wantsShippingFee(text) {
  const t = preprocess(text);
  return /(?:phi\s*ship|tien\s*ship|ship\s*bao\s*nhieu|mien\s*ship|free\s*ship|freeship)/.test(t);
}

function wantsAgePolicy(text) {
  const t = preprocess(text);
  return /(?:18\+|du\s*tuoi|bao\s*nhieu\s*tuoi|vi\s*thanh\s*nien|duoi\s*18|chua\s*18|\b1[0-7]\s*tuoi\b)/.test(t);
}

function isSimpleGreeting(text) {
  const t = preprocess(text).trim();
  return /^(?:(?:em|anh|chi|minh|toi)\s+)?(?:xin\s*)?(?:chao|hello|hi|alo|shop|em\s*oi|chi\s*oi|anh\s*oi)(?:\s+(?:shop|em|chi|anh|ban))?[.!?\s]*$/.test(t);
}

function isSimpleConfirmation(text) {
  const t = preprocess(text).trim();
  return /^(?:ok|oke|oki|okay|uh|u|vang|da|duoc|chuan|dung|xac\s*nhan|dong\s*y|chot|len\s*don|gui\s*hang)(?:\s+(?:nhe|nha|a|shop|em))?[.!?\s]*$/.test(t);
}

function wantsReturnPolicy(text) {
  const t = preprocess(text);
  return /(?:doi\s*tra|bao\s*hanh|\bloi\b|\bhong\b|kiem\s*hang|kiem\s*tra|mo\s*hang|tra\s*hang|hoan\s*tien)/.test(t);
}

function wantsComparison(text) {
  const t = preprocess(text);
  return /(?:so\s*sanh|khac\s*nhau|hon\s*gi|nen\s*chon|chon\s*mau\s*nao|mau\s*nao\s*hon)/.test(t);
}

function wantsRecommendation(text) {
  const t = preprocess(text);
  return /(?:tu\s*van|goi\s*y|nen\s*mua|nen\s*lay|chon\s*mau|mau\s*nao|loai\s*nao|phu\s*hop|ngan\s*sach)/.test(t);
}

function wantsSizeInfo(text) {
  const t = preprocess(text);
  return /(?:kich\s*thuoc|size|nang|can\s*nang|bao\s*to|to\s*khong)/.test(t);
}

function wantsGiftInfo(text) {
  const t = preprocess(text);
  return /(?:tang|qua|kem\s*theo|combo)/.test(t);
}

function wantsFitInfo(text) {
  const t = preprocess(text);
  return /(?:khit|chat|om|rong|co\s*gian|mem|that\s*khong|giong\s*that)/.test(t);
}

function wantsCleaningInfo(text) {
  const t = preprocess(text);
  return /(?:ve\s*sinh|rua|lam\s*sach|giat|khu\s*mui|bao\s*quan|co\s*rua\s*duoc)/.test(t);
}

function asksForOrderInfo(text) {
  const t = preprocess(text);
  if (!/(?:dia\s*chi|sdt|so\s*dien\s*thoai|ten\s*nguoi\s*nhan|thong\s*tin\s*giao\s*hang|hoi\s*dia\s*chi)/.test(t)) return false;
  return isQuestion(text);
}

// FIX: wantsFeatureAdvice không còn dùng `\bto\b` standalone — quá rộng, bắt nhầm
// địa chỉ/tên người. Từ "to" lớn/nhỏ nên để wantsLarge/plugin xử lý.
function wantsFeatureAdvice(text) {
  const t = preprocess(text);
  return /(?:nho\s*gon|silicon|tu\s*van\s*them|tu\s*van\s*ky|muon\s*biet\s*them|\bmau\s+to\s+khong\b|\bto\s+khong\b)/.test(t);
}

function wantsNewProducts(text) {
  const t = preprocess(text);
  if (/(?:roi|thi|vua)\s*moi/.test(t)) return false;
  return /(?:hang|mau|san\s*pham).*(?:moi|cap\s*nhat|ve\s*them)/.test(t)
    || /(?:moi\s*ve|co\s*gi\s*moi)/.test(t);
}

function wantsStockInfo(text) {
  const t = preprocess(text);
  return /(?:con\s*hang|het\s*hang|co\s*san|san\s*khong|con\s*khong|con\s*k|con\s*ko)/.test(t);
}

function wantsBestSeller(text) {
  const t = preprocess(text);
  return /(?:ban\s*chay|\bhot\b|nhieu\s*nguoi\s*mua|mau\s*nao\s*duoc|mau\s*nao\s*ok|nen\s*lay\s*mau\s*nao)/.test(t);
}

function wantsDiscount(text) {
  const t = preprocess(text);
  return /(?:giam|bot|fix|re\s*hon|uu\s*dai|khuyen\s*mai|sale|deal|gia\s*tot)/.test(t);
}

function wantsInspection(text) {
  const t = preprocess(text);
  return /(?:kiem\s*hang|xem\s*hang|mo\s*hang|dong\s*kiem|duoc\s*xem|cho\s*xem)/.test(t);
}

function wantsCancelOrder(text) {
  const t = preprocess(text);
  if (/\bhuy\b\s*(?:don|hang|mua|lay|chot|nhe)?/.test(t) && /\b(?:huy|don|hang)\b/.test(t)) return true;
  if (/(?:khong|ko|k)\s+(?:lay|chot|mua|dat|len\s*don)\b/.test(t)) return true;
  if (/(?:khong|ko|k)\s+muon\s+(?:mua|lay|chot|dat)\b/.test(t)) return true;
  if (/thoi\s*(?:khong|ko)\s+(?:lay|chot|mua|dat|len\s*don|don|hang)\b/.test(t)) return true;
  if (/(?:khong|ko|k)\s+(?:can|lay|mua|chot)\s+nua\b/.test(t)) return true;
  return false;
}

function wantsChangeProduct(text) {
  const t = preprocess(text);
  return /(?:doi|sua|chuyen)\s+(?:sang\s+)?(?:mau|ma|san\s*pham|sp)\b/.test(t);
}

function wantsOfficePickup(text) {
  const t = preprocess(text);
  return /(?:qua\s*shop|den\s*shop|lay\s*truc\s*tiep|co\s*cua\s*hang|dia\s*chi\s*shop)/.test(t);
}

// ===== Engine factory =====
function createRuleEngine({ products, config = defaultConfig, contextStore = {} } = {}) {
  // Merge config với defaults
  const cfg = { ...defaultConfig, ...config, policies: { ...defaultConfig.policies, ...(config.policies || {}) } };

  const productList = products || [];
  const productByCode = new Map(productList.map(p => [String(p.code || '').toUpperCase(), p]));
  const knownCodes = productList.map(p => p.code).filter(Boolean);

  // LRU cho lastProductByUser.
  const lastProductByUser = new Map();
  function lruSetLastProduct(userId, product) {
    if (lastProductByUser.has(userId)) lastProductByUser.delete(userId);
    lastProductByUser.set(userId, product);
    if (lastProductByUser.size > LAST_PRODUCT_LRU_LIMIT) {
      lastProductByUser.delete(lastProductByUser.keys().next().value);
    }
  }

  // Merge templates: defaults + per-shop overrides.
  const templates = { ...DEFAULT_TEMPLATES, ...(cfg.templates || {}) };

  function render(name, data = {}) {
    const tpl = templates[name];
    if (tpl == null) {
      console.warn(`[rules] Template không tồn tại: ${name}`);
      return '';
    }
    // Auto-inject examples từ catalogue của shop hiện tại.
    const examples = {
      codeExample1: knownCodes[0] || 'MÃ1',
      codeExample2: knownCodes[1] || knownCodes[0] || 'MÃ2'
    };
    return renderTemplate(tpl, { shopName: cfg.shopName, ...examples, ...data });
  }

  // ===== Product helpers =====
  function extractRequestedProductCodes(text) {
    return extractCodesRaw(text, knownCodes);
  }

  function productsByCodes(codes) {
    return codes.map(c => productByCode.get(String(c).toUpperCase())).filter(Boolean);
  }

  function getMentionedProducts(userText) {
    return productsByCodes(extractRequestedProductCodes(userText));
  }

  function getKeywordProduct(userText) {
    const keywordMap = cfg.keywordProducts || {};
    for (const [keyword, matcher] of Object.entries(keywordMap)) {
      if (!wantsKeywordImage(userText, keyword, cfg)) continue;
      const found = productList.find(p =>
        matcher.test(String(p.code || p.description || ''))
      );
      if (found) return found;
    }
    return null;
  }

  function rememberLastProduct(userId, product) {
    if (!userId || !product) return;
    lruSetLastProduct(userId, product);
    if (contextStore.setLastProductCode) contextStore.setLastProductCode(userId, product.code);
  }

  function getLastProduct(userId) {
    const mem = lastProductByUser.get(userId);
    if (mem) {
      // Touch LRU.
      lastProductByUser.delete(userId);
      lastProductByUser.set(userId, mem);
      return mem;
    }
    const code = contextStore.getLastProductCode?.(userId) || '';
    if (!code) return null;
    return productByCode.get(String(code).toUpperCase()) || null;
  }

  function getOrderDraft(userId) {
    return contextStore.getOrderDraft?.(userId) ?? {};
  }

  function getStoredSessionState(userId) {
    return contextStore.getSessionState?.(userId) ?? '';
  }

  function setStoredSessionState(userId, state) {
    contextStore.setSessionState?.(userId, state);
  }

  function deriveSessionState(userId, orderDraft) {
    if (getStoredSessionState(userId) === STATES.CONFIRMED) return STATES.CONFIRMED;
    const draft = orderDraft || getOrderDraft(userId);
    const missing = missingOrderFields(draft);
    if (!missing.length) return STATES.READY_TO_CONFIRM;
    if (draft.name || draft.phone || draft.address) return STATES.COLLECTING_INFO;
    if (draft.productCode || contextStore.getLastProductCode?.(userId)) return STATES.PRODUCT_SELECTED;
    return STATES.IDLE;
  }

  function shouldSilenceAfterCompleteOrder(userText, userId) {
    const orderDraft = getOrderDraft(userId);
    const state = deriveSessionState(userId, orderDraft);
    if (state !== STATES.READY_TO_CONFIRM && state !== STATES.CONFIRMED) return false;
    if (!isSimpleConfirmation(userText) && !isNonCommittalReaction(userText)) return false;
    if (state === STATES.READY_TO_CONFIRM) setStoredSessionState(userId, STATES.CONFIRMED);
    return true;
  }

  // ===== Render helpers =====
  function readyOrderReply(order, product) {
    return render('readyOrder', {
      productText: product?.code || order.productCode || 'mẫu anh/chị chọn',
      name:    order.name    || '',
      phone:   order.phone   || '',
      address: order.address || ''
    });
  }

  // ===== Price / product helpers =====
  function priceToK(priceStr) {
    const m = String(priceStr || '').match(/^(\d+)(?:\.(\d{3}))?k/i);
    if (!m) return null;
    return m[2] ? Number(m[1]) * 1000 + Number(m[2]) : Number(m[1]);
  }

  function selectProductsByBudget(budget) {
    if (!budget) return [];
    return productList.filter(p => { const k = priceToK(p.price); return k != null && k <= budget; });
  }

  function recommendationProducts(group) {
    const explicit = cfg.recommendations?.[group];
    if (Array.isArray(explicit) && explicit.length) {
      return explicit.map(code => productByCode.get(String(code).toUpperCase())).filter(Boolean);
    }
    const sortedAsc = [...productList]
      .filter(p => priceToK(p.price) != null && !p.preorder)
      .sort((a, b) => priceToK(a.price) - priceToK(b.price));

    if (group === 'budget')   return sortedAsc.slice(0, 3);
    if (group === 'premium')  return [...productList]
      .filter(p => priceToK(p.price) != null)
      .sort((a, b) => priceToK(b.price) - priceToK(a.price))
      .slice(0, 3);
    // FIX: 'large' và 'vibration' đã chuyển sang plugin hook — override tại config.recommendations.
    // Nếu chưa có override thì trả về mảng rỗng (tránh hardcode regex ngành hàng).
    return [];
  }

  // FIX: formatProductLine và formatComparisonLine là plugin point — shop có thể override.
  function formatProductLine(product) {
    if (typeof cfg.formatProductLine === 'function') return cfg.formatProductLine(product, cfg);
    const details = [
      product.description,
      product.size        ? `size ${product.size}` : '',
      product.gift        ? `tặng ${product.gift}`  : '',
      product.preorder    ? `hàng đặt ${cfg.policies.preorderDays}` : ''
    ].filter(Boolean).join(', ');
    return `${product.code}: ${product.price}${details ? ` - ${details}` : ''}`;
  }

  function formatComparisonLine(product) {
    if (typeof cfg.formatComparisonLine === 'function') return cfg.formatComparisonLine(product, cfg);
    const tags = [
      product.size   ? `size ${product.size}`    : '',
      product.weight ? `nặng ${product.weight}`  : '',
      product.preorder ? 'hàng đặt' : 'có thể chốt theo danh sách hiện tại'
    ].filter(Boolean).join(', ');
    return `- ${product.code}: ${explainPrice(product.price)}${tags ? `, ${tags}` : ''} - ${product.description}`;
  }

  // FIX: tính budgetTightThreshold tự động từ giá thấp nhất trong catalogue.
  function getBudgetTightThreshold() {
    if (cfg.budgetTightThreshold != null) return cfg.budgetTightThreshold;
    const prices = productList.map(p => priceToK(p.price)).filter(n => n != null);
    return prices.length ? Math.min(...prices) : 200;
  }

  // FIX: wantsLarge / wantsVibration đối xứng nhau — đều là plugin point.
  function resolveWantsLarge(normalizedText, rawText) {
    if (typeof cfg.wantsLarge === 'function') return cfg.wantsLarge(normalizedText, rawText);
    return /\blon\b|kich\s*thuoc\s*lon|size\s*lon/.test(normalizedText);
  }

  function resolveWantsVibration(normalizedText, rawText) {
    if (typeof cfg.wantsVibration === 'function') return cfg.wantsVibration(normalizedText, rawText);
    return false;
  }

  // FIX: tách otherFields thành helper riêng — không strip cứng "SĐT + ".
  function deriveOtherOrderFields(orderInfoFields) {
    // Loại bỏ "SĐT" và bất kỳ dấu " + " xung quanh nó (thứ tự bất kỳ).
    return orderInfoFields
      .split(/\s*\+\s*/)
      .map(s => s.trim())
      .filter(s => !/^s[đd]t$/i.test(s))
      .join(' + ');
  }

  // ===== Build context cho intent router =====
  function buildIntentContext(userText, userId) {
    const t = preprocess(userText);
    const requestedCodes  = extractRequestedProductCodes(userText);
    const found           = getMentionedProducts(userText);
    const keywordProduct  = getKeywordProduct(userText);
    const orderDraft      = getOrderDraft(userId);
    const draftProduct    = orderDraft.productCode
      ? productByCode.get(String(orderDraft.productCode).toUpperCase())
      : null;

    // selectedProduct: ưu tiên mention tường minh → keyword → lastProduct → draft
    const selectedProduct = found[0] || keywordProduct || getLastProduct(userId) || draftProduct;
    const orderProduct    = found[0] || draftProduct   || getLastProduct(userId);
    const productAwareOrder = {
      ...orderDraft,
      productCode: orderProduct?.code || orderDraft.productCode || ''
    };
    const missingFields  = missingOrderFields(productAwareOrder);
    const sessionState   = deriveSessionState(userId, productAwareOrder);
    const wantsVibration = resolveWantsVibration(t, userText);
    const wantsLarge     = resolveWantsLarge(t, userText);
    const wantsPhoto     = /\banh\b|\bhinh\b|\bxem\b|\bcoi\b|\bgui\b|\bmenu\b|\bdanh\s*sach\b/.test(t);
    const budgetMatch    = t.match(/(?:ngan\s*sach\s*)?(\d{2,4})(?:\s*(k|nghin|ngan|cu|c))\b/);
    const budget         = budgetMatch ? Number(budgetMatch[1]) : null;

    return {
      text: userText,
      normalized: t,
      userId,
      requestedCodes,
      found,
      keywordProduct,
      selectedProduct,
      orderProduct,
      orderDraft,
      productAwareOrder,
      missingFields,
      sessionState,
      wantsVibration,
      wantsLarge,
      wantsPhoto,
      budget,
      mentionsKeyword(keyword) {
        const map = cfg.keywordProducts || {};
        if (!Object.prototype.hasOwnProperty.call(map, keyword)) return false;
        return wantsKeywordImage(userText, keyword, cfg);
      },
      config: cfg,
      products: productList,
      render,
      recommendationProducts
    };
  }

  // ===== Built-in INTENT ROUTERS (Chain of Responsibility) =====
  const builtInIntents = [
    {
      name: 'CANCEL_ORDER',
      match: ctx => wantsCancelOrder(ctx.text),
      handle: ctx => {
        if (contextStore.clearOrderDraft) contextStore.clearOrderDraft(ctx.userId);
        return render('cancelOrder');
      }
    },
    {
      name: 'REJECT_ORDER',
      match: ctx => rejectsOrderIntent(ctx.text),
      handle: ctx => {
        if (ctx.sessionState !== STATES.IDLE && contextStore.clearOrderDraft) {
          contextStore.clearOrderDraft(ctx.userId);
        }
        return render('rejectOrder');
      }
    },
    {
      name: 'ADDRESS_CHANGE',
      match: ctx => wantsAddressChange(ctx.text),
      handle: ctx => ctx.missingFields.length
        ? render('addressChangeMissing', { missing: ctx.missingFields.join(' + ') })
        : render('addressChangeReady')
    },
    {
      name: 'ASKS_WHY_REPEATED',
      match: ctx => asksWhyRepeatedInfo(ctx.text),
      handle: ctx => ctx.missingFields.length
        ? render('apologyRepeatedMissing', { missing: ctx.missingFields.join(' + ') })
        : render('apologyRepeatedReady', {
            productText: ctx.selectedProduct?.code || ctx.productAwareOrder.productCode || 'mẫu anh/chị chọn',
            name:    ctx.productAwareOrder.name    || '',
            phone:   ctx.productAwareOrder.phone   || '',
            address: ctx.productAwareOrder.address || ''
          })
    },
    {
      name: 'PHONE_WITH_LEAD',
      match: ctx => looksLikePhone(ctx.text) && (providesName(ctx.text) || providesAddress(ctx.text)),
      handle: ctx => ctx.missingFields.length
        ? render('phoneWithLeadMissing', { missing: ctx.missingFields.join(' + ') })
        : readyOrderReply(ctx.productAwareOrder, ctx.selectedProduct)
    },
    {
      // FIX: otherFields dùng helper chuyên dụng thay vì strip cứng.
      name: 'PHONE_ONLY',
      match: ctx => looksLikePhone(ctx.text),
      handle: ctx => ctx.missingFields.length
        ? render('phoneOnlyMissing', {
            otherFields: deriveOtherOrderFields(cfg.policies.orderInfoFields),
            shopName:    cfg.shopName
          })
        : readyOrderReply(ctx.productAwareOrder, ctx.selectedProduct)
    },
    {
      name: 'GREETING',
      match: ctx => isSimpleGreeting(ctx.text),
      handle: () => render('greeting', { shopName: cfg.shopName })
    },
    {
      name: 'CHANGE_PRODUCT',
      match: ctx => wantsChangeProduct(ctx.text),
      // FIX: truyền tường minh codeExample để rõ ràng; render() auto-inject nhưng
      // explicit tốt hơn cho readability và testability.
      handle: () => render('changeProduct', {
        codeExample1: knownCodes[0] || 'MÃ1',
        codeExample2: knownCodes[1] || knownCodes[0] || 'MÃ2'
      })
    },
    {
      name: 'PROVIDES_NAME_OR_ADDRESS',
      match: ctx => providesName(ctx.text) || providesAddress(ctx.text),
      handle: ctx => {
        if (!ctx.missingFields.length) return readyOrderReply(ctx.productAwareOrder, ctx.selectedProduct);
        if (ctx.selectedProduct) {
          return render('infoMissingWithProduct', {
            productCode: ctx.selectedProduct.code,
            missing:     ctx.missingFields.join(' + ')
          });
        }
        return render('infoMissingNoProduct');
      }
    },
    {
      name: 'PRODUCT_NOT_FOUND',
      match: ctx => ctx.requestedCodes.length && !ctx.found.length,
      handle: ctx => render('productNotFound', { codes: ctx.requestedCodes.join(', ') })
    },
    {
      name: 'MENU_NO_PRODUCT',
      match: ctx => wantsMenuImages(ctx.text) && !ctx.found.length,
      // FIX: truyền tường minh codeExample1 để template menuSent hoạt động đúng.
      handle: () => render('menuSent', { codeExample1: knownCodes[0] || 'MÃ1' })
    },
    {
      name: 'NEW_PRODUCTS',
      match: ctx => wantsNewProducts(ctx.text),
      handle: () => render('newProducts')
    },
    {
      name: 'STOCK_INFO',
      match: ctx => wantsStockInfo(ctx.text),
      handle: ctx => {
        if (ctx.selectedProduct) {
          const stockText = ctx.selectedProduct.preorder
            ? `là hàng đặt, thời gian khoảng ${cfg.policies.preorderDays}`
            : 'shop đang tư vấn/chốt theo danh sách hiện tại';
          return render('stockInfoSelected', { productCode: ctx.selectedProduct.code, stockText });
        }
        return render('stockInfoUnknown');
      }
    },
    {
      name: 'BEST_SELLER',
      match: ctx => wantsBestSeller(ctx.text),
      handle: () => {
        const options = [
          ...recommendationProducts('premium').slice(0, 2),
          ...recommendationProducts('budget').slice(0, 1)
        ];
        const unique = [...new Map(options.map(p => [p.code, p])).values()];
        const lines = unique.map(p => `${p.code} giá ${p.price}`).join(', ');
        return render('bestSeller', { lines: lines || 'các mẫu phổ biến trong menu' });
      }
    },
    {
      name: 'ASKS_FOR_ORDER_INFO',
      match: ctx => asksForOrderInfo(ctx.text),
      handle: ctx => render('orderInfoRequest', {
        productSuffix:  ctx.selectedProduct ? ` ${ctx.selectedProduct.code}` : '',
        orderInfoFields: cfg.policies.orderInfoFields
      })
    },
    {
      name: 'ORDER_INTENT',
      match: ctx => isOrderIntent(ctx.text),
      handle: ctx => {
        if (!ctx.selectedProduct) {
          return render('orderIntentNoProduct', { orderInfoFields: cfg.policies.orderInfoFields || 'thông tin giao hàng' });
        }
        return render('orderIntentWithProduct', {
          productCode:    ctx.selectedProduct.code,
          price:          explainPrice(ctx.selectedProduct.price),
          orderInfoFields: cfg.policies.orderInfoFields,
          privacy:        cfg.policies.privacy
        });
      }
    },
    {
      name: 'PRICE_CLARIFICATION',
      match: ctx => {
        if (isBudgetPresenceQuestion(ctx.text)) return false;
        if (!isPriceClarification(ctx.text) || !ctx.selectedProduct) return false;
        const t = ctx.normalized;
        if (ctx.budget && !ctx.found.length && (/\b(?:loai|mau|hang)\b/.test(t) || /(?:the\s*nao|nhu\s*the\s*nao)/.test(t))) return false;
        return true;
      },
      handle: ctx => {
        const p = ctx.selectedProduct;
        const stockText = p.preorder
          ? `là hàng đặt ${cfg.policies.preorderDays}`
          : 'shop đang tư vấn/chốt theo chính sách hiện tại';
        const giftText = p.gift ? `, tặng ${p.gift}` : '';
        return render('priceClarification', { productCode: p.code, price: explainPrice(p.price), stockText, giftText });
      }
    },
    {
      // FIX: đã bỏ vế `|| ctx.found.length >= 2` thừa — khiến mọi message có ≥2 mã
      // đều kích hoạt COMPARISON dù user không có ý so sánh.
      name: 'COMPARISON',
      match: ctx => wantsComparison(ctx.text) && ctx.found.length >= 2,
      handle: ctx => render('comparison', {
        lines: ctx.found.slice(0, 3).map(formatComparisonLine).join('\n')
      })
    },
    {
      name: 'SHIPPING_PRIVACY',
      match: ctx => wantsShippingPrivacy(ctx.text),
      handle: () => render('shippingPrivacy', { shopName: cfg.shopName, privacy: cfg.policies.privacy })
    },
    {
      name: 'INSPECTION',
      match: ctx => wantsInspection(ctx.text),
      handle: () => render('inspection')
    },
    {
      name: 'SHIPPING_FEE',
      match: ctx => wantsShippingFee(ctx.text),
      handle: () => render('shippingFee', {
        shopName:       cfg.shopName,
        fee:            cfg.policies.freeShipping ? 'miễn ship tất cả sản phẩm' : 'sẽ báo phí ship theo địa chỉ',
        orderInfoFields: cfg.policies.orderInfoFields
      })
    },
    {
      name: 'DISCOUNT',
      match: ctx => wantsDiscount(ctx.text),
      handle: () => render('discount', {
        shipText: cfg.policies.freeShipping ? 'đã miễn ship' : 'sẽ báo ship theo địa chỉ'
      })
    },
    {
      name: 'OFFICE_PICKUP',
      match: ctx => wantsOfficePickup(ctx.text),
      handle: () => render('officePickup')
    },
    {
      name: 'PAYMENT_INFO',
      match: ctx => wantsPaymentInfo(ctx.text),
      handle: ctx => ctx.selectedProduct?.preorder
        ? render('paymentPreorder', { productCode: ctx.selectedProduct.code })
        : render('paymentDefault', { shopName: cfg.shopName, payment: cfg.policies.payment })
    },
    {
      name: 'DELIVERY_TIME',
      match: ctx => wantsDeliveryTime(ctx.text),
      handle: ctx => ctx.selectedProduct?.preorder
        ? render('deliveryPreorder', {
            productCode:  ctx.selectedProduct.code,
            preorderDays: cfg.policies.preorderDays
          })
        : render('deliveryDefault')
    },
    {
      name: 'RETURN_POLICY',
      match: ctx => wantsReturnPolicy(ctx.text),
      handle: () => render('returnPolicy')
    },
    {
      name: 'AGE_POLICY',
      match: ctx => wantsAgePolicy(ctx.text),
      handle: () => render('agePolicy', { shopName: cfg.shopName, minAge: cfg.minAge })
    },
    {
      name: 'SIZE_INFO',
      match: ctx => wantsSizeInfo(ctx.text) && Boolean(ctx.selectedProduct),
      handle: ctx => {
        const p = ctx.selectedProduct;
        return render('sizeInfo', {
          productCode: p.code,
          size:        p.size || 'shop sẽ xác nhận thêm',
          weightText:  p.weight ? `, nặng khoảng ${p.weight}` : '',
          descSuffix:  p.description ? ` ${String(p.description).trim()}` : ''
        });
      }
    },
    {
      name: 'PRODUCT_IMAGE',
      match: ctx => wantsProductImage(ctx.text) && Boolean(ctx.selectedProduct),
      handle: ctx => render('productImage', {
        productCode:        ctx.selectedProduct.code,
        compactProductName: compactProductName(ctx.selectedProduct),
        orderInfoFields:    cfg.policies.orderInfoFields
      })
    },
    {
      name: 'GIFT_INFO',
      match: ctx => wantsGiftInfo(ctx.text) && Boolean(ctx.selectedProduct),
      handle: ctx => {
        const p = ctx.selectedProduct;
        const giftText = p.gift ? ` được tặng ${p.gift}` : ' hiện chưa có quà tặng ghi riêng trong danh sách';
        return render('giftInfo', { compactProductName: compactProductName(p), giftText });
      }
    },
    {
      name: 'FIT_INFO',
      match: ctx => wantsFitInfo(ctx.text) && Boolean(ctx.selectedProduct),
      handle: ctx => render('fitInfo', { productCode: ctx.selectedProduct.code })
    },
    {
      name: 'CLEANING_INFO',
      match: ctx => wantsCleaningInfo(ctx.text) && Boolean(ctx.selectedProduct),
      handle: () => render('cleaningInfo')
    },
    {
      name: 'PRODUCT_LIST',
      match: ctx => ctx.found.length > 0,
      handle: ctx => {
        const lines    = ctx.found.slice(0, 3).map(formatProductLine).join('\n');
        const photoNote = ctx.wantsPhoto ? render('productListPhotoSent') : render('productListAskPhoto');
        return render('productList', { lines, photoNote });
      }
    },
    {
      // FIX: budgetTightThreshold không còn hardcode 200k — tính động từ catalogue.
      name: 'BUDGET',
      match: ctx => Boolean(ctx.budget) && !wantsRecommendation(ctx.text),
      handle: ctx => {
        const threshold = getBudgetTightThreshold();
        if (ctx.budget <= threshold && (ctx.wantsVibration || ctx.wantsLarge)) {
          return render('budgetTightCustom', { maxBudget: threshold });
        }
        const options = selectProductsByBudget(ctx.budget).slice(0, 3);
        if (options.length) {
          return render('budgetOptions', {
            budget: ctx.budget,
            lines:  options.map(formatProductLine).join('\n')
          });
        }
        return render('budgetNoOptions', { budget: ctx.budget });
      }
    },
    {
      name: 'FEATURE_OR_LARGE_OR_RECOMMEND',
      match: ctx => wantsFeatureAdvice(ctx.text) || ctx.wantsLarge || (wantsRecommendation(ctx.text) && !ctx.budget),
      handle: ctx => {
        if (ctx.wantsLarge) {
          const options = recommendationProducts('large')
            .map(p => `${p.code} giá ${p.price}${p.preorder ? ' hàng đặt' : ''}`)
            .join(', ');
          return render('largeOptions', { options: options || 'một số mẫu kích thước lớn' });
        }
        return render('featureAdviceDefault');
      }
    }
  ];

  // ===== Áp dụng config-driven (disabled / prepend / append) =====
  const intentsConfig = cfg.intents || {};
  const disabledSet   = new Set(intentsConfig.disabled || []);
  const intentRouters = [
    ...(intentsConfig.prepend || []),
    ...builtInIntents.filter(intent => !disabledSet.has(intent.name)),
    ...(intentsConfig.append  || [])
  ];

  // ===== Loop chính =====
  function buildDeterministicReply(userText, userId) {
    const ctx = buildIntentContext(userText, userId);

    if (ctx.found.length) rememberLastProduct(userId, ctx.found[0]);

    // State demote khi khách muốn thay đổi sau CONFIRMED.
    const hasMutatingIntent = wantsAddressChange(userText) || wantsChangeProduct(userText) || wantsCancelOrder(userText);
    if (hasMutatingIntent && ctx.sessionState === STATES.CONFIRMED) {
      setStoredSessionState(userId, '');
    }

    for (const router of intentRouters) {
      let matched;
      try { matched = router.match(ctx); }
      catch (err) {
        console.warn(`[rules] match() lỗi ở rule ${router.name || '<no-name>'}: ${err.message}`);
        continue;
      }
      if (!matched) continue;

      try {
        const reply = router.handle(ctx);
        if (reply) return reply;
      } catch (err) {
        console.warn(`[rules] handle() lỗi ở rule ${router.name || '<no-name>'}: ${err.message}`);
      }
    }
    return null;
  }

  function buildFallbackReply(userText, userId = '') {
    const deterministic = buildDeterministicReply(userText, userId);
    if (deterministic) return deterministic;
    const customFb = cfg.fallbackReply != null ? String(cfg.fallbackReply).trim() : '';
    // FIX: return customFb (đã trim) thay vì cfg.fallbackReply gốc.
    if (customFb) return customFb;
    return render('catalogScopeGuide', { shopName: cfg.shopName }) || render('systemBusy');
  }

  return {
    buildDeterministicReply,
    buildFallbackReply,
    extractPhone,
    extractRequestedProductCodes,
    looksLikePhone,
    normalizeText,
    shouldSilenceAfterCompleteOrder,
    wantsHuman,
    wantsKeywordImage: (text, kw) => wantsKeywordImage(text, kw, cfg),
    wantsMenuImages,
    wantsProductImage,
    // Debug / test
    intentRouters,
    STATES,
    deriveSessionState,
    render,
    recommendationProducts
  };
}

module.exports = {
  createRuleEngine,
  explainPrice,
  extractPhone,
  extractRequestedProductCodes: text => extractCodesRaw(text),
  looksLikePhone,
  normalizeText,
  STATES,
  detectors: {
    isOrderIntent,
    isPriceClarification,
    isSimpleGreeting,
    isSimpleConfirmation,
    isNonCommittalReaction,
    asksWhyRepeatedInfo,
    asksForOrderInfo,
    rejectsOrderIntent,
    isBudgetPresenceQuestion,
    wantsAddressChange,
    wantsAgePolicy,
    wantsBestSeller,
    wantsCancelOrder,
    wantsChangeProduct,
    wantsCleaningInfo,
    wantsComparison,
    wantsDeliveryTime,
    wantsDiscount,
    wantsFeatureAdvice,
    wantsFitInfo,
    wantsGiftInfo,
    wantsHuman,
    wantsInspection,
    wantsKeywordImage: (text, keyword) => wantsKeywordImage(text, keyword, {}),
    wantsMenuImages,
    wantsNewProducts,
    wantsOfficePickup,
    wantsPaymentInfo,
    wantsProductImage,
    wantsRecommendation,
    wantsReturnPolicy,
    wantsShippingFee,
    wantsShippingPrivacy,
    wantsSizeInfo,
    wantsStockInfo
  }
};
