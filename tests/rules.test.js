const { describe, it, expect } = require('./harness');
const path = require('path');
const { loadProducts } = require('../core/products');
const shopConfig = require('../shops/adult-shop/config');
const { createRuleEngine, STATES, detectors } = require('../core/rules');

const products = loadProducts(path.join(__dirname, '..', 'shops', 'adult-shop', 'products.csv'));

// Mock contextStore (đầy đủ giống storage.js)
function makeStore() {
  const data = new Map();
  return {
    _data: data,
    getLastProductCode: id => data.get(id)?.lastProductCode || '',
    setLastProductCode: (id, code) => {
      const v = data.get(id) || {};
      v.lastProductCode = code;
      data.set(id, v);
    },
    getOrderDraft: id => ({ ...(data.get(id)?.orderDraft || {}) }),
    mergeOrderDraft(id, details) {
      const v = data.get(id) || {};
      v.orderDraft = { ...(v.orderDraft || {}), ...details };
      data.set(id, v);
      return { ...v.orderDraft };
    },
    getSessionState: id => data.get(id)?.sessionState || '',
    setSessionState: (id, s) => {
      const v = data.get(id) || {};
      if (s) v.sessionState = s;
      else delete v.sessionState;
      data.set(id, v);
    },
    clearOrderDraft: id => {
      const v = data.get(id) || {};
      delete v.orderDraft;
      delete v.sessionState;
      data.set(id, v);
    }
  };
}

describe('detectors: BUG FIX wantsCancelOrder', () => {
  it('TRUE với "thôi không lấy nữa"', () => {
    expect(detectors.wantsCancelOrder('thôi không lấy nữa')).toBeTrue();
  });
  it('TRUE với "hủy đơn"', () => {
    expect(detectors.wantsCancelOrder('hủy đơn cho mình')).toBeTrue();
  });
  it('TRUE với "không chốt nữa"', () => {
    expect(detectors.wantsCancelOrder('không chốt nữa shop ơi')).toBeTrue();
  });
  it('FALSE với "thôi không sao đâu" (BUG cũ)', () => {
    expect(detectors.wantsCancelOrder('thôi không sao đâu shop')).toBeFalse();
  });
  it('FALSE với "không hiểu"', () => {
    expect(detectors.wantsCancelOrder('không hiểu shop nói gì')).toBeFalse();
  });
});

describe('detectors: BUG FIX wantsHuman dùng preprocess', () => {
  it('TRUE với "nhân viên" (có dấu)', () => {
    expect(detectors.wantsHuman('cho mình gặp nhân viên')).toBeTrue();
  });
  it('TRUE với "nhan vien" (không dấu — BUG cũ miss)', () => {
    expect(detectors.wantsHuman('cho gap nhan vien tu van')).toBeTrue();
  });
  it('TRUE với "tu van vien"', () => {
    expect(detectors.wantsHuman('chuyen tu van vien giup em')).toBeTrue();
  });
  it('FALSE với câu thường', () => {
    expect(detectors.wantsHuman('cho mình xem MÃ8')).toBeFalse();
  });
});

describe('detectors: BUG FIX substring trong chốt / tôi', () => {
  it('wantsBestSeller FALSE với "chốt đi" ("hot" trong "chot" — BUG cũ)', () => {
    expect(detectors.wantsBestSeller('chốt đi')).toBeFalse();
  });
  it('wantsBestSeller TRUE với từ "hot" độc lập', () => {
    expect(detectors.wantsBestSeller('shop có mẫu hot không')).toBeTrue();
  });
  it('wantsFeatureAdvice FALSE với "tôi chốt mã 3" ("to" trong "toi" — BUG cũ)', () => {
    expect(detectors.wantsFeatureAdvice('tôi chốt mã 3')).toBeFalse();
  });
  it('wantsFeatureAdvice TRUE với "mẫu to không"', () => {
    expect(detectors.wantsFeatureAdvice('mẫu to không shop')).toBeTrue();
  });
});

describe('detectors: BUG FIX isPriceClarification', () => {
  it('TRUE với "MÃ8 bao nhiêu vậy?"', () => {
    expect(detectors.isPriceClarification('MÃ8 bao nhiêu vậy?')).toBeTrue();
  });
  it('TRUE với "giá nhiêu"', () => {
    expect(detectors.isPriceClarification('giá nhiêu shop')).toBeTrue();
  });
  it('FALSE khi chỉ nhắc mã + giá, không hỏi xác nhận', () => {
    expect(detectors.isPriceClarification('MÃ8 300k')).toBeFalse();
  });
  it('TRUE khi nhắc giá kèm marker hỏi/xác nhận', () => {
    expect(detectors.isPriceClarification('MÃ8 là 300k hả shop?')).toBeTrue();
  });
});

