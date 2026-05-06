/**
 * Chuyển đổi các điều kiện từ UI sang MongoDB Query thô.
 * Giúp bảo mật (không cho user gửi query trực tiếp) và dễ dùng.
 */
function buildMongoQuery(segmentConditions = []) {
  const now = new Date();
  const query = {};
  const exprConditions = []; // Dùng cho $expr (so sánh 2 field)

  segmentConditions.forEach(cond => {
    const { field, operator, value } = cond;

    switch (field) {
      case 'lastAskPriceAt':
        if (operator === 'within_days') {
          query.lastAskPriceAt = {
            $gte: new Date(now.getTime() - value * 24 * 60 * 60 * 1000)
          };
        }
        break;

      case 'lastBuyIntentAt':
        if (operator === 'not_after_ask') {
          // Khách chưa mua HOẶC mua trước khi hỏi giá lần cuối
          query.$or = [
            { lastBuyIntentAt: { $exists: false } },
            { $expr: { $lt: ["$lastBuyIntentAt", "$lastAskPriceAt"] } }
          ];
        } else if (operator === 'within_days') {
          query.lastBuyIntentAt = {
            $gte: new Date(now.getTime() - value * 24 * 60 * 60 * 1000)
          };
        }
        break;

      case 'score':
        if (operator === 'gte') query.score = { $gte: Number(value) };
        if (operator === 'lte') query.score = { $lte: Number(value) };
        break;

      case 'followUpCount':
        if (operator === 'eq') query.followUpCount = Number(value);
        if (operator === 'lt') query.followUpCount = { $lt: Number(value) };
        break;
        
      case 'intent':
        if (operator === 'is') query.intent = value;
        break;
    }
  });

  return query;
}

/**
 * Các bộ lọc mẫu (Presets) để hiển thị trên UI
 */
const PRESETS = {
  UNCONVERTED_HOT_LEADS: [
    { field: 'lastAskPriceAt', operator: 'within_days', value: 3 },
    { field: 'lastBuyIntentAt', operator: 'not_after_ask' }
  ],
  LOYAL_CUSTOMERS: [
    { field: 'lastBuyIntentAt', operator: 'within_days', value: 30 },
    { field: 'score', operator: 'gte', value: 50 }
  ],
  CHURNED_CUSTOMERS: [
    { field: 'lastBuyIntentAt', operator: 'within_days', value: 90 }, // 3 tháng chưa mua lại
    { field: 'score', operator: 'gte', value: 10 }
  ]
};

module.exports = {
  buildMongoQuery,
  PRESETS
};
