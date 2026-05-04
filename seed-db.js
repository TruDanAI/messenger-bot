require('dotenv').config();
const { connectDB } = require('./core/db');
const Shop = require('./core/models/Shop');
const mongoose = require('mongoose');

async function seedFirstShop() {
    console.log('⏳ Đang kết nối Database...');
    await connectDB();

    const shopId = process.env.SHOP_ID || 'adult-shop';

    try {
        console.log(`📦 Đang khởi tạo dữ liệu cho Shop: ${shopId}`);

        // Xóa cũ nếu có để tránh trùng
        await Shop.deleteOne({ _id: shopId });

        // Tạo dữ liệu Shop mới
        const newShop = new Shop({
            _id: shopId,
            name: "Shop Đầu Tiên (Chuyển từ local)",
            plan: "PRO", // Mặc định gói PRO cho shop của chính bạn
            aiQuota: 2000,
            credentials: {
                fbPageToken: process.env.FB_PAGE_TOKEN,
                fbVerifyToken: process.env.FB_VERIFY_TOKEN,
                googleSheetUrl: process.env.GOOGLE_SHEET_WEBHOOK_URL,
                telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
                telegramChatId: process.env.TELEGRAM_CHAT_ID,
                geminiApiKey: process.env.GEMINI_API_KEY
            },
            features: {
                enableAI: true,
                enableTelegram: true,
                enableSentiment: false
            },
            customPrompt: "Bạn là nhân viên tư vấn bán hàng thân thiện. Hãy trả lời ngắn gọn, tự nhiên và chốt đơn."
        });

        await newShop.save();
        console.log('✅ Đã lưu Shop lên MongoDB Cloud thành công!');
        console.log('=> Bạn có thể lên trang MongoDB Atlas để xem dữ liệu vừa được đẩy lên.');

    } catch (error) {
        console.error('❌ Lỗi tạo Shop:', error);
    } finally {
        mongoose.connection.close();
    }
}

seedFirstShop();
