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

  // Các nhóm mã nổi bật giúp đổi dự án nhanh hơn: đổi products.csv và chỉnh nhóm này là đủ cho đa số rule.
  recommendations: {
    budget: ['MÃ10', 'MÃ2', 'MÃ3'],
    vibration: ['MÃ2', 'MÃ8'],
    large: ['MÃ9', 'MÃ12', 'MÃ13'],
    premium: ['MÃ8', 'MÃ12', 'MÃ13']
  },

  keywordProducts: {
    gel: /gel/i
  },

  fallbackReply: 'Dạ hệ thống đang đông nên em phản hồi chậm chút ạ 🙏 Anh/chị nhắn lại nhu cầu (mã sản phẩm hoặc ngân sách), em sẽ tư vấn ngay.'
};
