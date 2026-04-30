const defaultConfig = require('./shop-config');

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

function looksLikePhone(text) {
  return /(?:\+?84|0)\d{8,10}/.test(text);
}

function extractPhone(text) {
  const match = String(text || '').match(/(?:\+?84|0)\d{8,10}/);
  return match ? match[0] : '';
}

function extractRequestedProductCodes(text) {
  const t = normalizeText(text);
  const codes = new Set();
  const re = /\b(?:ma|mau|sp|san\s*pham)\s*0*(\d{1,2})\b/g;
  let m;
  while ((m = re.exec(t))) {
    codes.add(`MÃ${Number(m[1])}`);
  }
  return [...codes];
}

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

function createRuleEngine({ products, config = defaultConfig, contextStore = {} } = {}) {
  const productList = products || [];
  const productByCode = new Map(productList.map(p => [String(p.code || '').toUpperCase(), p]));
  const lastProductByUser = new Map();

  function productsByCodes(codes) {
    return codes.map(code => productByCode.get(code.toUpperCase())).filter(Boolean);
  }

  function getMentionedProducts(userText) {
    return productsByCodes(extractRequestedProductCodes(userText));
  }

  function getKeywordProduct(userText) {
    if (wantsKeywordImage(userText, 'gel')) {
      const matcher = config.keywordProducts?.gel || /gel/i;
      return productList.find(product => matcher.test(String(product.code || product.description || ''))) || null;
    }
    return null;
  }

  function rememberLastProduct(userId, product) {
    if (!userId || !product) return;
    lastProductByUser.set(userId, product);
    if (contextStore.setLastProductCode) contextStore.setLastProductCode(userId, product.code);
  }

  function getLastProduct(userId) {
    const memoryProduct = lastProductByUser.get(userId);
    if (memoryProduct) return memoryProduct;

    const code = contextStore.getLastProductCode ? contextStore.getLastProductCode(userId) : '';
    if (!code) return null;
    return productByCode.get(String(code).toUpperCase()) || null;
  }

  function getOrderDraft(userId) {
    return contextStore.getOrderDraft ? contextStore.getOrderDraft(userId) : {};
  }

  function missingOrderFields(order) {
    const missing = [];
    if (!order.name) missing.push('tên người nhận');
    if (!order.phone) missing.push('SĐT');
    if (!order.address) missing.push('địa chỉ giao hàng');
    return missing;
  }

  function readyOrderReply(order, product) {
    const productText = product?.code || order.productCode || 'mẫu anh/chị chọn';
    return `Dạ em đã có đủ thông tin chốt ${productText}: ${order.name}, ${order.phone}, ${order.address}. Shop sẽ kiểm tra và xác nhận lại đơn với anh/chị trước khi gửi hàng nhé.`;
  }

  function asksWhyRepeatedInfo(text) {
    const t = normalizeText(text);
    return /(gui|dua|nhan).*(ten|sdt|so\s*dien\s*thoai|dia\s*chi).*(roi|r|ma)/
      .test(t)
      || /(sao|tai\s*sao|vi\s*sao).*(hoi|bao|nhan).*(lai|nua)/
        .test(t);
  }

  function rejectsOrderIntent(text) {
    const t = normalizeText(text);
    return /(chua|khong|ko|k)\s*(chot|mua|lay|dat|len\s*don)/
      .test(t)
      || /(noi|bao)\s*vay\s*thoi/.test(t)
      || /tham\s*khao\s*thoi/.test(t);
  }

  function wantsAddressChange(text) {
    const t = normalizeText(text);
    return /(doi|sua|cap\s*nhat|chuyen).*(dia\s*chi|dc|noi\s*nhan|cho\s*nhan)/
      .test(t)
      || (
        /(doi|sua|cap\s*nhat|chuyen)\s*sang\b/.test(t)
        && /(xa|phuong|huyen|quan|tinh|tp|thanh\s*pho|ha\s*noi|sai\s*gon|ho\s*chi\s*minh|bac\s*ninh)/.test(t)
      );
  }

  function isNonCommittalReaction(text) {
    const raw = String(text || '').trim();
    const t = normalizeText(raw).trim();
    return /^(o|oh|a|ah|ua|u|uh|ha|haha|hihi|hehe|ok|oke|oki|okay|vang|da|ko|khong)(\s+(a|shop|nhe|nha))?$/.test(t)
      || /^[\s:;)(.\-!?👍👌😊😅😂🤣]+$/u.test(raw);
  }

  function shouldSilenceAfterCompleteOrder(userText, userId) {
    const orderDraft = getOrderDraft(userId);
    return !missingOrderFields(orderDraft).length
      && (isSimpleConfirmation(userText) || isNonCommittalReaction(userText));
  }

  function compactProductName(product) {
    return product ? `${product.code} giá ${explainPrice(product.price)}` : 'mẫu anh/chị chọn';
  }

  function selectProductsByBudget(budget) {
    if (!budget) return [];
    return productList.filter(product => {
      const match = String(product.price || '').match(/^(\d+)(?:\.(\d{3}))?k/);
      if (!match) return false;
      const priceK = match[2] ? Number(match[1]) * 1000 + Number(match[2]) : Number(match[1]);
      return priceK <= budget;
    });
  }

  function recommendationProducts(group) {
    return (config.recommendations?.[group] || [])
      .map(code => productByCode.get(String(code).toUpperCase()))
      .filter(Boolean);
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

  function wantsHuman(text) {
    return /(nhân\s*viên|admin|người\s*thật|tư\s*vấn\s*viên|gặp\s*ng\s*thật)/i.test(text);
  }

  function wantsMenuImages(text) {
    const t = normalizeText(text);
    return /(xem|gui|cho|coi|tham\s*khao).*(menu|bang gia|danh muc|danh sach|catalog|san pham|cac san pham|hang)/.test(t)
      || /\bmenu\b/.test(t)
      || /\bcatalog\b/.test(t)
      || /\bdanh\s*sach\s*san\s*pham\b/.test(t)
      || /\bcac\s*san\s*pham\b/.test(t);
  }

  function wantsProductImage(text) {
    const t = normalizeText(text);
    return /\b(anh|hinh|photo)\b/.test(t);
  }

  function wantsKeywordImage(text, keyword) {
    const t = normalizeText(text);
    if (keyword === 'gel') {
      return /\bgel\b/.test(t)
        || /\bboi\s*tron\b/.test(t)
        || /\blub(ricant)?\b/.test(t);
    }
    return false;
  }

  function isOrderIntent(text) {
    const t = normalizeText(text);
    return /\b(chot|lay|dat|mua|giu|len\s*don)\b/.test(t);
  }

  function isPriceClarification(text) {
    const t = normalizeText(text);
    return /(\bgia\b|bao\s*nhieu|may\s*tien|\d+\s*(trieu|tr|k)\b|\d+\.\d+k\b)/.test(t)
      && /\b(hay|la|phai|dung|khong|ko|k)\b/.test(t);
  }

  function wantsShippingPrivacy(text) {
    const t = normalizeText(text);
    return /(bao\s*mat|kin\s*dao|goi\s*kin|dong\s*goi|lo\s*hang|ten\s*shop|noi\s*dung|nhay\s*cam|ship\s*co\s*kin)/.test(t);
  }

  function wantsPaymentInfo(text) {
    const t = normalizeText(text);
    return /(cod|thanh\s*toan|tra\s*tien|chuyen\s*khoan|ck|coc|dat\s*coc|nhan\s*hang\s*tra\s*tien)/.test(t);
  }

  function wantsDeliveryTime(text) {
    const t = normalizeText(text);
    return /(bao\s*lau|may\s*ngay|khi\s*nao|giao\s*hang|nhan\s*hang|thoi\s*gian|hang\s*dat|co\s*san|con\s*hang)/.test(t);
  }

  function wantsShippingFee(text) {
    const t = normalizeText(text);
    return /(phi\s*ship|tien\s*ship|ship\s*bao\s*nhieu|mien\s*ship|free\s*ship|freeship)/.test(t);
  }

  function wantsAgePolicy(text) {
    const t = normalizeText(text);
    return /(18\+|du\s*tuoi|bao\s*nhieu\s*tuoi|vi\s*thanh\s*nien|duoi\s*18|chua\s*18|\b1[0-7]\s*tuoi\b)/.test(t);
  }

  function isSimpleGreeting(text) {
    const t = normalizeText(text).trim();
    return /^(xin\s*)?(chao|hello|hi|alo|shop|em\s*oi|chi\s*oi|anh\s*oi)(\s+(shop|em|chi|anh|ban))?[.!?\s]*$/.test(t);
  }

  function isSimpleConfirmation(text) {
    const t = normalizeText(text).trim();
    return /^(ok|oke|oki|okay|uh|u|vang|da|duoc|chuan|dung|xac\s*nhan|dong\s*y|chot|len\s*don|gui\s*hang)(\s+(nhe|nha|a|shop|em))?[.!?\s]*$/.test(t);
  }

  function providesName(text) {
    const t = normalizeText(text);
    return /\b(minh|em|anh|chi|toi)\s*(ten|la)\s+[\p{L}\s]{2,40}$/u.test(t)
      || /\bten\s*(nguoi\s*nhan)?\s*(la|:)\s*[\p{L}\s]{2,40}/u.test(t);
  }

  function providesAddress(text) {
    const t = normalizeText(text);
    return /\b(dia\s*chi|dc|o|tai|giao\s*ve|ship\s*ve)\b/.test(t)
      || /(\b(xa|phuong|huyen|quan|tinh|thanh\s*pho|tp)\b|[-,].+[-,])/.test(t);
  }

  function wantsReturnPolicy(text) {
    const t = normalizeText(text);
    return /(doi\s*tra|bao\s*hanh|\bloi\b|\bhong\b|kiem\s*hang|kiem\s*tra|mo\s*hang|tra\s*hang|hoan\s*tien)/.test(t);
  }

  function wantsComparison(text) {
    const t = normalizeText(text);
    return /(so\s*sanh|khac\s*nhau|hon\s*gi|nen\s*chon|chon\s*mau\s*nao|mau\s*nao\s*hon)/.test(t);
  }

  function wantsRecommendation(text) {
    const t = normalizeText(text);
    return /(tu\s*van|goi\s*y|nen\s*mua|nen\s*lay|chon\s*mau|mau\s*nao|loai\s*nao|phu\s*hop|ngan\s*sach)/.test(t);
  }

  function wantsSizeInfo(text) {
    const t = normalizeText(text);
    return /(kich\s*thuoc|size|nang|can\s*nang|bao\s*to|to\s*khong)/.test(t);
  }

  function wantsGiftInfo(text) {
    const t = normalizeText(text);
    return /(tang|qua|gel\s*tang|kem\s*theo|combo)/.test(t);
  }

  function wantsFitInfo(text) {
    const t = normalizeText(text);
    return /(khit|chat|om|rong|co\s*gian|mem|that\s*khong|giong\s*that)/.test(t);
  }

  function wantsCleaningInfo(text) {
    const t = normalizeText(text);
    return /(ve\s*sinh|rua|lam\s*sach|giat|khu\s*mui|bao\s*quan|co\s*rua\s*duoc)/.test(t);
  }

  function asksForOrderInfo(text) {
    const t = normalizeText(text);
    return /(dia\s*chi|sdt|so\s*dien\s*thoai|ten\s*nguoi\s*nhan|thong\s*tin\s*giao\s*hang|hoi\s*dia\s*chi)/.test(t);
  }

  function wantsFeatureAdvice(text) {
    const t = normalizeText(text);
    return /(rung|pin|sac|lam\s*am|buom|3\s*lo|ba\s*lo|silicon|mong|lon|to|nho\s*gon)/.test(t);
  }

  function wantsNewProducts(text) {
    const t = normalizeText(text);
    return /(hang|mau|san\s*pham).*(moi|cap\s*nhat|ve\s*them)/
      .test(t)
      || /(moi\s*ve|co\s*gi\s*moi)/.test(t);
  }

  function wantsStockInfo(text) {
    const t = normalizeText(text);
    return /(con\s*hang|het\s*hang|co\s*san|san\s*khong|con\s*khong|con\s*k|con\s*ko)/
      .test(t);
  }

  function wantsBestSeller(text) {
    const t = normalizeText(text);
    return /(ban\s*chay|hot|nhieu\s*nguoi\s*mua|mau\s*nao\s*duoc|mau\s*nao\s*ok|nen\s*lay\s*mau\s*nao)/
      .test(t);
  }

  function wantsDiscount(text) {
    const t = normalizeText(text);
    return /(giam|bot|fix|re\s*hon|uu\s*dai|khuyen\s*mai|sale|deal|gia\s*tot)/
      .test(t);
  }

  function wantsInspection(text) {
    const t = normalizeText(text);
    return /(kiem\s*hang|xem\s*hang|mo\s*hang|dong\s*kiem|duoc\s*xem|cho\s*xem)/
      .test(t);
  }

  function wantsCancelOrder(text) {
    const t = normalizeText(text);
    return /(huy|khong\s*lay|ko\s*lay|k\s*lay|thoi\s*khong|thoi\s*ko).*(don|hang|mua|lay|chot)?/
      .test(t);
  }

  function wantsChangeProduct(text) {
    const t = normalizeText(text);
    return /(doi|sua|chuyen).*(mau|ma|san\s*pham|sp)/
      .test(t);
  }

  function wantsOfficePickup(text) {
    const t = normalizeText(text);
    return /(qua\s*shop|den\s*shop|lay\s*truc\s*tiep|co\s*cua\s*hang|dia\s*chi\s*shop)/
      .test(t);
  }

  function buildDeterministicReply(userText, userId) {
    const t = normalizeText(userText);
    const requestedCodes = extractRequestedProductCodes(userText);
    const found = getMentionedProducts(userText);
    const keywordProduct = getKeywordProduct(userText);
    const orderDraft = getOrderDraft(userId);
    const draftProduct = orderDraft.productCode
      ? productByCode.get(String(orderDraft.productCode).toUpperCase())
      : null;
    const selectedProduct = found[0] || keywordProduct || getLastProduct(userId) || draftProduct;
    const orderProduct = found[0] || draftProduct || getLastProduct(userId);
    const wantsVibration = /\brung\b|co\s*pin|sac\s*pin/.test(t);
    const wantsLarge = /\bto\b|\blon\b|kich\s*thuoc\s*lon|size\s*lon/.test(t);
    const wantsPhoto = /\banh\b|\bhinh\b|\bxem\b|\bcoi\b|\bgui\b|\bmenu\b|\bdanh\s*sach\b/.test(t);
    const budgetMatch = t.match(/(?:ngan\s*sach\s*)?(\d{2,4})\s*k\b/);
    const budget = budgetMatch ? Number(budgetMatch[1]) : null;

    if (found.length) rememberLastProduct(userId, found[0]);

    const productAwareOrder = {
      ...orderDraft,
      productCode: orderProduct?.code || orderDraft.productCode || ''
    };
    const missingFields = missingOrderFields(productAwareOrder);

    if (rejectsOrderIntent(userText)) {
      return 'Dạ em hiểu ạ, mình cứ tham khảo thoải mái nhé. Khi nào muốn chốt mẫu nào thì nhắn em mã sản phẩm hoặc tên món là được ạ.';
    }

    if (wantsAddressChange(userText)) {
      if (!missingFields.length) {
        return 'Dạ được ạ, anh/chị gửi giúp em địa chỉ mới đầy đủ, shop sẽ cập nhật lại đơn cho mình nhé.';
      }
      return `Dạ được ạ, anh/chị gửi giúp em ${missingFields.join(' + ')} để shop cập nhật/xác nhận đơn nhé.`;
    }

    if (asksWhyRepeatedInfo(userText)) {
      if (!missingFields.length) {
        return `Dạ em xin lỗi vì đã hỏi lặp ạ. ${readyOrderReply(productAwareOrder, selectedProduct).replace(/^Dạ\s+em/i, 'Em')}`;
      }
      return `Dạ em xin lỗi vì đã hỏi lặp ạ. Em đang thiếu ${missingFields.join(' + ')} để shop xác nhận đơn giúp mình.`;
    }

    if (looksLikePhone(userText) && (providesName(userText) || providesAddress(userText))) {
      if (!missingFields.length) return readyOrderReply(productAwareOrder, selectedProduct);
      return `Dạ em đã nhận thông tin giao hàng rồi ạ. Anh/chị gửi thêm ${missingFields.join(' + ')} để shop xác nhận đơn nhé.`;
    }

    if (looksLikePhone(userText)) {
      if (!missingFields.length) return readyOrderReply(productAwareOrder, selectedProduct);
      return `Dạ em đã nhận SĐT của anh/chị rồi ạ. Anh/chị gửi thêm ${config.policies.orderInfoFields.replace('SĐT + ', '')} giúp em để ${config.shopName} xác nhận đơn nhé.`;
    }

    if (wantsAgePolicy(userText)) {
      return `Dạ sản phẩm bên ${config.shopName} chỉ tư vấn và bán cho khách từ đủ ${config.minAge} tuổi trở lên ạ. Nếu anh/chị đã đủ ${config.minAge} tuổi thì em hỗ trợ tư vấn bình thường nhé.`;
    }

    if (isSimpleGreeting(userText)) {
      return 'Dạ em chào anh/chị ạ. Anh/chị muốn xem danh sách sản phẩm, hỏi theo ngân sách, hay đang quan tâm mã nào để em tư vấn nhanh nhé.';
    }

    if (wantsCancelOrder(userText)) {
      return 'Dạ không sao ạ. Nếu mình chưa xác nhận với nhân viên thì shop chưa lên đơn đâu ạ. Khi nào muốn tham khảo hoặc chốt lại mẫu nào, anh/chị nhắn em mã sản phẩm là được nhé.';
    }

    if (wantsChangeProduct(userText)) {
      return 'Dạ đổi mẫu được ạ. Anh/chị nhắn giúp em mã sản phẩm muốn đổi sang, ví dụ MÃ8 hoặc MÃ13, em kiểm tra và báo lại giá/thông tin cho mình nhé.';
    }

    if (providesName(userText) || providesAddress(userText)) {
      if (!missingFields.length) return readyOrderReply(productAwareOrder, selectedProduct);
      if (selectedProduct) {
        return `Dạ em nhận thông tin rồi ạ. Để chốt ${selectedProduct.code}, anh/chị gửi thêm ${missingFields.join(' + ')} để shop xác nhận đơn và giao hàng nhé.`;
      }
      return 'Dạ em nhận thông tin rồi ạ. Anh/chị chọn giúp em mã sản phẩm muốn lấy, hoặc nhắn “menu” để em gửi danh sách sản phẩm nhé.';
    }

    if (requestedCodes.length && !found.length) {
      return `Dạ hiện shop chưa có ${requestedCodes.join(', ')} trong danh sách ạ. Anh/chị xem menu rồi chọn mã khác giúp em nhé, hoặc cho em biết ngân sách/nhu cầu để em gợi ý mẫu gần nhất.`;
    }

    if (wantsMenuImages(userText) && !found.length) {
      return 'Dạ em gửi menu ảnh sản phẩm cho anh/chị rồi ạ. Anh/chị xem mẫu nào ưng thì nhắn mã (ví dụ MÃ8 hoặc ma8), em báo giá và tư vấn nhanh hơn nhé.';
    }

    if (wantsNewProducts(userText)) {
      return 'Dạ hiện shop tư vấn theo danh sách menu đang có ạ. Nếu có mẫu mới shop sẽ cập nhật thêm vào menu; anh/chị muốn xem lại danh sách hiện tại thì em gửi ảnh menu cho mình tham khảo nhé.';
    }

    if (wantsStockInfo(userText)) {
      if (selectedProduct) {
        return `Dạ ${selectedProduct.code} ${selectedProduct.preorder ? `là hàng đặt, thời gian khoảng ${config.policies.preorderDays}` : 'shop đang tư vấn/chốt theo danh sách hiện tại'} ạ. Trước khi gửi hàng shop sẽ xác nhận lại đơn cho mình nhé.`;
      }
      return 'Dạ anh/chị nhắn giúp em mã sản phẩm muốn hỏi còn hàng, ví dụ MÃ8 hoặc MÃ13, em kiểm tra và báo đúng mẫu cho mình ạ.';
    }

    if (wantsBestSeller(userText)) {
      const options = [
        ...recommendationProducts('premium').slice(0, 2),
        ...recommendationProducts('budget').slice(0, 1)
      ];
      const unique = [...new Map(options.map(p => [p.code, p])).values()];
      const lines = unique.map(p => `${p.code} giá ${p.price}`).join(', ');
      return `Dạ các mẫu dễ tư vấn/bán chạy bên shop thường là ${lines || 'MÃ8, MÃ2 và MÃ10'} ạ. Nếu anh/chị cho em ngân sách hoặc thích nhỏ gọn/có rung/kích thước lớn, em lọc đúng mẫu hơn nhé.`;
    }

    if (asksForOrderInfo(userText)) {
      const productText = selectedProduct ? ` ${selectedProduct.code}` : '';
      return `Dạ có ạ, để chốt đơn${productText} anh/chị gửi giúp em ${config.policies.orderInfoFields} nhé. Shop sẽ xác nhận lại đơn trước khi giao.`;
    }

    // Chốt đơn là intent quan trọng nhất: xử lý trước rule báo thông tin sản phẩm.
    if (isOrderIntent(userText)) {
      const product = selectedProduct;
      if (!product) {
        return 'Dạ anh/chị muốn chốt mẫu nào thì nhắn giúp em mã sản phẩm nhé, ví dụ MÃ8 hoặc MÃ13. Em sẽ xác nhận giá rồi xin thông tin giao hàng ạ.';
      }
      return `Dạ em chốt ${product.code} giá ${explainPrice(product.price)} cho anh/chị nhé. Anh/chị gửi giúp em ${config.policies.orderInfoFields} ạ. Hàng được ${config.policies.privacy}.`;
    }

    if (isPriceClarification(userText) && selectedProduct) {
      return `Dạ ${selectedProduct.code} giá ${explainPrice(selectedProduct.price)} ạ. Mẫu này ${selectedProduct.preorder ? `là hàng đặt ${config.policies.preorderDays}` : 'shop đang tư vấn/chốt theo chính sách hiện tại'}${selectedProduct.gift ? `, tặng ${selectedProduct.gift}` : ''}.`;
    }

    if ((wantsComparison(userText) && found.length >= 2) || found.length >= 2) {
      const lines = found.slice(0, 3).map(formatComparisonLine).join('\n');
      return `Dạ em so sánh nhanh cho anh/chị nhé:\n${lines}\nNếu ưu tiên tiết kiệm thì chọn mẫu giá thấp hơn; nếu muốn trải nghiệm thật/to hơn thì chọn mẫu kích thước lớn hơn ạ.`;
    }

    if (wantsShippingPrivacy(userText)) {
      return `Dạ ${config.shopName} ${config.policies.privacy}. Thông tin đơn chỉ dùng để giao hàng, anh/chị yên tâm về bảo mật ạ.`;
    }

    if (wantsInspection(userText)) {
      return 'Dạ vì sản phẩm cá nhân/nhạy cảm nên shop cần đóng gói kín. Khi nhận hàng anh/chị kiểm tra tình trạng gói hàng bên ngoài giúp shop; nếu có vấn đề, mình chụp ảnh/quay video để nhân viên hỗ trợ nhanh ạ.';
    }

    if (wantsShippingFee(userText)) {
      const fee = config.policies.freeShipping ? 'miễn ship tất cả sản phẩm' : 'sẽ báo phí ship theo địa chỉ';
      return `Dạ ${config.shopName} ${fee} ạ. Anh/chị chỉ cần gửi mẫu muốn lấy + ${config.policies.orderInfoFields}, shop xác nhận đơn rồi giao kín cho mình.`;
    }

    if (wantsDiscount(userText)) {
      return `Dạ giá shop đang để theo menu và ${config.policies.freeShipping ? 'đã miễn ship' : 'sẽ báo ship theo địa chỉ'} ạ. Nếu anh/chị lấy thêm gel hoặc chốt nhiều món, nhân viên sẽ kiểm tra hỗ trợ mức tốt nhất trước khi lên đơn nhé.`;
    }

    if (wantsOfficePickup(userText)) {
      return 'Dạ shop ưu tiên giao kín theo đơn để bảo mật thông tin cho mình ạ. Anh/chị gửi mẫu muốn lấy + thông tin nhận hàng, nhân viên sẽ xác nhận lại trước khi gửi nhé.';
    }

    if (wantsPaymentInfo(userText)) {
      if (selectedProduct?.preorder) {
        return `Dạ ${selectedProduct.code} là hàng đặt nên cần đặt cọc trước, phần còn lại shop sẽ xác nhận khi giao/nhận hàng ạ. Shop cũng hỗ trợ chuyển khoản theo thông tin nhân viên gửi.`;
      }
      return `Dạ ${config.shopName} hỗ trợ ${config.policies.payment} ạ. Với hàng đặt riêng thì cần đặt cọc trước, shop sẽ xác nhận rõ trước khi lên đơn.`;
    }

    if (wantsDeliveryTime(userText)) {
      if (selectedProduct?.preorder) {
        return `Dạ ${selectedProduct.code} là hàng đặt, thời gian về/giao khoảng ${config.policies.preorderDays} ạ. Nếu anh/chị muốn mẫu có thể chốt nhanh hơn thì em gợi ý các mẫu không phải hàng đặt nhé.`;
      }
      return 'Dạ các mẫu không ghi hàng đặt thì shop tư vấn/chốt theo danh sách hiện tại. Thời gian giao cụ thể tùy khu vực, khi anh/chị gửi địa chỉ shop sẽ xác nhận lại trước khi lên đơn ạ.';
    }

    if (wantsReturnPolicy(userText)) {
      return 'Dạ vì đây là sản phẩm cá nhân/nhạy cảm nên shop cần nhân viên xác nhận kỹ tình trạng đơn trước khi đổi trả hoặc xử lý lỗi. Anh/chị giữ nguyên hình ảnh/video nhận hàng nếu có vấn đề để shop hỗ trợ nhanh ạ.';
    }

    if (wantsSizeInfo(userText) && selectedProduct) {
      return `Dạ ${selectedProduct.code} có size ${selectedProduct.size || 'shop sẽ xác nhận thêm'}${selectedProduct.weight ? `, nặng khoảng ${selectedProduct.weight}` : ''}. ${selectedProduct.description}.`;
    }

    if (wantsProductImage(userText) && selectedProduct) {
      return `Dạ em gửi ảnh ${selectedProduct.code} cho anh/chị tham khảo nhé. ${compactProductName(selectedProduct)}, anh/chị muốn chốt thì gửi giúp em ${config.policies.orderInfoFields} ạ.`;
    }

    if (wantsGiftInfo(userText) && selectedProduct) {
      return `Dạ ${compactProductName(selectedProduct)}${selectedProduct.gift ? ` được tặng ${selectedProduct.gift}` : ' hiện chưa có quà tặng ghi riêng trong danh sách'} ạ. Shop vẫn miễn ship và gói kín cho mình nhé.`;
    }

    if (wantsFitInfo(userText) && selectedProduct) {
      return `Dạ ${selectedProduct.code} chất liệu mềm và thiết kế ôm/khít theo mô tả sản phẩm ạ. Khi dùng anh/chị có thể dùng thêm gel bôi trơn để thoải mái hơn, shop có gel nếu mình cần kèm theo nhé.`;
    }

    if (wantsCleaningInfo(userText) && selectedProduct) {
      return `Dạ vệ sinh được ạ. Sau khi dùng anh/chị rửa nhẹ bằng nước sạch hoặc dung dịch vệ sinh chuyên dụng, lau khô rồi để nơi thoáng mát; tránh ngâm phần pin/sạc nếu mẫu có điện ạ.`;
    }

    if (found.length) {
      const lines = found.slice(0, 3).map(formatProductLine).join('\n');
      return `Dạ em gửi thông tin nhanh cho anh/chị nhé:\n${lines}\n${wantsPhoto ? 'Em cũng gửi ảnh mẫu kèm theo rồi ạ.' : 'Anh/chị muốn xem ảnh hoặc chốt mẫu nào thì nhắn em mã đó nhé.'}`;
    }

    if (wantsKeywordImage(userText, 'gel')) {
      return 'Dạ shop có Gel bôi trơn 150k/chai 200ml, mua gel được tặng thêm 5 gói gel nhỏ ạ. Em gửi ảnh kèm theo rồi nhé.';
    }

    if (wantsMenuImages(userText)) {
      return 'Dạ em gửi menu ảnh sản phẩm cho anh/chị rồi ạ. Anh/chị xem mẫu nào ưng thì nhắn mã (ví dụ MÃ8 hoặc ma8), em báo giá và tư vấn nhanh hơn nhé.';
    }

    if (budget) {
      const options = selectProductsByBudget(budget).slice(0, 3);
      if (budget <= 200 && (wantsVibration || wantsLarge)) {
        return 'Dạ với ngân sách khoảng 200k thì shop chưa có mẫu vừa to vừa có rung ạ. Gần nhất là MÃ10 giá 150k, nhỏ gọn nhưng không rung. Nếu anh/chị muốn có rung thì nên lên MÃ2 giá 300k, nhỏ gọn và có pin/rung.';
      }
      if (options.length) {
        const lines = options.map(formatProductLine).join('\n');
        return `Dạ trong ngân sách khoảng ${budget}k, anh/chị có thể tham khảo:\n${lines}\nAnh/chị thích nhỏ gọn, có rung, hay kích thước lớn hơn để em lọc tiếp ạ?`;
      }
      return `Dạ ngân sách khoảng ${budget}k thì shop chưa có mẫu phù hợp trong danh sách hiện tại ạ. Anh/chị có thể tăng ngân sách hoặc xem MÃ10 giá 150k nếu muốn mẫu tiết kiệm.`;
    }

    if (wantsVibration) {
      const options = recommendationProducts('vibration').map(p => `${p.code} giá ${p.price}`).join(' và ');
      return `Dạ nếu anh/chị ưu tiên có rung/có pin thì shop có ${options || 'một số mẫu có rung'}. Anh/chị muốn xem ảnh mẫu nào ạ?`;
    }

    if (wantsFeatureAdvice(userText) || wantsLarge || wantsRecommendation(userText)) {
      if (wantsLarge) {
        const options = recommendationProducts('large').map(p => `${p.code} giá ${p.price}${p.preorder ? ' hàng đặt' : ''}`).join(', ');
        return `Dạ nếu anh/chị thích mẫu kích thước lớn/trải nghiệm thật hơn thì có ${options}. Anh/chị muốn tầm giá nào để em tư vấn sát hơn ạ?`;
      }
      return 'Dạ em gợi ý nhanh: tiết kiệm thì MÃ10 150k, có rung nhỏ gọn thì MÃ2 300k, cao cấp có sạc/làm ấm thì MÃ8 680k, kích thước lớn hơn thì MÃ9/MÃ12/MÃ13. Anh/chị muốn theo ngân sách nào ạ?';
    }

    return null;
  }

  function buildFallbackReply(userText, userId = '') {
    const deterministic = buildDeterministicReply(userText, userId);
    if (deterministic) return deterministic;
    return config.fallbackReply;
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
    wantsKeywordImage,
    wantsMenuImages,
    wantsProductImage
  };
}

module.exports = {
  createRuleEngine,
  explainPrice,
  extractPhone,
  extractRequestedProductCodes,
  looksLikePhone,
  normalizeText
};
