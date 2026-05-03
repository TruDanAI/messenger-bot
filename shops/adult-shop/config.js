// Cấu hình shop adult-shop — đồ chơi người lớn (tách khỏi core).

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

  recommendations: {
    budget: ['MÃ10', 'MÃ2', 'MÃ3'],
    vibration: ['MÃ2', 'MÃ8'],
    large: ['MÃ9', 'MÃ12', 'MÃ13'],
    premium: ['MÃ8', 'MÃ12', 'MÃ13']
  },

  keywordProducts: {
    gel: /gel/i
  },

  keywordTriggers: {
    gel: t =>
      /\bgel\b/.test(t)
      || /\bboi\s*tron\b/.test(t)
      || /\blub(?:ricant)?\b/.test(t)
  },

  wantsVibration: t => /\brung\b|co\s*pin|sac\s*pin/.test(t),

  productImageExtraNames(product) {
    const code = String(product?.code || '');
    if (/gel/i.test(code)) {
      return ['goi gel boi tron', 'goi-gel-boi-tron', 'gel boi tron', 'gel-boi-tron'];
    }
    return [];
  },

  /**
   * System prompt Gemini — giữ giọng và quy tắc riêng shop.
   */
  buildSystemPrompt(products) {
    const lines = products.map(p => {
      const parts = [
        p.code,
        p.price,
        p.description,
        p.size,
        p.weight,
        p.gift ? `Tặng ${p.gift}` : '',
        p.preorder ? 'HÀNG ĐẶT 15-20 ngày' : ''
      ].filter(Boolean);
      return `- ${parts.join(' | ')}`;
    }).join('\n');

    return `Bạn là nhân viên tư vấn bán hàng thân thiện, nhiệt tình của Shop đồ chơi người lớn dành cho nam giới (18+). Hãy tư vấn tự nhiên, gần gũi như người thật, dùng ngôn ngữ thoải mái, không quá formal.

DANH SÁCH SẢN PHẨM:
${lines}

CHÍNH SÁCH:
- Miễn ship tất cả sản phẩm
- Gói kín, không ghi nội dung bên ngoài (bảo mật tuyệt đối)
- Hàng đặt cần đặt cọc, giao 15-20 ngày
- Thanh toán: COD hoặc chuyển khoản

QUY TẮC BẮT BUỘC:
- TUYỆT ĐỐI không bịa sản phẩm hoặc giá ngoài danh sách trên
- Nếu khách hỏi sản phẩm không có, nói thẳng "shop chưa có" rồi gợi ý mẫu gần nhất
- Trả lời ngắn gọn, tự nhiên. KHÔNG liệt kê dài dòng trừ khi khách hỏi hết danh sách
- Dùng emoji vừa phải cho thân thiện
- Ngôn ngữ kín đáo, không phản cảm
- Chỉ tư vấn cho khách đủ 18 tuổi
- Xưng hô nhất quán **anh/chị** — không viết "anh/em", không lẫn ngôi.
- KHÔNG nhắc khách về kỹ thuật hay nội bộ: cấm các cụm như "hệ thống tự động", "(ảnh được gửi...)", "AI", "bot". Không dùng ngoặc đơn giải thích cơ chế gửi tin hay ảnh.
- Ảnh/menu có thể được gửi **kèm tin nhắn của em** sau khi em trả lời; đừng tiết lộ chi tiết đó. Không nói "em không gửi ảnh được" hay xin lỗi vì ảnh — cứ tự nhiên như "em gửi ảnh menu cho anh/chị nhé" hoặc "anh/chị xem các mã trong menu ạ".

CÁCH TƯ VẤN:
- Nếu khách chưa rõ nhu cầu: hỏi ngân sách, thích nhỏ gọn hay to, có pin/rung không
- Gợi ý 1-2 sản phẩm phù hợp ngân sách, không spam cả danh sách
- Khi khách muốn chốt đơn: hỏi tên + địa chỉ + số điện thoại
- Khi đã đủ thông tin: xác nhận lại sản phẩm + giá + tên + sđt + địa chỉ trước khi kết thúc
- Nếu khách muốn gặp nhân viên thật: trả lời "Em chuyển anh/chị qua nhân viên tư vấn nhé" và dừng tư vấn`;
  },

  intents: {},

  templates: {
    gelInfo:
      'Dạ shop có Gel bôi trơn 150k/chai 200ml, mua gel được tặng thêm 5 gói gel nhỏ ạ. Em gửi ảnh kèm theo rồi nhé.',
    agePolicy:
      'Dạ sản phẩm bên {{shopName}} chỉ tư vấn và bán cho khách từ đủ {{minAge}} tuổi trở lên ạ. Nếu anh/chị đã đủ {{minAge}} tuổi thì em hỗ trợ tư vấn bình thường nhé.',
    budgetTightCustom:
      'Dạ với ngân sách khoảng 200k thì shop chưa có mẫu vừa to vừa có rung ạ. Gần nhất là MÃ10 giá 150k, nhỏ gọn nhưng không rung. Nếu anh/chị muốn có rung thì nên lên MÃ2 giá 300k, nhỏ gọn và có pin/rung.',
    featureAdviceDefault:
      'Dạ em gợi ý nhanh: tiết kiệm thì MÃ10 150k, có rung nhỏ gọn thì MÃ2 300k, cao cấp có sạc/làm ấm thì MÃ8 680k, kích thước lớn hơn thì MÃ9/MÃ12/MÃ13. Anh/chị muốn theo ngân sách nào ạ?',
    bestSeller:
      'Dạ các mẫu dễ tư vấn/bán chạy bên shop thường là {{lines}} ạ. Nếu anh/chị cho em ngân sách hoặc thích nhỏ gọn/có rung/kích thước lớn, em lọc đúng mẫu hơn nhé.',
    fitInfo:
      'Dạ {{productCode}} chất liệu mềm và thiết kế ôm/khít theo mô tả sản phẩm ạ. Khi dùng anh/chị có thể dùng thêm gel bôi trơn để thoải mái hơn, shop có gel nếu mình cần kèm theo nhé.',
    discount:
      'Dạ giá shop đang để theo menu và {{shipText}} ạ. Nếu anh/chị lấy thêm gel hoặc chốt nhiều món, nhân viên sẽ kiểm tra hỗ trợ mức tốt nhất trước khi lên đơn nhé.',
    inspection:
      'Dạ vì sản phẩm cá nhân/nhạy cảm nên shop cần đóng gói kín. Khi nhận hàng anh/chị kiểm tra tình trạng gói hàng bên ngoài giúp shop; nếu có vấn đề, mình chụp ảnh/quay video để nhân viên hỗ trợ nhanh ạ.',
    officePickup:
      'Dạ shop ưu tiên giao kín theo đơn để bảo mật thông tin cho mình ạ. Anh/chị gửi mẫu muốn lấy + thông tin nhận hàng, nhân viên sẽ xác nhận lại trước khi gửi nhé.',
    returnPolicy:
      'Dạ vì đây là sản phẩm cá nhân/nhạy cảm nên shop cần nhân viên xác nhận kỹ tình trạng đơn trước khi đổi trả hoặc xử lý lỗi. Anh/chị giữ nguyên hình ảnh/video nhận hàng nếu có vấn đề để shop hỗ trợ nhanh ạ.',
    cleaningInfo:
      'Dạ vệ sinh được ạ. Sau khi dùng anh/chị rửa nhẹ bằng nước sạch hoặc dung dịch vệ sinh chuyên dụng, lau khô rồi để nơi thoáng mát; tránh ngâm phần pin/sạc nếu mẫu có điện ạ.'
  },

  fallbackReply:
    'Dạ hệ thống đang đông nên em phản hồi chậm chút ạ 🙏 Anh/chị nhắn lại nhu cầu (mã sản phẩm hoặc ngân sách), em sẽ tư vấn ngay.'
};
