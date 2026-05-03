const { preprocess } = require('../../core/nlp');

/**
 * Logic đặc thù xưởng nem: bảo quản, mua sỉ / lẻ.
 */
module.exports = {
  prepend: [
    {
      name: 'NEM_STORAGE',
      match: ctx =>
        /(bao\s*quan|cat\s*tu\s*lanh|de\s*duoc\s*bao\s*lau|hu\s*ong\s*gi)/.test(preprocess(ctx.text)),
      handle: () =>
        'Dạ nem nên bảo quản lạnh 2–4°C và dùng trong vài ngày tùy loại ạ. Anh/chị nhắn em đang hỏi nem nào (Nem Bùi / Nem Tai / Nem Chua) để em hướng dẫn cụ thể hơn nhé.'
    },
    {
      name: 'NEM_WHOLESALE',
      match: ctx =>
        /\b(mua\s*si|ban\s*si|so\s*luong\s*lon|cong\s*no|dai\s*ly)\b/.test(preprocess(ctx.text)),
      handle: ctx =>
        'Dạ đơn sỉ anh/chị nhắn giúp em số lượng dự kiến và khu vực, nhân viên xưởng sẽ báo giá theo cấp sỉ ạ.'
    },
    {
      name: 'NEM_RETAIL',
      match: ctx =>
        /\b(mua\s*le|lay\s*le|an\s*thu|it\s*it)\b/.test(preprocess(ctx.text)),
      handle: ctx =>
        'Dạ lẻ vẫn giao được ạ. Anh/chị chọn nem trong menu hoặc nhắn combo, em báo giá và thời gian giao.'
    }
  ]
};
