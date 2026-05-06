const mongoose = require('mongoose');

const discoveryLogSchema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('DiscoveryLog', discoveryLogSchema);
