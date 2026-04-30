// ============================================================
// SHOP CONFIG — file điều khiển chính, đổi shop/dự án chỉ cần sửa file này
// (cùng products.csv) là đủ cho ~95% trường hợp.
//
// Cấu trúc:
//   shopName, minAge, policies   - thông tin chung dùng trong template
//   recommendations              - nhóm sản phẩm gợi ý theo intent
//                                  Nếu để [] hoặc không khai báo, engine sẽ
//                                  TỰ DERIVE từ attributes của products.
//   keywordProducts              - bản đồ "keyword -> regex match product"
//   intents                      - bật/tắt rule, hoặc thêm rule custom
//   templates                    - override câu trả lời cho từng intent
//   fallbackReply                - khi cả Gemini lẫn rule đều không trả được
// ============================================================

module.exports = {
  shopName: 'shop',
  minAge: 18,

  policies: {
    freeShipping: true,
    privacy: 'gói kín đáo, không ghi tên sản phẩm/đồ nhạy cảm bên ngoài',
    payment: 'COD nhận hàng trả tiền hoặc chuyển khoản',
    preorderDays: '15-20 ngày',
    orderInfoFields: 'tên người nhận + SĐT + địa chỉ giao hàng'
  },

  // Có thể để mảng rỗng [] cho group nào đó để engine tự derive từ products.csv:
  //   - budget: 3 mã giá thấp nhất (không phải hàng đặt)
  //   - premium: 3 mã giá cao nhất
  //   - large:   product có size chứa "lớn/to" hoặc weight > 2000g
  //   - vibration: product có description chứa "rung/pin/sạc"
  recommendations: {
    budget:    ['MÃ10', 'MÃ2', 'MÃ3'],
    vibration: ['MÃ2', 'MÃ8'],
    large:     ['MÃ9', 'MÃ12', 'MÃ13'],
    premium:   ['MÃ8', 'MÃ12', 'MÃ13']
  },

  // Bot sẽ trigger keyword image khi user nhắc các keyword này (xem rules.js wantsKeywordImage).
  // Hiện engine chỉ hỗ trợ sẵn keyword 'gel'; nếu cần thêm keyword khác, sửa rules.js wantsKeywordImage.
  keywordProducts: {
    gel: /gel/i
  },

  // ====== Cấu hình INTENT (tuỳ chọn) ======
  // intents: {
  //   disabled: ['AGE_POLICY', 'INSPECTION'],   // tắt rule không phù hợp với shop của mình
  //
  //   prepend: [                                 // chèn rule custom trước built-in (ưu tiên cao hơn)
  //     {
  //       name: 'VOUCHER',
  //       match: ctx => /voucher|ma giam|coupon/.test(ctx.normalized),
  //       handle: ctx => ctx.render('voucherInfo')
  //     }
  //   ],
  //
  //   append: [...]                              // chèn xuống cuối (fallback intent)
  // },
  intents: {},

  // ====== Override template (tuỳ chọn) ======
  // Có thể override 1 phần hoặc toàn bộ template trong responses.js mà KHÔNG
  // sửa file responses.js. Khi shop sau dùng giọng/thương hiệu khác chỉ cần
  // copy + sửa shop-config.
  // templates: {
  //   greeting: 'Chào bạn 🌸 Mình là trợ lý của {{shopName}}, mình giúp gì được nhé?',
  //   voucherInfo: 'Voucher hôm nay: GIAM10K áp dụng cho đơn từ 200k.'
  // },
  templates: {},

  fallbackReply: 'Dạ hệ thống đang đông nên em phản hồi chậm chút ạ 🙏 Anh/chị nhắn lại nhu cầu (mã sản phẩm hoặc ngân sách), em sẽ tư vấn ngay.'
};
