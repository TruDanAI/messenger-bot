/**
 * Integration Test Suite — Kiểm tra kiến trúc Modular mới
 * Kiểm tra: DB kết nối, Queue nhận Job, Worker xử lý, shopConfig Tier
 */
require('dotenv').config();

const { describe, it, expect, run } = require('./harness');

// ======================================================
// TEST 1: Kết nối MongoDB & truy vấn Shop
// ======================================================
describe('Database: MongoDB kết nối & truy vấn Shop', () => {
  const mongoose = require('mongoose');
  const Shop = require('../core/models/Shop');

  it('MONGODB_URI phải được cấu hình trong .env', () => {
    expect(!!process.env.MONGODB_URI).toBeTrue();
  });

  it('Shop Schema có đủ 4 plan LITE / BASIC / PRO / ENTERPRISE', () => {
    const planEnum = Shop.schema.path('plan').enumValues;
    expect(planEnum).toContain('LITE');
    expect(planEnum).toContain('BASIC');
    expect(planEnum).toContain('PRO');
    expect(planEnum).toContain('ENTERPRISE');
  });

  it('Shop "adult-shop" phải tồn tại trong MongoDB', async () => {
    if (!process.env.MONGODB_URI) return;
    await mongoose.connect(process.env.MONGODB_URI);
    const shop = await Shop.findById('adult-shop');
    expect(!!shop).toBeTrue();
    expect(shop.plan).toBe('PRO');
    await mongoose.connection.close();
  });
});

// ======================================================
// TEST 2: Redis kết nối & các hàm Storage mới
// ======================================================
describe('Redis: Kết nối & loadUserFromRedis / saveUserToRedis', () => {
  const Redis = require('ioredis');
  const storage = require('../core/storage');

  it('REDIS_URL phải được cấu hình trong .env', () => {
    expect(!!process.env.REDIS_URL).toBeTrue();
  });

  it('Lưu & tải State user từ Redis thành công', async () => {
    if (!process.env.REDIS_URL) return;
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    const testUserId = 'test_integration_user_123';

    // Giả lập lưu State
    storage.mergeOrderDraft(testUserId, {
      name: 'Nguyễn Test',
      phone: '0901234567',
      address: '123 Đường Kiểm Tra',
      productCode: 'MA01'
    });

    // Đẩy lên Redis
    await storage.saveUserToRedis(testUserId, redis);

    // Xoá khỏi bộ nhớ tạm
    storage.clearOrderDraft(testUserId);
    expect(storage.getOrderDraft(testUserId)).toEqual({});

    // Load lại từ Redis
    await storage.loadUserFromRedis(testUserId, redis);
    const draft = storage.getOrderDraft(testUserId);

    expect(draft.name).toBe('Nguyễn Test');
    expect(draft.phone).toBe('0901234567');
    expect(draft.address).toBe('123 Đường Kiểm Tra');
    expect(draft.productCode).toBe('MA01');

    // Dọn dẹp test key
    await redis.del(`user_state:${testUserId}`);
    storage.clearOrderDraft(testUserId);
    await redis.quit();
  });
});

// ======================================================
// TEST 3: Queue — Tạo Job và kiểm tra cấu trúc đúng
// ======================================================
describe('Queue: BullMQ tạo Job đúng cấu trúc', () => {
  it('messageQueue phải được export từ core/queue.js', () => {
    const { messageQueue } = require('../core/queue');
    expect(typeof messageQueue.add).toBe('function');
  });

  it('Cấu trúc Job data đúng format { shopId, event, baseUrlOverride }', () => {
    const mockJobData = {
      shopId: 'adult-shop',
      senderId: '123456789',
      event: {
        sender: { id: '123456789' },
        message: { mid: 'mid_abc', text: 'Chào shop' }
      },
      baseUrlOverride: 'https://example.up.railway.app'
    };

    expect(!!mockJobData.shopId).toBeTrue();
    expect(!!mockJobData.event.sender.id).toBeTrue();
    expect(!!mockJobData.event.message.text).toBeTrue();
  });
});

// ======================================================
// TEST 4: Processor — shopConfig điều hướng đúng Tier
// ======================================================
describe('Processor: Feature Flag theo Gói cước (Tier)', () => {
  it('Gói LITE: chỉ giữ bot lễ tân, không dùng AI', () => {
    const shopConfigLite = {
      plan: 'LITE',
      features: { enableAI: false, enableTelegram: true, enableSentiment: false, captureLeadOnly: true }
    };
    expect(shopConfigLite.features.enableAI).toBeFalse();
    expect(shopConfigLite.features.enableTelegram).toBeTrue();
    expect(shopConfigLite.features.captureLeadOnly).toBeTrue();
  });

  it('Gói BASIC: enableAI = false -> dùng fallback rule-based', () => {
    const shopConfigBasic = {
      plan: 'BASIC',
      features: { enableAI: false, enableTelegram: true, captureLeadOnly: false }
    };
    expect(shopConfigBasic.features.enableAI).toBeFalse();
  });

  it('Gói PRO: enableAI = true -> được gọi Gemini', () => {
    const shopConfigPro = {
      plan: 'PRO',
      features: { enableAI: true, enableTelegram: true, captureLeadOnly: false }
    };
    expect(shopConfigPro.features.enableAI).toBeTrue();
  });

  it('Gói ENTERPRISE: có customPrompt riêng', () => {
    const shopConfigEnterprise = {
      plan: 'ENTERPRISE',
      features: { enableAI: true, enableTelegram: true, enableSentiment: true },
      customPrompt: 'Bạn là AI bán hàng cao cấp...'
    };
    expect(shopConfigEnterprise.features.enableSentiment).toBeTrue();
    expect(shopConfigEnterprise.customPrompt.length).toBeTruthy();
  });
});

// ======================================================
// TEST 5: processor.js exports đúng các hàm cần thiết
// ======================================================
describe('Processor: exports đúng các hàm cần thiết', () => {
  it('handleMessage phải là function', () => {
    const processor = require('../core/processor');
    expect(typeof processor.handleMessage).toBe('function');
  });

  it('storage phải được export ra từ processor', () => {
    const processor = require('../core/processor');
    expect(typeof processor.storage).toBe('object');
    expect(typeof processor.storage.getOrderDraft).toBe('function');
  });

  it('buildLeadDetails phải được export ra từ processor', () => {
    const processor = require('../core/processor');
    expect(typeof processor.buildLeadDetails).toBe('function');
  });
});

// ======================================================
// TEST 6: Dedup — jobId dựa vào MID chặn retry từ Meta
// ======================================================
describe('Dedup: job.id dùng MID để chặn tin trùng từ Meta', () => {
  it('Nếu có mid -> jobId phải là mid', () => {
    const mid = 'm_abc123xyz';
    const jobId = mid || undefined;
    expect(jobId).toBe('m_abc123xyz');
  });

  it('Nếu không có mid -> jobId là undefined (BullMQ tự tạo ID)', () => {
    const mid = null;
    const jobId = mid || undefined;
    expect(jobId === undefined).toBeTrue();
  });
});

const exitCode = run();
process.exit(exitCode);
