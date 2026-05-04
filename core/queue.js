const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

// Khởi tạo kết nối Redis
const connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null, // Yêu cầu bắt buộc của BullMQ
});

connection.on('connect', () => {
    console.log('✅ Đã kết nối thành công tới Redis (Upstash)');
});

connection.on('error', (err) => {
    console.error('❌ Lỗi kết nối Redis:', err.message);
});

// Tạo Queue để hứng tin nhắn từ Webhook
const messageQueue = new Queue('webhook-messages', { connection });

console.log('✅ Khởi tạo Message Queue thành công');

module.exports = {
    connection,
    messageQueue,
    Worker // Xuất Worker ra để file index.js sử dụng
};
