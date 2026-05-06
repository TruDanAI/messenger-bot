const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['admin', 'staff'], 
    default: 'staff' 
  },
  shopIds: { 
    type: [String], 
    default: [] // Danh sách Shop ID mà User này được quyền quản lý
  },
  name: String,
  isActive: { type: Boolean, default: true }
}, {
  timestamps: true
});

// Index để tìm kiếm nhanh
userSchema.index({ email: 1 });

const User = mongoose.model('User', userSchema);

module.exports = User;
