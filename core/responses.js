// Tách hoàn toàn "Văn bản" khỏi "Logic" — toàn bộ chuỗi trả lời được tập trung tại đây.
// Cú pháp template: dùng {{biến}} hoặc {{a.b.c}} cho object lồng nhau.
// Shop cụ thể có thể override template qua config.templates trong shops/<id>/config.js.

const TEMPLATES = {
  // ===== Chào / xác nhận / từ chối =====
  greeting: 'Dạ {{shopName}} chào anh/chị ạ! Mình đang tìm sản phẩm tầm giá bao nhiêu hoặc có yêu cầu gì cứ nhắn để em gửi mẫu phù hợp nhất bên em nhé.',
  rejectOrder: 'Dạ em hiểu ạ, mình cứ tham khảo thoải mái nhé. Khi nào muốn chốt mẫu nào thì nhắn em mã sản phẩm hoặc tên món là được ạ.',
  cancelOrder: 'Dạ không sao ạ. Nếu mình chưa xác nhận với nhân viên thì shop chưa lên đơn đâu ạ. Khi nào muốn tham khảo hoặc chốt lại mẫu nào, anh/chị nhắn em mã sản phẩm là được nhé.',
  changeProduct: 'Dạ đổi mẫu được ạ. Anh/chị nhắn giúp em mã sản phẩm muốn đổi sang, ví dụ {{codeExample1}} hoặc {{codeExample2}}, em kiểm tra và báo lại giá/thông tin cho mình nhé.',

  // ===== Đơn hàng =====
  readyOrder: 'Dạ em đã có đủ thông tin chốt {{productText}}: {{name}}, {{phone}}, {{address}}. Shop sẽ kiểm tra và xác nhận lại đơn với anh/chị trước khi gửi hàng nhé.',
  addressChangeReady: 'Dạ được ạ, anh/chị gửi giúp em địa chỉ mới đầy đủ, shop sẽ cập nhật lại đơn cho mình nhé.',
  addressChangeMissing: 'Dạ được ạ, anh/chị gửi giúp em {{missing}} để shop cập nhật/xác nhận đơn nhé.',
  apologyRepeatedReady: 'Dạ em xin lỗi vì đã hỏi lặp ạ. Em đã có đủ thông tin chốt {{productText}}: {{name}}, {{phone}}, {{address}}. Shop sẽ kiểm tra và xác nhận lại đơn với anh/chị trước khi gửi hàng nhé.',
  apologyRepeatedMissing: 'Dạ em xin lỗi vì đã hỏi lặp ạ. Em đang thiếu {{missing}} để shop xác nhận đơn giúp mình.',
  phoneWithLeadMissing: 'Dạ em đã nhận thông tin giao hàng rồi ạ. Anh/chị gửi thêm {{missing}} để shop xác nhận đơn nhé.',
  phoneOnlyMissing: 'Dạ em đã nhận SĐT của anh/chị rồi ạ. Anh/chị gửi thêm {{otherFields}} giúp em để {{shopName}} xác nhận đơn nhé.',
  infoMissingWithProduct: 'Dạ em nhận thông tin rồi ạ. Để chốt {{productCode}}, anh/chị gửi thêm {{missing}} để shop xác nhận đơn và giao hàng nhé.',
  infoMissingNoProduct: 'Dạ em nhận thông tin rồi ạ. Anh/chị chọn giúp em mã sản phẩm muốn lấy, hoặc nhắn "menu" để em gửi danh sách sản phẩm nhé.',
  orderInfoRequest: 'Dạ có ạ, để chốt đơn{{productSuffix}} anh/chị gửi giúp em {{orderInfoFields}} nhé. Shop sẽ xác nhận lại đơn trước khi giao.',
  orderIntentNoProduct: 'Dạ để em hỗ trợ lên đơn, anh/chị nhắn giúp em mã sản phẩm mình ưng ý (ví dụ: {{codeExample1}}) nhé. Sau đó em sẽ báo lại giá và xin {{orderInfoFields}} để gửi hàng cho mình ạ.',
  orderIntentWithProduct: 'Dạ em chốt {{productCode}} giá {{price}} cho anh/chị nhé. Anh/chị gửi giúp em {{orderInfoFields}} ạ. Hàng được {{privacy}}.',

  // ===== Sản phẩm / giá / so sánh =====
  productNotFound: 'Dạ mẫu {{codes}} bên em hiện đang không có sẵn rồi ạ. Anh/chị tham khảo thêm các mẫu trên menu shop nhé, hoặc cho em biết tầm giá để em gợi ý vài mẫu sát nhất đang có sẵn ạ.',
  priceClarification: 'Dạ {{productCode}} giá {{price}} ạ. Mẫu này {{stockText}}{{giftText}}.',
  comparison: 'Dạ em so sánh nhanh cho anh/chị nhé:\n{{lines}}\nNếu ưu tiên tiết kiệm thì chọn mẫu giá thấp hơn; nếu muốn trải nghiệm thật/to hơn thì chọn mẫu kích thước lớn hơn ạ.',
  productList: 'Dạ em gửi thông tin nhanh cho anh/chị nhé:\n{{lines}}\n{{photoNote}}',
  productListPhotoSent: 'Em cũng gửi ảnh mẫu kèm theo rồi ạ.',
  productListAskPhoto: 'Anh/chị muốn xem ảnh hoặc chốt mẫu nào thì nhắn em mã đó nhé.',

  // ===== Hình ảnh / menu =====
  menuSent: 'Dạ em gửi bảng ảnh các mẫu bên shop để anh/chị tiện tham khảo nhé. Mình ưng mẫu nào cứ nhắn mã (ví dụ {{codeExample1}}), em sẽ tư vấn chi tiết và báo giá luôn ạ.',
  productImage: 'Dạ em gửi ảnh {{productCode}} cho anh/chị tham khảo nhé. {{compactProductName}}, anh/chị muốn chốt thì gửi giúp em {{orderInfoFields}} ạ.',
  gelInfo: 'Dạ shop có sản phẩm gel trong menu ạ. Anh/chị xem ảnh kèm tin nhắn hoặc nhắn em mã để em báo giá chi tiết nhé.',
  newProducts: 'Dạ hiện shop tư vấn theo danh sách menu đang có ạ. Nếu có mẫu mới shop sẽ cập nhật thêm vào menu; anh/chị muốn xem lại danh sách hiện tại thì em gửi ảnh menu cho mình tham khảo nhé.',

  // ===== Thông tin hàng / size / quà / fit / vệ sinh =====
  stockInfoSelected: 'Dạ {{productCode}} {{stockText}} ạ. Trước khi gửi hàng shop sẽ xác nhận lại đơn cho mình nhé.',
  stockInfoUnknown: 'Dạ anh/chị nhắn giúp em mã sản phẩm muốn hỏi còn hàng, ví dụ {{codeExample1}} hoặc {{codeExample2}}, em kiểm tra và báo đúng mẫu cho mình ạ.',
  bestSeller: 'Dạ các mẫu dễ tư vấn/bán chạy bên shop thường là {{lines}} ạ. Nếu anh/chị cho em ngân sách hoặc ưu tiên size/tính năng, em lọc đúng mẫu hơn nhé.',
  sizeInfo: 'Dạ {{productCode}} có size {{size}}{{weightText}}.{{descSuffix}}',
  giftInfo: 'Dạ {{compactProductName}}{{giftText}} ạ. Shop vẫn miễn ship và gói kín cho mình nhé.',
  fitInfo: 'Dạ {{productCode}} chất liệu và thiết kế theo mô tả sản phẩm ạ. Anh/chị cần thêm phụ kiện kèm theo thì nhắn em nhé.',
  cleaningInfo: 'Dạ vệ sinh được ạ. Sau khi dùng anh/chị rửa nhẹ bằng nước sạch hoặc dung dịch vệ sinh chuyên dụng, lau khô rồi để nơi thoáng mát; tránh ngâm phần điện/tử (nếu mẫu có) ạ.',

  // ===== Chính sách =====
  agePolicy: 'Dạ sản phẩm bên {{shopName}} có quy định độ tuổi/phạm vi bán hàng theo chính sách shop ạ. Nếu anh/chị đã đủ {{minAge}} tuổi thì em hỗ trợ tư vấn bình thường nhé.',
  shippingPrivacy: 'Dạ {{shopName}} {{privacy}}. Thông tin đơn chỉ dùng để giao hàng, anh/chị yên tâm về bảo mật ạ.',
  inspection: 'Dạ khi nhận hàng anh/chị kiểm tra tình trạng gói hàng bên ngoài giúp shop; nếu có vấn đề, mình chụp ảnh/quay video để nhân viên hỗ trợ nhanh ạ.',
  shippingFee: 'Dạ {{shopName}} {{fee}} ạ. Anh/chị chỉ cần gửi mẫu muốn lấy + {{orderInfoFields}}, shop xác nhận đơn rồi giao cho mình.',
  discount: 'Dạ giá shop đang để theo menu và {{shipText}} ạ. Nếu anh/chị chốt nhiều món, nhân viên sẽ kiểm tra hỗ trợ mức tốt nhất trước khi lên đơn nhé.',
  officePickup: 'Dạ shop ưu tiên giao theo đơn để thuận tiện cho mình ạ. Anh/chị gửi mẫu muốn lấy + thông tin nhận hàng, nhân viên sẽ xác nhận lại trước khi gửi nhé.',
  paymentPreorder: 'Dạ {{productCode}} là hàng đặt nên có thể cần đặt cọc trước, phần còn lại shop sẽ xác nhận khi giao/nhận hàng ạ. Chi tiết nhân viên sẽ báo rõ.',
  paymentDefault: 'Dạ {{shopName}} hỗ trợ {{payment}} ạ. Với hàng đặt riêng thì có thể cần đặt cọc trước, shop sẽ xác nhận rõ trước khi lên đơn.',
  deliveryPreorder: 'Dạ {{productCode}} là hàng đặt, thời gian về/giao khoảng {{preorderDays}} ạ. Nếu anh/chị muốn mẫu có thể chốt nhanh hơn thì em gợi ý các mẫu không phải hàng đặt nhé.',
  deliveryDefault: 'Dạ các mẫu không ghi hàng đặt thì shop tư vấn/chốt theo danh sách hiện tại. Thời gian giao cụ thể tùy khu vực, khi anh/chị gửi địa chỉ shop sẽ xác nhận lại trước khi lên đơn ạ.',
  returnPolicy: 'Dạ shop cần nhân viên xác nhận kỳ tình trạng đơn trước khi đổi trả hoặc xử lý lỗi. Anh/chị giữ nguyên hình ảnh/video nhận hàng nếu có vấn đề để shop hỗ trợ nhanh ạ.',

  // ===== Tư vấn theo ngân sách / tính năng =====
  budgetTightCustom: 'Dạ với mức ngân sách khoảng 200k, em gợi ý anh/chị xem các mẫu trong danh sách phù hợp phía trên ạ. Anh/chị ưu tiên nhỏ gọn hay size lớn hơn để em lọc tiếp nhé?',
  budgetOptions: 'Dạ với khoảng {{budget}}k, bên em đang có sẵn các mẫu rất ưng này ạ:\n{{lines}}\nAnh/chị thích dáng nhỏ gọn hay kích thước to hơn một chút để em tư vấn kỹ hơn nhé?',
  budgetNoOptions: 'Dạ với khoảng {{budget}}k thì hiện tại bên em chưa có mẫu nào thật sự phù hợp ạ. Mình có thể nới ngân sách thêm chút xíu, hoặc nhắn chữ "menu" để xem các mẫu đang có sẵn bên shop nhé.',
  vibrationOptions: 'Dạ các mẫu có tính năng tương tự gồm {{options}}. Anh/chị muốn xem ảnh mẫu nào ạ?',
  largeOptions: 'Dạ nếu anh/chị thích mẫu kích thước lớn hơn thì có {{options}}. Anh/chị muốn tầm giá nào để em tư vấn sát hơn ạ?',
  featureAdviceDefault: 'Dạ anh/chị cứ cho em biết tầm ngân sách hoặc sở thích (thích loại nhỏ nhắn hay to hơn một chút), em sẽ lựa 1-2 mẫu ưng ý nhất đang sẵn hàng gửi mình xem ngay nhé.',

  /** Khi rule không khớp (BASIC / fallback) — giữ khách trong khung menu, không bịa ngoài danh sách. */
  catalogScopeGuide: 'Dạ hiện tại bên em chỉ sẵn các mã trong menu của {{shopName}} thôi ạ. Anh/chị cho em xin mức ngân sách hoặc gõ "menu" để xem danh sách nhé, em sẽ rà soát và gửi mẫu phù hợp nhất đang có ạ.',

  // ===== Handoff =====
  captureOnlyAskPhone: 'Dạ em đã nhận tin của anh/chị ạ. Nhân viên sẽ vào hỗ trợ ngay; nếu tiện anh/chị để lại SĐT giúp em để shop liên hệ nhanh hơn nhé.',
  humanHandoff: 'Dạ em chuyển anh/chị qua nhân viên tư vấn hỗ trợ kỹ hơn nhé. Anh/chị chờ một chút ạ 🙏',
  systemBusy: 'Xin lỗi anh/chị, hệ thống đang bận. Vui lòng thử lại sau nhé! 🙏'
};

