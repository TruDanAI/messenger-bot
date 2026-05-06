const mongoose = require('mongoose');
const { getPlanFeatures } = require('../plan-features');

const shopSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // Shop ID (VD: adult-shop, nem-bui-xa)
    name: { type: String, required: true },
    plan: { 
        type: String, 
        enum: ['LITE', 'BASIC', 'PRO', 'ENTERPRISE'],
        default: 'BASIC' 
    },
    aiQuota: { type: Number, default: 0 }, // Giới hạn số lượt gọi AI trong tháng
    aiUsage: { type: Number, default: 0 }, // Số lượt đã dùng
    
    // Thông tin xác thực riêng biệt của từng shop
    credentials: {
        fbPageToken: { type: String, required: true },
        fbPageId: { type: String }, // Dùng để định danh shop khi nhận webhook
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
        enableSentiment: { type: Boolean, default: false },
        captureLeadOnly: { type: Boolean, default: false }
    },

    // Tuỳ chỉnh cấu hình AI
    customPrompt: { type: String, default: "" },
    configOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    
    // Cấu hình vận hành (SaaS - Dashboard first)
    minAge: { type: Number, default: 0 },
    policies: {
        freeShipping: { type: Boolean, default: true },
        privacy: { type: String, default: "" },
        payment: { type: String, default: "" },
        preorderDays: { type: String, default: "" },
        orderInfoFields: { type: String, default: "tên người nhận + SĐT + địa chỉ giao hàng" }
    },
    recommendations: { type: mongoose.Schema.Types.Mixed, default: {} },
    keywordProducts: { type: mongoose.Schema.Types.Mixed, default: {} },
    templates: { type: mongoose.Schema.Types.Mixed, default: {} },
    intents: {
        disabled: { type: [String], default: [] },
        prepend: { type: [mongoose.Schema.Types.Mixed], default: [] },
        append: { type: [mongoose.Schema.Types.Mixed], default: [] }
    },
    
    // Trạng thái shop
    image_url: { type: String, default: "" },
    menu_images: { type: [String], default: [] },
    isActive: { type: Boolean, default: true }
}, {
    timestamps: true // Tự động có createdAt, updatedAt
});

shopSchema.pre('validate', function applyFeaturesByPlan() {
    if (this.isNew || this.isModified('plan')) {
        this.features = { ...getPlanFeatures(this.plan) };
    }
});

const Shop = mongoose.model('Shop', shopSchema);

module.exports = Shop;
