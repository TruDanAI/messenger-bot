// Engine trả lời rule-based.
//
// Kiến trúc:
//   1. Văn bản trả lời tách hoàn toàn sang `responses.js` (template hóa).
//   2. Tiền xử lý NLP (normalize/slang/fuzzy/address) tách sang `nlp.js`.
//   3. `buildDeterministicReply` duyệt qua mảng `intentRouters`
//      (Chain of Responsibility / Middleware).
//   4. State machine: IDLE -> PRODUCT_SELECTED -> COLLECTING_INFO ->
//      READY_TO_CONFIRM -> CONFIRMED.
//   5. Config-driven:
//      - `config.intents.disabled = ['AGE_POLICY', ...]` để tắt rule không cần.
//      - `config.intents.prepend = [...]` chèn rule custom lên trên built-in.
//      - `config.intents.append  = [...]` chèn rule custom xuống cuối.
//      - `config.templates`        override từng template cụ thể.
//      Nhờ vậy 1 shop mới chỉ cần thư mục trong `shops/<id>/` (config + products + custom-intents),
//      KHÔNG cần đụng vào core/.

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
  recommendations: {}
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

// LRU cap cho in-memory cache `lastProductByUser` để tránh memory leak khi server chạy lâu.
const LAST_PRODUCT_LRU_LIMIT = 5000;

// ===== Helpers thuần (không phụ thuộc engine) =====
function explainPrice(price) {
  const text = String(price || '').trim();
  const millionMatch = text.match(/^(\d+)\.(\d{3})k$/);
  if (millionMatch) {
    const millions = Number(millionMatch[1]);
    const thousands = Number(millionMatch[2]);
    return `${text} là ${millions} triệu ${thousands} nghìn`;
  }
  return text;
}

function missingOrderFields(order) {
  const missing = [];
  if (!order?.name) missing.push('tên người nhận');
  if (!order?.phone) missing.push('SĐT');
  if (!order?.address) missing.push('địa chỉ giao hàng');
  return missing;
}

function compactProductName(product) {
  return product ? `${product.code} giá ${explainPrice(product.price)}` : 'mẫu anh/chị chọn';
}

// ===== Detector functions (đều preprocess hoá ở bên trong) =====
function asksWhyRepeatedInfo(text) {
  const t = preprocess(text);
  return /(gui|dua|nhan).*(ten|sdt|so\s*dien\s*thoai|dia\s*chi).*(roi|r|ma)/.test(t)
    || /(sao|tai\s*sao|vi\s*sao).*(hoi|bao|nhan).*(lai|nua)/.test(t);
}

function rejectsOrderIntent(text) {
  const t = preprocess(text);
  return /(chua|khong|ko|k)\s*(chot|mua|lay|dat|len\s*don)/.test(t)
    || /(noi|bao)\s*vay\s*thoi/.test(t)
    || /tham\s*khao\s*thoi/.test(t);
}

function wantsAddressChange(text) {
  const t = preprocess(text);
  // 1) "đổi địa chỉ", "sửa địa chỉ", "cập nhật nơi nhận"
  if (/(doi|sua|cap\s*nhat|chuyen).*(dia\s*chi|noi\s*nhan|cho\s*nhan)/.test(t)) return true;
  // 2) "đổi/sửa giúp em sang phường/quận/..." - không yêu cầu "sang" liền sau "doi".
  if (/(doi|sua|cap\s*nhat|chuyen)\b.*\bsang\b.*(xa|phuong|huyen|quan|tinh|tp|thanh\s*pho|ha\s*noi|sai\s*gon|ho\s*chi\s*minh|bac\s*ninh|hai\s*phong|da\s*nang)/.test(t)) return true;
  return false;
}

function isNonCommittalReaction(text) {
  const raw = String(text || '').trim();
  const t = preprocess(raw).trim();
  return /^(?:o|oh|a|ah|ua|u|uh|ha|haha|hihi|hehe|ok|oke|oki|okay|vang|da|ko|khong)(?:\s+(?:a|shop|nhe|nha))?$/.test(t)
    || /^[\s:;)(.\-!?👍👌😊😅😂🤣]+$/u.test(raw);
}

// FIX: trước đây regex match cả "nhan vien" trong text gốc (có dấu) — không chuẩn nếu user gõ không dấu.
function wantsHuman(text) {
  const t = preprocess(text);
  return /\b(?:nhan\s*vien|admin|nguoi\s*that|tu\s*van\s*vien|gap\s*ng\s*that|ctv|cong\s*tac\s*vien)\b/.test(t);
}