describe('detectors: wantsAddressChange (BUG FIX)', () => {
  it('TRUE với "đổi địa chỉ"', () => {
    expect(detectors.wantsAddressChange('đổi địa chỉ giúp em')).toBeTrue();
  });
  it('TRUE với "đổi giúp em sang phường 5" (BUG cũ miss)', () => {
    expect(detectors.wantsAddressChange('đổi giúp em sang phường 5 quận 3')).toBeTrue();
  });
});

describe('Engine: intent router cơ bản', () => {
  const engine = createRuleEngine({
    products,
    config: shopConfig,
    contextStore: makeStore()
  });

  it('GREETING', () => {
    expect(engine.buildDeterministicReply('em chào shop', 'u1')).toContain('chào');
  });
  it('PRODUCT_LIST khi user gõ mã', () => {
    expect(engine.buildDeterministicReply('m8 còn không', 'u2')).toContain('MÃ8');
  });
  it('ORDER_INTENT trả về giá', () => {
    expect(engine.buildDeterministicReply('chốt MÃ8', 'u3')).toContain('680k');
  });
  it('"chốt đi" không trigger BEST_SELLER (BUG: hot trong chot)', () => {
    const store = makeStore();
    store.setLastProductCode('u_chot', 'MÃ10');
    const eng = createRuleEngine({ products, config: shopConfig, contextStore: store });
    const r = eng.buildDeterministicReply('chốt đi', 'u_chot');
    expect(r).toContain('MÃ10');
    expect(r).toContain('150k');
    expect(r.includes('bán chạy')).toBe(false);
  });
  it('"tôi chốt mã 3" → ORDER_INTENT MÃ3, không BEST_SELLER', () => {
    const reply = engine.buildDeterministicReply('tôi chốt mã 3 nhé', 'u_ct3');
    expect(reply).toContain('MÃ3');
    expect(reply).toContain('300k');
    expect(reply.includes('bán chạy')).toBe(false);
  });
  it('"loại 150k thế nào" → BUDGET, không PRICE mã last', () => {
    const store = makeStore();
    store.setLastProductCode('u_150', 'MÃ3');
    const eng = createRuleEngine({ products, config: shopConfig, contextStore: store });
    const r = eng.buildDeterministicReply('loại 150k thế nào vậy shop', 'u_150');
    expect(r).toContain('150');
    expect(r).toContain('MÃ10');
    expect(/^Dạ trong ngân sách khoảng 150k/m.test(String(r))).toBe(true);
  });
  it('PRODUCT_NOT_FOUND khi mã ngoài menu', () => {
    expect(engine.buildDeterministicReply('cho xem MÃ99', 'u4')).toContain('MÃ99');
  });
  it('không coi "MÃ8 300k" là PRICE_CLARIFICATION', () => {
    const reply = engine.buildDeterministicReply('MÃ8 300k', 'u_price_mention');
    expect(reply).toContain('em gửi thông tin nhanh');
    expect(reply.includes('giá 680k')).toBeFalse();
  });
});

describe('Engine: state machine 5 trạng thái', () => {
  const store = makeStore();
  const engine = createRuleEngine({ products, config: shopConfig, contextStore: store });
  const u = 'u_state';

  it('IDLE ban đầu', () => {
    expect(engine.deriveSessionState(u)).toBe(STATES.IDLE);
  });
  it('PRODUCT_SELECTED sau khi nhắc mã', () => {
    engine.buildDeterministicReply('cho xem ma 8', u);
    expect(engine.deriveSessionState(u)).toBe(STATES.PRODUCT_SELECTED);
  });
  it('COLLECTING_INFO khi có tên + sđt', () => {
    store.mergeOrderDraft(u, { name: 'An', phone: '0987654321' });
    expect(engine.deriveSessionState(u)).toBe(STATES.COLLECTING_INFO);
  });
  it('READY_TO_CONFIRM khi đủ 3 trường', () => {
    store.mergeOrderDraft(u, { address: '12 Trần Phú, Hà Nội', productCode: 'MÃ8' });
    expect(engine.deriveSessionState(u)).toBe(STATES.READY_TO_CONFIRM);
  });
  it('shouldSilenceAfterCompleteOrder = true với "ok"', () => {
    expect(engine.shouldSilenceAfterCompleteOrder('ok shop', u)).toBeTrue();
  });
  it('CONFIRMED sau khi user "ok"', () => {
    expect(engine.deriveSessionState(u)).toBe(STATES.CONFIRMED);
  });
  it('CANCEL_ORDER hạ về IDLE/PRODUCT_SELECTED', () => {
    engine.buildDeterministicReply('thôi không lấy nữa', u);
    const s = engine.deriveSessionState(u);
    expect(s === STATES.IDLE || s === STATES.PRODUCT_SELECTED).toBeTrue();
    const draft = store.getOrderDraft(u);
    expect(!draft.name && !draft.phone && !draft.address).toBeTrue();
  });
});

