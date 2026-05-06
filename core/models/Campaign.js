const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  shopId: { type: String, required: true, index: true },
  type: { 
    type: String, 
    enum: ['REENGAGE', 'UPSELL', 'PROMO'], 
    required: true 
  },
  segmentQuery: { type: mongoose.Schema.Types.Mixed, required: true }, // Điều kiện lọc Lead (MongoDB Query)
  messageTemplate: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['draft', 'scheduled', 'sending', 'done', 'failed'], 
    default: 'draft',
    index: true
  },
  scheduledAt: { type: Date, index: true },
  sentCount: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

module.exports = mongoose.model('Campaign', campaignSchema);
