/**
 * End-to-End Simulation Test
 * Giả lập một tin nhắn từ Facebook đi qua toàn bộ luồng:
 * Webhook -> Queue -> Worker -> Processor (Regex) -> Kết quả
 * 
 * KHÔNG cần kết nối thật với Facebook/Messenger.
 */
require('dotenv').config();

async function runE2ETest() {
    console.log('\n===================================================');
    console.log('🧪 ZenBot E2E Simulation Test');
    console.log('===================================================\n');

    let pass = 0;
    let fail = 0;

    function check(label, condition, detail = '') {
        if (condition) {
            pass++;
            console.log(`  ✅ ${label}`);
        } else {
            fail++;
            console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
        }
    }

    // -------------------------------------------------------
    // PHASE 1: Kiểm tra kết nối các dịch vụ
    // -------------------------------------------------------
    console.log('📡 Phase 1: Kết nối dịch vụ\n');

    const mongoose = require('mongoose');
    const Redis = require('ioredis');
    const { messageQueue } = require('../core/queue');

    let mongoOk = false;
    let redisOk = false;
    let shopDoc = null;

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        mongoOk = true;
    } catch (e) { }
    check('MongoDB kết nối được', mongoOk);

    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
        await redis.ping();
        redisOk = true;
    } catch (e) { }
    check('Redis/Upstash phản hồi PING', redisOk);

    // -------------------------------------------------------
    // PHASE 2: Kiểm tra Shop trong DB
    // -------------------------------------------------------
    console.log('\n🏪 Phase 2: Tải cấu hình Shop từ Database\n');

    const Shop = require('../core/models/Shop');

    if (mongoOk) {
        shopDoc = await Shop.findById(process.env.SHOP_ID || 'adult-shop');
        check('Shop tồn tại trong MongoDB', !!shopDoc);
        check('Shop ở trạng thái isActive = true', shopDoc?.isActive === true);
        check('Plan của Shop là PRO (đúng như seed)', shopDoc?.plan === 'PRO');
        check('Shop có fbPageToken', !!shopDoc?.credentials?.fbPageToken);
        check('Shop có feature enableAI = true', shopDoc?.features?.enableAI === true);
    } else {
        console.log('  ⚠️  Bỏ qua Phase 2 (MongoDB không kết nối được)');
    }

    // -------------------------------------------------------
    // PHASE 3: Giả lập tin nhắn đi qua Regex Engine
    // -------------------------------------------------------
    console.log('\n🤖 Phase 3: Giả lập tin nhắn qua Regex Engine\n');

    const processor = require('../core/processor');
    const storage = processor.storage;
    const TEST_USER = 'e2e_sim_user_777';

    // Reset state cho user test
    storage.clearOrderDraft(TEST_USER);

    // Giả lập shopConfig lấy từ MongoDB (nếu có) hoặc fallback
    const shopConfig = shopDoc || {
        _id: 'adult-shop',
        name: 'Shop Test E2E',
        plan: 'PRO',
        features: { enableAI: false, enableTelegram: false }, // Tắt AI/Telegram để test offline
        credentials: {
            fbPageToken: 'FAKE_TOKEN_FOR_TEST',
            geminiApiKey: 'FAKE_KEY'
        },
        customPrompt: ''
    };
    // Tắt AI để test offline không cần key thật
    shopConfig.features = { ...shopConfig.features, enableAI: false, enableTelegram: false };

    const testCases = [
        { msg: 'Chào shop', expectKeyword: 'chào', label: 'Tin chào hỏi -> Bot trả lời greeting' },
        { msg: 'mã 1 giá bao nhiêu', expectKeyword: 'giá', label: 'Hỏi giá mã -> Bot trả lời giá sản phẩm' },
        { msg: 'chốt mã 1 cho em', expectKeyword: 'tên', label: 'Chốt đơn -> Bot hỏi thông tin' },
        { msg: '0901234567', expectKeyword: 'địa chỉ', label: 'Gửi SĐT -> Bot hỏi tên + địa chỉ còn thiếu' },
    ];

    for (const tc of testCases) {
        // Giả lập event từ Facebook
        const mockEvent = {
            sender: { id: TEST_USER },
            message: { mid: `mid_e2e_${Date.now()}`, text: tc.msg }
        };

        // Giả lập messageData như Worker sẽ truyền vào
        const messageData = { event: mockEvent, baseUrlOverride: '' };

        let passed = false;
        let detail = '';

        try {
            // Patch sendMessage để bắt output thay vì gửi thật
            let capturedReply = null;
            const origAxios = require('axios');
            const axiosSpy = { ...origAxios };

            // Override postFb bằng cách mock axios.post
            const axios = require('axios');
            const origPost = axios.post;
            axios.post = async (url, data) => {
                if (url.includes('graph.facebook.com')) {
                    capturedReply = data?.message?.text || '[image/action]';
                    return { data: { message_id: 'mock_id' } };
                }
                return origPost(url, data); // Pass qua cho các call khác (Google Sheets, Telegram)
            };

            await processor.handleMessage(shopConfig, messageData);

            axios.post = origPost; // Restore

            if (capturedReply) {
                const lower = capturedReply.toLowerCase();
                passed = lower.includes(tc.expectKeyword);
                detail = `Reply: "${capturedReply.slice(0, 80).replace(/\n/g, ' ')}"`;
            } else {
                detail = 'Không bắt được reply';
            }
        } catch (e) {
            detail = `Lỗi: ${e.message}`;
        }

        check(tc.label, passed, detail);
        if (!passed) console.log(`      → ${detail}`);
    }

    // -------------------------------------------------------
    // PHASE 4: Kiểm tra Redis State Persistence
    // -------------------------------------------------------
    console.log('\n💾 Phase 4: Kiểm tra State tồn tại trong Redis\n');

    if (redisOk) {
        await storage.saveUserToRedis(TEST_USER, redis);
        storage.clearOrderDraft(TEST_USER);

        await storage.loadUserFromRedis(TEST_USER, redis);
        const restoredDraft = storage.getOrderDraft(TEST_USER);
        check('State sau khi save & load từ Redis có phone = 0901234567', restoredDraft?.phone === '0901234567');

        // Dọn dẹp
        await redis.del(`user_state:${TEST_USER}`);
        storage.clearOrderDraft(TEST_USER);
    } else {
        console.log('  ⚠️  Bỏ qua Phase 4 (Redis không kết nối được)');
    }

    // -------------------------------------------------------
    // KẾT QUẢ
    // -------------------------------------------------------
    console.log('\n===================================================');
    console.log(`  Tổng kết: ${pass} passed, ${fail} failed`);
    console.log('===================================================\n');

    if (mongoose.connection.readyState === 1) await mongoose.connection.close();
    if (redisOk) await redis.quit();
    // Đóng queue
    await messageQueue.close();

    process.exit(fail === 0 ? 0 : 1);
}

runE2ETest().catch(err => {
    console.error('❌ E2E Test crash:', err.message);
    process.exit(1);
});
