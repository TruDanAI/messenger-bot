const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  shopId: { type: String, required: true, index: true },
  code: { type: String, required: true, index: true },
  name: { type: String, required: true },
  price: { type: String, required: true },
  description: { type: String },
  size: { type: String },
  preorder: { type: Boolean, default: false },
  image: { type: String },
  stockCount: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

// Đảm bảo mã sản phẩm là duy nhất trong một shop
productSchema.index({ shopId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Product', productSchema);
