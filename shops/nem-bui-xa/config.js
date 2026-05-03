// Nem Bùi Xã — cấu hình chuẩn bị (thay nội dung theo xưởng thật).

module.exports = {
  shopName: 'Nem Bùi Xã',
  minAge: 0,

  policies: {
    freeShipping: false,
    privacy: 'gói sạch, giao hàng trong ngày nếu đơn gần xưởng (shop sẽ xác nhận)',
    payment: 'COD hoặc chuyển khoản',
    preorderDays: '1-2 ngày với đơn số lượng lớn',
    orderInfoFields: 'tên người nhận + SĐT + địa chỉ giao hàng'
  },

  recommendations: {},

  keywordProducts: {},
  keywordTriggers: {},

  intents: {},

  templates: {
    greeting:
      'Dạ em chào anh/chị ạ. Hôm nay nhà làm nem Bùi Xã, nem tai nem chua đủ cả. Anh/chị muốn xem menu hay đặt sỉ / lẻ ạ?',
    shippingFee:
      'Dạ {{shopName}} {{fee}}. Đơn gần xưởng shop ưu tiên giao nhanh; xa hơn em báo phí ship sau khi có địa chỉ nhé.',
    orderIntentNoProduct:
      'Dạ anh/chị muốn đặt món nào thì nhắn giúp em tên nem hoặc combo, ví dụ Nem Bùi hoặc Nem Tai ạ.'
  },

  fallbackReply:
    'Dạ em đang bận chút, anh/chị nhắn lại số lượng và loại nem cần lấy, em báo giá ngay ạ 🙏',

  buildSystemPrompt(products) {
    const lines = products
      .map(p => `- ${p.code}: ${p.price}${p.description ? ` — ${p.description}` : ''}`)
      .join('\n');
    return `Bạn là nhân viên bán nem tại làng nghề, giọng thân thiện, xưng hô anh/chị.

MENU:
${lines}

Nhiệm vụ: tư vấn món phù hợp, giá theo menu, hỏi số lượng và địa chỉ khi chốt đơn. Không bịa món hoặc giá ngoài danh sách.`;
  }
};
