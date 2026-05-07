const mongoose = require('mongoose');

const messageLogSchema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  role: { type: String, enum: ['user', 'model', 'admin'], required: true },
  text: { type: String, required: true },
  intent: { type: String },
  timestamp: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Chỉ giữ log trong 30 ngày để tiết kiệm dung lượng DB
messageLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('MessageLog', messageLogSchema);
