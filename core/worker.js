const { Worker } = require('bullmq');
const Shop = require('./models/Shop');
const processor = require('./processor'); // Import hàm xử lý
const { connection } = require('./queue');

const stateLocks = new Map();

async function withStateLock(key, fn) {
    const previous = stateLocks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    stateLocks.set(key, tail);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (stateLocks.get(key) === tail) stateLocks.delete(key);
    }
}

const chatWorker = new Worker('webhook-messages', async job => {
    const { shopId, senderId } = job.data;
    const stateKey = `${shopId}:${senderId}`;
    return withStateLock(stateKey, () => processChatJob(job, stateKey));
}, { 
    connection,
    concurrency: 5 // Cho phép xử lý tối đa 5 tin nhắn cùng lúc cho toàn hệ thống
});

async function processChatJob(job, stateKey) {
    const { shopId, senderId } = job.data;
    console.log(`[Worker] Xử lý Job ${job.id} từ khách ${senderId} cho shop ${shopId}`);

    // 1. Truy vấn MongoDB lấy cấu hình Shop
    const shopConfig = await Shop.findById(shopId);
    
    if (!shopConfig || !shopConfig.isActive) {
        console.warn(`⚠️ Bỏ qua Job vì Shop ${shopId} không tồn tại hoặc bị khóa`);
        return;
    }

    // 2. Tải State của user từ Redis vào bộ nhớ tạm của processor
    await processor.storage.loadUserFromRedis(stateKey, connection);

    // 3. Xử lý logic chính (Regex + AI)
    try {
        await processor.handleMessage(shopConfig, job.data);
    } catch (error) {
        console.error(`❌ Lỗi xử lý cho shop ${shopId}:`, error.message);
        throw error; // Bắn ra để BullMQ Retry
    } finally {
        // 4. Lưu lại State mới vào Redis sau khi xử lý xong (dù lỗi hay không)
        await processor.storage.saveUserToRedis(stateKey, connection);
    }
}

chatWorker.on('completed', job => {
    console.log(`✅ Job ${job.id} hoàn thành!`);
});

chatWorker.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} thất bại sau nhiều lần thử:`, err.message);
});

module.exports = chatWorker;
