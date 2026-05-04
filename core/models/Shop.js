const mongoose = require('mongoose');

const shopSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // Shop ID (VD: adult-shop, nem-bui-xa)
    name: { type: String, required: true },
    plan: { 
        type: String, 
        enum: ['BASIC', 'PRO', 'ENTERPRISE'], 
        default: 'BASIC' 
    },
    aiQuota: { type: Number, default: 0 }, // Giới hạn số lượt gọi AI trong tháng
    aiUsage: { type: Number, default: 0 }, // Số lượt đã dùng
    
    // Thông tin xác thực riêng biệt của từng shop
    credentials: {
        fbPageId: { type: String, index: true }, // Dùng để định tuyến từ Webhook -> Shop
        fbPageToken: { type: String, required: true },
        fbVerifyToken: { type: String },
        googleSheetUrl: { type: String },
        telegramBotToken: { type: String },
        telegramChatId: { type: String },
        geminiApiKey: { type: String } // Nếu shop có key riêng thì dùng, không thì dùng chung
    },

    // Cờ tính năng
    features: {
        enableAI: { type: Boolean, default: false },
        enableTelegram: { type: Boolean, default: false },
        enableSentiment: { type: Boolean, default: false }
    },

    // Tuỳ chỉnh cấu hình AI
    customPrompt: { type: String, default: "" },
    
    // Trạng thái shop
    isActive: { type: Boolean, default: true }
}, {
    timestamps: true // Tự động có createdAt, updatedAt
});

const Shop = mongoose.model('Shop', shopSchema);

module.exports = Shop;
