const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  senderId: { type: String, required: true, index: true },
  type: { type: String, default: 'lead' }, // 'lead' or 'order'
  status: { 
    type: String, 
    default: 'new', 
    enum: ['new', 'contacted', 'qualified', 'order', 'closed', 'lost'] 
  },
  at: { type: Date, default: Date.now },
  productCode: String,
  phone: String,
  name: String,
  address: String,
  text: String, // Last message
  history: String, // Conversation summary or snippet
  tags: [String],
  value: { type: Number, default: 0 }, // Order value if applicable
  notes: String,
  channel: { type: String, default: 'messenger' }, // 'messenger', 'zalo', etc.
  intent: { type: String, index: true },
  handledBy: { type: String, enum: ['ai', 'human'], default: 'ai', index: true },
  
  // Auto Follow-up fields
  lastAskPriceAt: { type: Date },
  lastBuyIntentAt: { type: Date },
  lastFollowUpAt: { type: Date },
  followUpCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

// Index for CRM searching
leadSchema.index({ name: 'text', phone: 'text', senderId: 'text' });

const Lead = mongoose.model('Lead', leadSchema);

module.exports = Lead;