const HELPERS = {
  upper: value => String(value || '').toUpperCase(),
  lower: value => String(value || '').toLowerCase(),
  capitalize: value => {
    const s = String(value || '');
    return s ? s[0].toUpperCase() + s.slice(1) : '';
  },
  default: (value, fallback) => (value == null || value === '' ? (fallback || '') : value),
  join: (value, sep = ', ') => Array.isArray(value) ? value.join(sep) : String(value || ''),
  vnd: value => {
    const s = String(value || '').trim();
    const m = s.match(/^(\d+)(?:\.(\d{3}))?k$/i);
    if (m) {
      const ng = m[2] ? Number(m[1]) * 1000 + Number(m[2]) : Number(m[1]);
      return `${ng.toLocaleString('vi-VN')}.000đ`;
    }
    const num = Number(s.replace(/[^\d]/g, ''));
    if (Number.isFinite(num) && num > 0) return `${num.toLocaleString('vi-VN')}đ`;
    return s;
  },
  count: (value, singular = '', plural = singular) => {
    const n = Array.isArray(value) ? value.length : Number(value);
    return `${n} ${n === 1 ? singular : plural}`;
  }
};

function applyHelper(value, expr) {
  const [name, ...args] = expr.split(':').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
  const fn = HELPERS[name];
  if (typeof fn !== 'function') return value;
  return fn(value, ...args);
}

function renderTemplate(template, data = {}) {
  if (template == null) return '';
  return String(template).replace(/\{\{\s*([\w.]+)((?:\s*\|\s*[^|}]+)*)\s*\}\}/g, (_, key, helperChain) => {
    let value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), data);

    if (helperChain) {
      const parts = helperChain.split('|').map(s => s.trim()).filter(Boolean);
      for (const helperExpr of parts) {
        value = applyHelper(value, helperExpr);
      }
    }
    return value == null ? '' : String(value);
  });
}

function render(name, data = {}, templates = TEMPLATES) {
  const tpl = templates[name];
  if (tpl == null) {
    console.warn(`[responses] Template không tồn tại: ${name}`);
    return '';
  }
  return renderTemplate(tpl, data);
}

module.exports = {
  TEMPLATES,
  HELPERS,
  renderTemplate,
  render
};
