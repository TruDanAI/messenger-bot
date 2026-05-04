const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        if (!process.env.MONGODB_URI) {
            console.warn('⚠️ MONGODB_URI không tồn tại. Đang bỏ qua kết nối Database.');
            return;
        }

        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Đã kết nối thành công tới MongoDB (ZenBot Core)');
    } catch (error) {
        console.error('❌ Lỗi kết nối MongoDB:', error.message);
        process.exit(1); // Dừng app nếu không kết nối được DB khi đã cấu hình
    }
};

module.exports = { connectDB };
