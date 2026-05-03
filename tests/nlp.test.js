const { describe, it, expect } = require('./harness');
const nlp = require('../core/nlp');

describe('nlp.normalizeText', () => {
  it('bỏ dấu và lowercase', () => {
    expect(nlp.normalizeText('CHÀO Anh!')).toBe('chao anh!');
  });
  it('đổi đ -> d', () => {
    expect(nlp.normalizeText('Đại Đoàn')).toBe('dai doan');
  });
});

describe('nlp.preprocess (slang)', () => {
  it('dc -> dia chi', () => {
    expect(nlp.preprocess('cho mình dc nhé')).toBe('cho minh dia chi nhe');
  });
  it('sdt -> so dien thoai', () => {
    expect(nlp.preprocess('sdt mình là 0987')).toBe('so dien thoai minh la 0987');
  });
  it('ko -> khong', () => {
    expect(nlp.preprocess('ko lay nua')).toBe('khong lay nua');
  });
  it('"k lay" được gán không', () => {
    expect(nlp.preprocess('k lay nua')).toBe('khong lay nua');
  });
  it('"k" giữ nguyên khi không có context', () => {
    // VD "300k" — k là đơn vị tiền, KHÔNG được đổi thành "không".
    expect(nlp.preprocess('mình có 300k')).toContain('300k');
  });
  it('canh -> nghin', () => {
    expect(nlp.preprocess('300 cành')).toBe('300 nghin');
  });
});

describe('nlp.looksLikePhone / extractPhone', () => {
  it('SĐT 0xxxxxxxxx được nhận', () => {
    expect(nlp.looksLikePhone('mình 0987654321')).toBeTrue();
  });
  it('SĐT +84xxxxxxxxx được nhận', () => {
    expect(nlp.looksLikePhone('SĐT +84987654321')).toBeTrue();
  });
  it('chuỗi không phải số đt -> false', () => {
    expect(nlp.looksLikePhone('123')).toBeFalse();
  });
  it('extractPhone trả về số đt đầu tiên', () => {
    expect(nlp.extractPhone('contact 0987654321 hoặc 0123456789')).toBe('0987654321');
  });
});

describe('nlp.levenshtein', () => {
  it('khoảng cách 0 với chuỗi giống', () => {
    expect(nlp.levenshtein('abc', 'abc')).toBe(0);
  });
  it('khoảng cách 1 với insert/delete', () => {
    expect(nlp.levenshtein('abc', 'abcd')).toBe(1);
  });
  it('khoảng cách đúng cho m8 vs ma8', () => {
    expect(nlp.levenshtein('m8', 'ma8')).toBe(1);
  });
});

describe('nlp.extractRequestedProductCodes', () => {
  const known = ['MÃ1', 'MÃ2', 'MÃ8', 'MÃ12', 'MÃ13'];

  it('regex chuẩn "ma 8"', () => {
    expect(nlp.extractRequestedProductCodes('cho xem ma 8 nhé', known)).toContain('MÃ8');
  });
  it('teencode "m8"', () => {
    expect(nlp.extractRequestedProductCodes('m8 còn không', known)).toContain('MÃ8');
  });
  it('teencode "max 8"', () => {
    expect(nlp.extractRequestedProductCodes('max 8 giá', known)).toContain('MÃ8');
  });
  it('"sp 13"', () => {
    expect(nlp.extractRequestedProductCodes('sp 13 con khong', known)).toContain('MÃ13');
  });
  it('fuzzy "ma13"', () => {
    expect(nlp.extractRequestedProductCodes('cho coi ma13', known)).toContain('MÃ13');
  });
  it('không nhận nhầm SĐT', () => {
    expect(nlp.extractRequestedProductCodes('sdt 0987654321', known)).toEqual([]);
  });
  it('không nhận nhầm ngân sách "200k"', () => {
    expect(nlp.extractRequestedProductCodes('ngân sách 200k', known)).toEqual([]);
  });
});

describe('nlp.providesAddress (BUG FIX)', () => {
  it('TRUE khi user cung cấp địa chỉ', () => {
    expect(nlp.providesAddress('123 đường ABC, phường 5, quận 3')).toBeTrue();
  });
  it('FALSE khi user HỎI địa chỉ shop ("ở đâu?")', () => {
    expect(nlp.providesAddress('địa chỉ shop ở đâu?')).toBeFalse();
  });
  it('FALSE khi user hỏi "shop ở đâu"', () => {
    expect(nlp.providesAddress('shop ở đâu vậy ạ?')).toBeFalse();
  });
  it('TRUE với "Số 12 ngõ 5 đường Trần Phú"', () => {
    expect(nlp.providesAddress('số 12 ngõ 5 đường Trần Phú, Hà Nội')).toBeTrue();
  });
});

describe('nlp.providesName (BUG FIX: bỏ anchor $)', () => {
  it('TRUE khi tên ở giữa câu', () => {
    expect(nlp.providesName('em tên An Nguyễn, sđt 0987654321')).toBeTrue();
  });
  it('TRUE khi tên ở cuối', () => {
    expect(nlp.providesName('mình tên Hoàng')).toBeTrue();
  });
  it('FALSE với câu không có tên', () => {
    expect(nlp.providesName('giá MÃ8 bao nhiêu')).toBeFalse();
  });
});

describe('nlp.isQuestion', () => {
  it('TRUE khi có dấu ?', () => {
    expect(nlp.isQuestion('shop bán gì?')).toBeTrue();
  });
  it('TRUE với "ở đâu"', () => {
    expect(nlp.isQuestion('shop ở đâu')).toBeTrue();
  });
  it('FALSE với câu khẳng định', () => {
    expect(nlp.isQuestion('em tên An')).toBeFalse();
  });
});
