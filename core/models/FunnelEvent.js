const mongoose = require('mongoose');

const funnelEventSchema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  intent: { 
    type: String, 
    enum: ['ASK_PRICE', 'ASK_STOCK', 'ASK_PRODUCT', 'ASK_SHIPPING', 'BUY_INTENT', 'FOLLOW_UP', 'BROADCAST_SENT', 'REPLY_AFTER_BROADCAST', 'UNKNOWN'],
    required: true,
    index: true 
  },
  value: { type: Number, default: 0 }, // Số tiền đơn hàng (nếu có)
  source: { type: String, enum: ['bot', 'followup', 'broadcast'], default: 'bot' },
  timestamp: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('FunnelEvent', funnelEventSchema);
