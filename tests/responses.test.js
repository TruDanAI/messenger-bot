const { describe, it, expect } = require('./harness');
const { renderTemplate, render, TEMPLATES, HELPERS } = require('../core/responses');

describe('renderTemplate basic', () => {
  it('thay biến đơn', () => {
    expect(renderTemplate('Xin chào {{name}}!', { name: 'An' })).toBe('Xin chào An!');
  });
  it('biến lồng a.b', () => {
    expect(renderTemplate('Shop {{cfg.name}}', { cfg: { name: 'X' } })).toBe('Shop X');
  });
  it('biến thiếu -> chuỗi rỗng', () => {
    expect(renderTemplate('Hi {{x}}', {})).toBe('Hi ');
  });
  it('không có biến giữ nguyên', () => {
    expect(renderTemplate('plain', {})).toBe('plain');
  });
});

describe('renderTemplate helpers', () => {
  it('upper', () => {
    expect(renderTemplate('{{name | upper}}', { name: 'an' })).toBe('AN');
  });
  it('lower', () => {
    expect(renderTemplate('{{name | lower}}', { name: 'AN' })).toBe('an');
  });
  it('capitalize', () => {
    expect(renderTemplate('{{name | capitalize}}', { name: 'anh' })).toBe('Anh');
  });
  it('default fallback', () => {
    expect(renderTemplate("{{x | default:'N/A'}}", {})).toBe('N/A');
    expect(renderTemplate("{{x | default:'N/A'}}", { x: 'có giá trị' })).toBe('có giá trị');
  });
  it('vnd format từ "300k"', () => {
    expect(renderTemplate('{{p | vnd}}', { p: '300k' })).toBe('300.000đ');
  });
  it('vnd format từ "2.180k"', () => {
    expect(renderTemplate('{{p | vnd}}', { p: '2.180k' })).toBe('2.180.000đ');
  });
  it('chain helper: lower -> capitalize', () => {
    expect(renderTemplate('{{n | lower | capitalize}}', { n: 'NGUYỄN' })).toBe('Nguyễn');
  });
});

describe('render shortcut', () => {
  it('có template "greeting"', () => {
    const out = render('greeting', { shopName: 'Shop X' });
    expect(out).toContain('Shop X');
  });
  it('warn khi template không tồn tại', () => {
    expect(render('not_exist')).toBe('');
  });
});

describe('TEMPLATES coverage', () => {
  const required = [
    'greeting', 'rejectOrder', 'cancelOrder', 'changeProduct',
    'readyOrder', 'addressChangeReady', 'addressChangeMissing',
    'apologyRepeatedReady', 'apologyRepeatedMissing',
    'phoneWithLeadMissing', 'phoneOnlyMissing',
    'infoMissingWithProduct', 'infoMissingNoProduct',
    'orderInfoRequest', 'orderIntentNoProduct', 'orderIntentWithProduct',
    'productNotFound', 'priceClarification', 'comparison', 'productList',
    'menuSent', 'productImage', 'gelInfo', 'newProducts',
    'stockInfoSelected', 'stockInfoUnknown', 'bestSeller',
    'sizeInfo', 'giftInfo', 'fitInfo', 'cleaningInfo',
    'agePolicy', 'shippingPrivacy', 'inspection', 'shippingFee',
    'discount', 'officePickup', 'paymentPreorder', 'paymentDefault',
    'deliveryPreorder', 'deliveryDefault', 'returnPolicy',
    'budgetTightCustom', 'budgetOptions', 'budgetNoOptions',
    'vibrationOptions', 'largeOptions', 'featureAdviceDefault',
    'humanHandoff', 'systemBusy'
  ];
  for (const k of required) {
    it(`có template "${k}"`, () => {
      expect(typeof TEMPLATES[k]).toBe('string');
      expect(TEMPLATES[k].length > 0).toBeTrue();
    });
  }
});