function wantsMenuImages(text) {
  const t = preprocess(text);
  return /(xem|gui|cho|coi|tham\s*khao).*(menu|bang gia|danh muc|danh sach|catalog|san pham|cac san pham|hang)/.test(t)
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

/** Nhận diện keyword ảnh/menu: ưu tiên config.keywordTriggers[keyword], mặc định /\bkeyword\b/. */
function wantsKeywordImage(text, keyword, config = {}) {
  const t = preprocess(text);
  const triggers = config.keywordTriggers && config.keywordTriggers[keyword];
  if (typeof triggers === 'function') return triggers(t, text);
  if (triggers instanceof RegExp) return triggers.test(t);
  const kw = String(keyword || '').trim();
  if (!kw) return false;
  return new RegExp(`\\b${escapeRegExp(kw)}\\b`).test(t);
}

function isOrderIntent(text) {
  const t = preprocess(text);
  return /\b(?:chot|lay|dat|mua|giu|len\s*don)\b/.test(t);
}

function isPriceClarification(text) {
  const t = preprocess(text);
  const hasExplicitPriceQuestion = /(?:bao\s*nhieu|may\s*tien|gia\s*(?:nhieu|sao|the\s*nao|bao\s*nhieu)|bao\s*gia)/.test(t);
  if (hasExplicitPriceQuestion) return true;

  const hasPriceKeyword = /\bgia\b/.test(t);
  const hasPriceAmount = /(?:\d+\s*(?:trieu|tr|k)\b|\d+\.\d+k\b)/.test(t);
  const hasClarificationMarker = isQuestion(text)
    || /\b(?:hay|la|phai|dung|khong|ko|k|ha|a|vay|nhi)\b/.test(t);

  if (hasPriceKeyword && !hasPriceAmount) return true;
  return (hasPriceKeyword || hasPriceAmount) && hasClarificationMarker;
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

// FIX: phân biệt "user hỏi về order info" vs "user cung cấp order info".
// Trước đây cả 2 đều match -> ưu tiên handler theo thứ tự, dễ nhầm.
function asksForOrderInfo(text) {
  const t = preprocess(text);
  if (!/(?:dia\s*chi|sdt|so\s*dien\s*thoai|ten\s*nguoi\s*nhan|thong\s*tin\s*giao\s*hang|hoi\s*dia\s*chi)/.test(t)) {
    return false;
  }
  // Nếu đây là câu hỏi (có ?, "ở đâu", "thế nào" ...) thì là user hỏi.
  // Còn nếu user đang cung cấp địa chỉ thì providesAddress sẽ chiếm trước trong intent loop.
  return isQuestion(text);
}

function wantsFeatureAdvice(text) {
  const t = preprocess(text);
  // Tránh substring "to" trong "toi" (tôi) → FEATURE_OR_LARGE ăn trước ORDER_INTENT.
  // Từ khóa đặc thù từng ngành (vd rung/gel) nên đặt ở shops/<id>/custom-intents.js.
  return /(?:\bto\b|nho\s*gon|silicon)/.test(t);
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
  // Tránh substring "hot" trong "chot" (chốt) → false positive BEST_SELLER.
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

// FIX: trước đây "thoi khong sao dau" sẽ match vì suffix có dấu `?`.
// Giờ tách 3 case rõ ràng và bắt buộc có verb chốt đơn / object đơn hàng.
function wantsCancelOrder(text) {
  const t = preprocess(text);
  // 1) "hủy" + (đơn|hàng)? hoặc đứng riêng đầu câu
  if (/\bhuy\b\s*(?:don|hang|mua|lay|chot|nhe)?/.test(t) && /\b(?:huy|don|hang)\b/.test(t)) return true;
  // 2) "không/ko/k + (lấy|chốt|mua|đặt|lên đơn)" — bỏ qua "không sao", "không hiểu" v.v.
  if (/(?:khong|ko|k)\s+(?:lay|chot|mua|dat|len\s*don)\b/.test(t)) return true;
  // 3) "thôi không/ko + (lấy|chốt|mua|đặt|lên đơn|đơn|hàng)" — yêu cầu HẬU TỐ rõ ràng.
  if (/thoi\s*(?:khong|ko)\s+(?:lay|chot|mua|dat|len\s*don|don|hang)\b/.test(t)) return true;
  // 4) "không cần nữa", "không lấy nữa"
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
  const productList = products || [];
  const productByCode = new Map(productList.map(p => [String(p.code || '').toUpperCase(), p]));
  const knownCodes = productList.map(p => p.code).filter(Boolean);

  // LRU implementation cho lastProductByUser. Map giữ insertion order; khi vượt limit, evict oldest.
  const lastProductByUser = new Map();
  function lruSetLastProduct(userId, product) {
    if (lastProductByUser.has(userId)) lastProductByUser.delete(userId);
    lastProductByUser.set(userId, product);
    if (lastProductByUser.size > LAST_PRODUCT_LRU_LIMIT) {
      const firstKey = lastProductByUser.keys().next().value;
      lastProductByUser.delete(firstKey);
    }
  }

  // Merge templates: defaults + per-shop overrides.
  const templates = { ...DEFAULT_TEMPLATES, ...(config.templates || {}) };
  function render(name, data = {}) {
    const tpl = templates[name];
    if (tpl == null) {
      console.warn(`[rules] Template không tồn tại: ${name}`);
      return '';
    }
    return renderTemplate(tpl, data);
  }

  // ===== Helpers gắn với danh sách sản phẩm / context =====
  function extractRequestedProductCodes(text) {
    return extractCodesRaw(text, knownCodes);
  }

  function productsByCodes(codes) {
    return codes.map(code => productByCode.get(String(code).toUpperCase())).filter(Boolean);
  }

  function getMentionedProducts(userText) {
    return productsByCodes(extractRequestedProductCodes(userText));
  }

  function getKeywordProduct(userText) {
    const keywordMap = config.keywordProducts || {};
    for (const [keyword, matcher] of Object.entries(keywordMap)) {
      if (!wantsKeywordImage(userText, keyword, config)) continue;
      const found = productList.find(product =>
        matcher.test(String(product.code || product.description || ''))
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
    const memoryProduct = lastProductByUser.get(userId);
    if (memoryProduct) {
      // Touch LRU.
      lastProductByUser.delete(userId);
      lastProductByUser.set(userId, memoryProduct);
      return memoryProduct;
    }
    const code = contextStore.getLastProductCode ? contextStore.getLastProductCode(userId) : '';
    if (!code) return null;
    return productByCode.get(String(code).toUpperCase()) || null;
  }

  function getOrderDraft(userId) {
    return contextStore.getOrderDraft ? contextStore.getOrderDraft(userId) : {};
  }

  function getStoredSessionState(userId) {
    return contextStore.getSessionState ? contextStore.getSessionState(userId) : '';
  }

  function setStoredSessionState(userId, state) {
    if (contextStore.setSessionState) contextStore.setSessionState(userId, state);
  }

  function deriveSessionState(userId, orderDraft) {
    const explicit = getStoredSessionState(userId);
    if (explicit === STATES.CONFIRMED) return STATES.CONFIRMED;

    const draft = orderDraft || getOrderDraft(userId);
    const missing = missingOrderFields(draft);
    if (!missing.length) return STATES.READY_TO_CONFIRM;
    if (draft.name || draft.phone || draft.address) return STATES.COLLECTING_INFO;
    if (draft.productCode || (contextStore.getLastProductCode && contextStore.getLastProductCode(userId))) {
      return STATES.PRODUCT_SELECTED;
    }
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

  // ===== Render helpers (đa số trả thẳng template) =====
  function readyOrderReply(order, product) {
    return render('readyOrder', {
      productText: product?.code || order.productCode || 'mẫu anh/chị chọn',
      name: order.name || '',
      phone: order.phone || '',
      address: order.address || ''
    });
  }

  // ===== Helpers liên quan tới products =====
  function priceToK(priceStr) {
    const match = String(priceStr || '').match(/^(\d+)(?:\.(\d{3}))?k/i);
    if (!match) return null;
    return match[2] ? Number(match[1]) * 1000 + Number(match[2]) : Number(match[1]);
  }

  function selectProductsByBudget(budget) {
    if (!budget) return [];
    return productList.filter(product => {
      const priceK = priceToK(product.price);
      return priceK != null && priceK <= budget;
    });
  }

  // Recommendations: ưu tiên config.recommendations.<group>; nếu không có,
  // tự derive từ thuộc tính sản phẩm dựa vào quy ước:
  //   - budget: 3 mã giá thấp nhất (không preorder)
  //   - premium: 3 mã giá cao nhất
  //   - large: tất cả mã có size chứa "lớn" hoặc weight > 2000g
  //   - vibration: tất cả mã có description chứa "rung" hoặc "pin"
  function recommendationProducts(group) {
    const explicit = config.recommendations?.[group];
    if (Array.isArray(explicit) && explicit.length) {
      return explicit
        .map(code => productByCode.get(String(code).toUpperCase()))
        .filter(Boolean);
    }
    const sortedAsc = [...productList]
      .filter(p => priceToK(p.price) != null && !p.preorder)
      .sort((a, b) => priceToK(a.price) - priceToK(b.price));

    if (group === 'budget') return sortedAsc.slice(0, 3);
    if (group === 'premium') {
      return [...productList]
        .filter(p => priceToK(p.price) != null)
        .sort((a, b) => priceToK(b.price) - priceToK(a.price))
        .slice(0, 3);
    }
    if (group === 'large') {
      return productList.filter(p =>
        /lon|lớn|to/i.test(p.size || '') || (p.weight && parseInt(p.weight, 10) > 2000)
      );
    }
    if (group === 'vibration') {
      return productList.filter(p => /rung|pin|sac/i.test(p.description || ''));
    }
    return [];
  }

  function formatProductLine(product) {
    const details = [
      product.description,
      product.size ? `size ${product.size}` : '',
      product.gift ? `tặng ${product.gift}` : '',
      product.preorder ? `hàng đặt ${config.policies.preorderDays}` : ''
    ].filter(Boolean).join(', ');
    return `${product.code}: ${product.price}${details ? ` - ${details}` : ''}`;
  }

  function formatComparisonLine(product) {
    const tags = [
      product.size ? `size ${product.size}` : '',
      product.weight ? `nặng ${product.weight}` : '',
      product.preorder ? 'hàng đặt' : 'có thể chốt theo danh sách hiện tại'
    ].filter(Boolean).join(', ');
    return `- ${product.code}: ${explainPrice(product.price)}${tags ? `, ${tags}` : ''} - ${product.description}`;
  }

  // ===== Build context cho intent router =====
  function buildIntentContext(userText, userId) {
    const t = preprocess(userText);
    const requestedCodes = extractRequestedProductCodes(userText);
    const found = getMentionedProducts(userText);
    const keywordProduct = getKeywordProduct(userText);
    const orderDraft = getOrderDraft(userId);
    const draftProduct = orderDraft.productCode
      ? productByCode.get(String(orderDraft.productCode).toUpperCase())
      : null;
    const selectedProduct = found[0] || keywordProduct || getLastProduct(userId) || draftProduct;
    const orderProduct = found[0] || draftProduct || getLastProduct(userId);
    const productAwareOrder = {
      ...orderDraft,
      productCode: orderProduct?.code || orderDraft.productCode || ''
    };
    const missingFields = missingOrderFields(productAwareOrder);
    const sessionState = deriveSessionState(userId, productAwareOrder);

    const wantsVibration = typeof config.wantsVibration === 'function'
      ? config.wantsVibration(t, userText)
      : false;
    const wantsLarge = /\bto\b|\blon\b|kich\s*thuoc\s*lon|size\s*lon/.test(t);
    const wantsPhoto = /\banh\b|\bhinh\b|\bxem\b|\bcoi\b|\bgui\b|\bmenu\b|\bdanh\s*sach\b/.test(t);
    const budgetMatch = t.match(/(?:ngan\s*sach\s*)?(\d{2,4})\s*k\b/);
    const budget = budgetMatch ? Number(budgetMatch[1]) : null;

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
        const map = config.keywordProducts || {};
        if (!Object.prototype.hasOwnProperty.call(map, keyword)) return false;
        return wantsKeywordImage(userText, keyword, config);
      },
      // Helpers cho custom intent handlers (config-driven extension).
      config,
      products: productList,
      render,
      recommendationProducts
    };
  }

  // ===== Built-in INTENT ROUTERS (Chain of Responsibility) =====
  // Mỗi rule có `name` để toggle qua config.intents.disabled.
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
            name: ctx.productAwareOrder.name || '',
            phone: ctx.productAwareOrder.phone || '',
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
      name: 'PHONE_ONLY',
      match: ctx => looksLikePhone(ctx.text),
      handle: ctx => ctx.missingFields.length
        ? render('phoneOnlyMissing', {
            otherFields: config.policies.orderInfoFields.replace('SĐT + ', ''),
            shopName: config.shopName
          })
        : readyOrderReply(ctx.productAwareOrder, ctx.selectedProduct)
    },
    {
      name: 'GREETING',
      match: ctx => isSimpleGreeting(ctx.text),
      handle: () => render('greeting', { shopName: config.shopName })
    },
    {
      name: 'CHANGE_PRODUCT',
      match: ctx => wantsChangeProduct(ctx.text),
      handle: () => render('changeProduct')
    },
    {
      name: 'PROVIDES_NAME_OR_ADDRESS',
      match: ctx => providesName(ctx.text) || providesAddress(ctx.text),
      handle: ctx => {
        if (!ctx.missingFields.length) return readyOrderReply(ctx.productAwareOrder, ctx.selectedProduct);
        if (ctx.selectedProduct) {
          return render('infoMissingWithProduct', {
            productCode: ctx.selectedProduct.code,
            missing: ctx.missingFields.join(' + ')
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
      handle: () => render('menuSent')
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
            ? `là hàng đặt, thời gian khoảng ${config.policies.preorderDays}`
            : 'shop đang tư vấn/chốt theo danh sách hiện tại';
          return render('stockInfoSelected', {
            productCode: ctx.selectedProduct.code,
            stockText
          });
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
        productSuffix: ctx.selectedProduct ? ` ${ctx.selectedProduct.code}` : '',
        orderInfoFields: config.policies.orderInfoFields
      })
    },
    {
      name: 'ORDER_INTENT',
      match: ctx => isOrderIntent(ctx.text),
      handle: ctx => {
        if (!ctx.selectedProduct) return render('orderIntentNoProduct');
        return render('orderIntentWithProduct', {
          productCode: ctx.selectedProduct.code,
          price: explainPrice(ctx.selectedProduct.price),
          orderInfoFields: config.policies.orderInfoFields,
          privacy: config.policies.privacy
        });
      }
    },
    {
      name: 'PRICE_CLARIFICATION',
      match: ctx => {
        if (!isPriceClarification(ctx.text) || !ctx.selectedProduct) return false;
        const t = ctx.normalized;
        // "loại 150k thế nào" — hỏi mẫu theo mức giá; không báo giá mã lastProduct.
        if (
          ctx.budget
          && !ctx.found.length
          && (
            /\b(?:loai|mau|hang)\b/.test(t)
            || /(?:the\s*nao|nhu\s*the\s*nao)/.test(t)
          )
        ) {
          return false;
        }
        return true;
      },
      handle: ctx => {
        const p = ctx.selectedProduct;
        const stockText = p.preorder
          ? `là hàng đặt ${config.policies.preorderDays}`
          : 'shop đang tư vấn/chốt theo chính sách hiện tại';
        const giftText = p.gift ? `, tặng ${p.gift}` : '';
        return render('priceClarification', {
          productCode: p.code,
          price: explainPrice(p.price),
          stockText,
          giftText
        });
      }
    },
    {
      name: 'COMPARISON',
      match: ctx => (wantsComparison(ctx.text) && ctx.found.length >= 2) || ctx.found.length >= 2,
      handle: ctx => render('comparison', {
        lines: ctx.found.slice(0, 3).map(formatComparisonLine).join('\n')
      })
    },
    {
      name: 'SHIPPING_PRIVACY',
      match: ctx => wantsShippingPrivacy(ctx.text),
      handle: () => render('shippingPrivacy', {
        shopName: config.shopName,
        privacy: config.policies.privacy
      })
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
        shopName: config.shopName,
        fee: config.policies.freeShipping ? 'miễn ship tất cả sản phẩm' : 'sẽ báo phí ship theo địa chỉ',
        orderInfoFields: config.policies.orderInfoFields
      })
    },
    {
      name: 'DISCOUNT',
      match: ctx => wantsDiscount(ctx.text),
      handle: () => render('discount', {
        shipText: config.policies.freeShipping ? 'đã miễn ship' : 'sẽ báo ship theo địa chỉ'
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
        : render('paymentDefault', { shopName: config.shopName, payment: config.policies.payment })
    },
    {
      name: 'DELIVERY_TIME',
      match: ctx => wantsDeliveryTime(ctx.text),
      handle: ctx => ctx.selectedProduct?.preorder
        ? render('deliveryPreorder', {
            productCode: ctx.selectedProduct.code,
            preorderDays: config.policies.preorderDays
          })
        : render('deliveryDefault')
    },
    {
      name: 'RETURN_POLICY',
      match: ctx => wantsReturnPolicy(ctx.text),
      handle: () => render('returnPolicy')
    },
    {
      name: 'SIZE_INFO',
      match: ctx => wantsSizeInfo(ctx.text) && Boolean(ctx.selectedProduct),
      handle: ctx => {
        const p = ctx.selectedProduct;
        return render('sizeInfo', {
          productCode: p.code,
          size: p.size || 'shop sẽ xác nhận thêm',
          weightText: p.weight ? `, nặng khoảng ${p.weight}` : '',
          descSuffix: p.description ? ` ${String(p.description).trim()}` : ''
        });
      }
    },
    {
      name: 'PRODUCT_IMAGE',
      match: ctx => wantsProductImage(ctx.text) && Boolean(ctx.selectedProduct),
      handle: ctx => render('productImage', {
        productCode: ctx.selectedProduct.code,
        compactProductName: compactProductName(ctx.selectedProduct),
        orderInfoFields: config.policies.orderInfoFields
      })
    },
    {
      name: 'GIFT_INFO',
      match: ctx => wantsGiftInfo(ctx.text) && Boolean(ctx.selectedProduct),
      handle: ctx => {
        const p = ctx.selectedProduct;
        const giftText = p.gift ? ` được tặng ${p.gift}` : ' hiện chưa có quà tặng ghi riêng trong danh sách';
        return render('giftInfo', {
          compactProductName: compactProductName(p),
          giftText
        });
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
        const lines = ctx.found.slice(0, 3).map(formatProductLine).join('\n');
        const photoNote = ctx.wantsPhoto
          ? render('productListPhotoSent')
          : render('productListAskPhoto');
        return render('productList', { lines, photoNote });
      }
    },
    // FIX: trước đây có MENU_IMAGES nữa nhưng đã unreachable do MENU_NO_PRODUCT + PRODUCT_LIST
    // chiếm hết. Đã loại bỏ.
    {
      name: 'BUDGET',
      match: ctx => Boolean(ctx.budget),
      handle: ctx => {
        if (ctx.budget <= 200 && (ctx.wantsVibration || ctx.wantsLarge)) {
          return render('budgetTightCustom');
        }
        const options = selectProductsByBudget(ctx.budget).slice(0, 3);
        if (options.length) {
          return render('budgetOptions', {
            budget: ctx.budget,
            lines: options.map(formatProductLine).join('\n')
          });
        }
        return render('budgetNoOptions', { budget: ctx.budget });
      }
    },
    {
      name: 'FEATURE_OR_LARGE_OR_RECOMMEND',
      match: ctx => wantsFeatureAdvice(ctx.text) || ctx.wantsLarge || wantsRecommendation(ctx.text),
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
  const intentsConfig = config.intents || {};
  const disabledSet = new Set(intentsConfig.disabled || []);
  const intentRouters = [
    ...(intentsConfig.prepend || []),
    ...builtInIntents.filter(intent => !disabledSet.has(intent.name)),
    ...(intentsConfig.append || [])
  ];

  // ===== Loop chính: duyệt qua các intent routers =====
  function buildDeterministicReply(userText, userId) {
    const ctx = buildIntentContext(userText, userId);

    // Side effect ổn định: nhớ mã sản phẩm khách vừa nói tới.
    if (ctx.found.length) rememberLastProduct(userId, ctx.found[0]);

    // State transition: khách quay lại "thay đổi" sau khi đã CONFIRMED -> demote.
    const hasMutatingIntent = wantsAddressChange(userText)
      || wantsChangeProduct(userText)
      || wantsCancelOrder(userText);
    if (hasMutatingIntent && ctx.sessionState === STATES.CONFIRMED) {
      setStoredSessionState(userId, '');
    }

    for (const router of intentRouters) {
      let matched;
      try {
        matched = router.match(ctx);
      } catch (err) {
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
    return config.fallbackReply || render('systemBusy');
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
    wantsKeywordImage: (text, kw) => wantsKeywordImage(text, kw, config),
    wantsMenuImages,
    wantsProductImage,
    // Cho test/debug nếu cần
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
  // Bản module-level: regex-only (không có fuzzy theo danh sách sản phẩm).
  extractRequestedProductCodes: text => extractCodesRaw(text),
  looksLikePhone,
  normalizeText,
  STATES,
  // Export detectors để custom intents bên ngoài (config.intents.prepend) có thể dùng nếu muốn.
  detectors: {
    isOrderIntent,
    isPriceClarification,
    isSimpleGreeting,
    isSimpleConfirmation,
    isNonCommittalReaction,
    asksWhyRepeatedInfo,
    asksForOrderInfo,
    rejectsOrderIntent,
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