describe('Engine: BUG FIX user hỏi địa chỉ shop không bị nhầm là cung cấp địa chỉ', () => {
  const engine = createRuleEngine({
    products,
    config: shopConfig,
    contextStore: makeStore()
  });

  it('Câu "địa chỉ shop ở đâu?" KHÔNG trigger PROVIDES_NAME_OR_ADDRESS', () => {
    const reply = engine.buildDeterministicReply('địa chỉ shop ở đâu vậy?', 'u_addr_q');
    // Reply nên là OFFICE_PICKUP hoặc null/khác — KHÔNG được là "em nhận thông tin rồi".
    if (reply) {
      expect(reply).notToBe('Dạ em nhận thông tin rồi ạ. Anh/chị chọn giúp em mã sản phẩm muốn lấy, hoặc nhắn "menu" để em gửi danh sách sản phẩm nhé.');
    }
  });
});

describe('Engine: config-driven intent disable', () => {
  const customConfig = {
    ...shopConfig,
    intents: { disabled: ['AGE_POLICY', 'GREETING'] }
  };
  const engine = createRuleEngine({
    products,
    config: customConfig,
    contextStore: makeStore()
  });

  it('GREETING bị tắt -> không match câu chào', () => {
    const reply = engine.buildDeterministicReply('em chào shop', 'u_disabled');
    // Có thể null hoặc match rule khác, nhưng không phải template greeting.
    if (reply) {
      expect(reply.includes('xem danh sách sản phẩm') ? 'KHÔNG match GREETING' : 'OK').toBe('OK');
    }
  });
  it('AGE_POLICY bị tắt -> không reply về tuổi', () => {
    const reply = engine.buildDeterministicReply('em 16 tuổi mua được không', 'u_age');
    if (reply) {
      expect(/từ đủ \d+ tuổi/i.test(reply)).toBeFalse();
    }
  });
});

describe('Engine: config-driven custom intent (prepend)', () => {
  const customConfig = {
    ...shopConfig,
    templates: {
      ...((shopConfig && shopConfig.templates) || {}),
      voucherInfo: 'Voucher hôm nay: GIAM10K, dùng được cho đơn từ 200k.'
    },
    intents: {
      prepend: [
        {
          name: 'VOUCHER',
          match: ctx => /voucher|ma giam|coupon/.test(ctx.normalized),
          handle: ctx => ctx.render('voucherInfo')
        }
      ]
    }
  };
  const engine = createRuleEngine({
    products,
    config: customConfig,
    contextStore: makeStore()
  });

  it('Custom intent VOUCHER được trigger', () => {
    const reply = engine.buildDeterministicReply('shop có voucher gì không', 'u_v');
    expect(reply).toContain('Voucher hôm nay');
  });
});

describe('Engine: template override per-shop', () => {
  const customConfig = {
    ...shopConfig,
    templates: {
      ...((shopConfig && shopConfig.templates) || {}),
      greeting: 'Chào bạn 🌸 Mình là trợ lý của {{shopName}}.'
    }
  };
  const engine = createRuleEngine({
    products,
    config: customConfig,
    contextStore: makeStore()
  });

  it('Template "greeting" đã được override', () => {
    const reply = engine.buildDeterministicReply('chào shop', 'u_o');
    expect(reply).toContain('🌸');
  });
});

describe('Engine: backward-compat exports', () => {
  const m = require('../core/rules');
  it('createRuleEngine là function', () => {
    expect(typeof m.createRuleEngine).toBe('function');
  });
  it('STATES có 5 trạng thái', () => {
    expect(Object.keys(m.STATES).length).toBe(5);
  });
  it('detectors object expose các hàm wants*', () => {
    expect(typeof m.detectors.wantsCancelOrder).toBe('function');
    expect(typeof m.detectors.wantsHuman).toBe('function');
  });
});
