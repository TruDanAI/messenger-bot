require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const sharp = require('sharp');
const axios = require('axios');
const { connectDB } = require('./core/db');
const { messageQueue, connection: redisConnection } = require('./core/queue');
const { startSheetOutboxWorker, stopSheetOutboxWorker } = require('./core/sheets-webhook');
const { startFollowUpWorker } = require('./core/followupWorker');
const { startBroadcastWorker } = require('./core/broadcastWorker');
const { buildMongoQuery, PRESETS } = require('./core/segmentBuilder');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Shop = require('./core/models/Shop');
const Lead = require('./core/models/Lead');
const Product = require('./core/models/Product');
const MessageLog = require('./core/models/MessageLog');
const User = require('./core/models/User');
const chatWorker = require('./core/worker'); 

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  const message = 'JWT_SECRET is required. Set it in Railway Variables before starting the app.';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(message);
  }
  console.warn(`⚠️ ${message} Using a local development fallback.`);
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'zenbot_local_dev_secret';

// Lazy-load processor để lấy IMAGE_INDEX (tránh circular load)
const processor = require('./core/processor');

// Kết nối DB — chỉ gọi MỘT lần duy nhất ở đây
connectDB().then(() => {
  // Khởi động các worker xử lý hàng đợi và tác vụ ngầm
  startSheetOutboxWorker();
  startFollowUpWorker();
  startBroadcastWorker();
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_APP_SECRET   = process.env.FB_APP_SECRET;
const PORT            = process.env.PORT || 3000;

// ========== BASIC REQUEST HARDENING ==========
function clientKey(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();
  const disabled = process.env.DISABLE_RATE_LIMIT === 'true';

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits.entries()) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 30000)).unref?.();

  return (req, res, next) => {
    if (disabled) return next();
    const now = Date.now();
    const key = `${name}:${clientKey(req)}`;
    const current = hits.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + windowMs };

    bucket.count += 1;
    hits.set(key, bucket);

    const remaining = Math.max(0, max - bucket.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      return res.status(429).json({
        message: 'Too many requests',
        retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000)
      });
    }

    next();
  };
}

const adminRateLimit = createRateLimiter({
  name: 'admin',
  windowMs: Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.ADMIN_RATE_LIMIT_MAX) || 120
});

const uploadRateLimit = createRateLimiter({
  name: 'upload',
  windowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX) || 40
});

function safeBaseName(filename) {
  const parsed = path.parse(String(filename || 'image'));
  return parsed.name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'image';
}

async function processUploadedImage(file, shopId) {
  const image = sharp(file.path, { failOn: 'warning' }).rotate();
  const metadata = await image.metadata();
  const baseName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeBaseName(file.originalname)}`;
  const dir = path.dirname(file.path);
  const optimizedName = `${baseName}.webp`;
  const thumbName = `${baseName}-thumb.webp`;
  const optimizedPath = path.join(dir, optimizedName);
  const thumbPath = path.join(dir, thumbName);

  await image
    .clone()
    .resize({
      width: Number(process.env.IMAGE_MAX_WIDTH) || 1600,
      height: Number(process.env.IMAGE_MAX_HEIGHT) || 1600,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: Number(process.env.IMAGE_WEBP_QUALITY) || 82 })
    .toFile(optimizedPath);

  await image
    .clone()
    .resize(320, 320, { fit: 'cover', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toFile(thumbPath);

  await fs.promises.unlink(file.path).catch(() => {});

  const optimizedStat = await fs.promises.stat(optimizedPath);
  const thumbStat = await fs.promises.stat(thumbPath);
  return {
    filename: optimizedName,
    originalName: file.originalname,
    url: `/media/${shopId}/${optimizedName}`,
    thumbnail: `/media/${shopId}/${thumbName}`,
    variants: {
      optimized: {
        filename: optimizedName,
        url: `/media/${shopId}/${optimizedName}`,
        bytes: optimizedStat.size
      },
      thumbnail: {
        filename: thumbName,
        url: `/media/${shopId}/${thumbName}`,
        bytes: thumbStat.size
      }
    },
    source: {
      bytes: file.size,
      mime: file.mimetype,
      width: metadata.width || null,
      height: metadata.height || null,
      format: metadata.format || null
    }
  };
}

const webhookRateLimit = createRateLimiter({
  name: 'webhook',
  windowMs: Number(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.WEBHOOK_RATE_LIMIT_MAX) || 300
});

// ========== XÁC THỰC CHỮ KÝ FB ==========
function verifySignature(req) {
  if (!FB_APP_SECRET) return true;
  const sig = req.get('X-Hub-Signature-256');
  if (!sig || !sig.startsWith('sha256=') || !req.rawBody) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', FB_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function inferBaseUrlFromRequest(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const host = req.get('host');
  if (!host) return '';
  return `${req.protocol || 'https'}://${host}`;
}

// Fix SHOPS_DIR to absolute path on Railway Volume /data
const SHOPS_DIR = process.env.SHOPS_DIR || (fs.existsSync('/data') ? '/data/shops' : path.join(__dirname, 'shops'));

// Đảm bảo thư mục assets luôn tồn tại để tránh lỗi serve
const ASSETS_DIR = path.join(__dirname, 'assets');
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
app.use('/assets', express.static(ASSETS_DIR));

// ========== HEALTH CHECK ==========
app.get('/', (_req, res) => res.send('🤖 ZenBot đang chạy!'));
app.get('/healthz', async (_req, res) => {
  const checks = {
    uptime: Math.round(process.uptime()),
    mongodb: {
      ok: mongoose.connection.readyState === 1,
      state: mongoose.connection.readyState
    },
    redis: { ok: false },
    dataDir: { ok: false, path: processor.storage.getDataDir() },
    shopsDir: { ok: false, path: SHOPS_DIR },
    queue: { ok: false, name: messageQueue.name }
  };

  try {
    await redisConnection.ping();
    checks.redis.ok = true;
  } catch (err) {
    checks.redis.error = err.message;
  }

  try {
    await messageQueue.waitUntilReady();
    checks.queue.ok = true;
  } catch (err) {
    checks.queue.error = err.message;
  }

  async function checkWritableDir(target, key) {
    try {
      await fs.promises.mkdir(target, { recursive: true });
      const probe = path.join(target, `.health-${process.pid}-${Date.now()}`);
      await fs.promises.writeFile(probe, 'ok', 'utf8');
      await fs.promises.unlink(probe);
      checks[key].ok = true;
    } catch (err) {
      checks[key].error = err.message;
    }
  }

  await Promise.all([
    checkWritableDir(checks.dataDir.path, 'dataDir'),
    checkWritableDir(checks.shopsDir.path, 'shopsDir')
  ]);

  const ok = checks.mongodb.ok && checks.redis.ok && checks.dataDir.ok && checks.shopsDir.ok && checks.queue.ok;
  res.status(ok ? 200 : 503).json({ ok, checks });
});

// ========== SERVE ẢNH SẢN PHẨM (Multi-tenant) ==========
app.get('/media/:shopId/:filename', (req, res) => {
  const { shopId, filename } = req.params;
  const safeShopId = String(shopId || '').replace(/[\\/]/g, '');
  const safeFilename = String(filename || '').replace(/[\\/]/g, '');
  
  // Tìm ảnh trong thư mục của shop (ưu tiên Volume)
  const shopImgPath = path.join(SHOPS_DIR, safeShopId, 'images', safeFilename);
  if (fs.existsSync(shopImgPath)) return res.sendFile(shopImgPath);

  // Fallback tìm trong thư mục assets chung
  const assetsPath = path.join(__dirname, 'assets', safeFilename);
  if (fs.existsSync(assetsPath)) return res.sendFile(assetsPath);

  res.sendStatus(404);
});

// ========== WEBHOOK VERIFY (Meta yêu cầu) ==========
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ========== NHẬN TIN NHẮN (THE PRODUCER) ==========
app.post('/webhook', webhookRateLimit, async (req, res) => {
  if (!verifySignature(req)) {
    console.warn('⚠️  Sai chữ ký webhook, từ chối request.');
    return res.sendStatus(403);
  }

  const correlationId = req.get('x-request-id') || req.get('x-correlation-id') || crypto.randomUUID();
  res.set('x-correlation-id', correlationId);

  const body = req.body;
  if (body.object !== 'page') {
    return res.status(200).send('EVENT_RECEIVED');
  }

  const baseUrlOverride = inferBaseUrlFromRequest(req);

  // Cache mapping pageId -> shopId
  const shopCache = app.get('shopCache') || new Map();
  if (!app.get('shopCache')) app.set('shopCache', shopCache);

  let enqueueFailed = false;

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    let shopId = shopCache.get(pageId);

    if (!shopId) {
      const shop = await Shop.findOne({ "credentials.fbPageId": pageId });
      if (shop) {
        shopId = shop._id;
        shopCache.set(pageId, shopId);
      } else {
        console.error(JSON.stringify({
          level: 'error',
          event: 'webhook.drop.unknown_page',
          correlationId,
          pageId
        }));
        continue;
      }
    }

    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      if (!senderId) continue;

      try {
        await messageQueue.add('process-chat', {
          shopId,
          pageId,
          senderId,
          event,
          baseUrlOverride,
          correlationId
        }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 3600, count: 2000 },
          removeOnFail: { age: 24 * 3600, count: 5000 },
          jobId: event.message?.mid || undefined
        });
        console.log(JSON.stringify({
          level: 'info',
          event: 'webhook.job.enqueued',
          correlationId,
          jobId: event.message?.mid || null,
          shopId,
          senderId,
          pageId
        }));
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'webhook.job.enqueue_failed',
          correlationId,
          shopId,
          senderId,
          pageId,
          message: err.message
        }));
        enqueueFailed = true;
      }
    }
  }

  if (enqueueFailed) {
    return res.status(503).json({
      ok: false,
      correlationId,
      message: 'Failed to enqueue one or more webhook events'
    });
  }

  return res.status(200).send('EVENT_RECEIVED');
});

// ========== ZENBOT CENTRAL (SHOP MANAGEMENT API) ==========
const ADMIN_EXPORT_TOKEN = process.env.ADMIN_EXPORT_TOKEN || '';
const ALLOW_UNSAFE_ADMIN_WITHOUT_TOKEN = process.env.ALLOW_UNSAFE_ADMIN_WITHOUT_TOKEN === 'true';

app.use('/api/admin', adminRateLimit);
app.use('/admin', adminRateLimit);

function sanitizeShop(shop) {
  const raw = typeof shop.toObject === 'function' ? shop.toObject() : { ...shop };
  return {
    ...raw,
    credentials: {
      fbPageId: raw.credentials?.fbPageId || '',
      hasFbPageToken: Boolean(raw.credentials?.fbPageToken),
      hasGeminiApiKey: Boolean(raw.credentials?.geminiApiKey),
      hasTelegramBotToken: Boolean(raw.credentials?.telegramBotToken),
      hasGoogleSheetUrl: Boolean(raw.credentials?.googleSheetUrl),
      telegramChatId: raw.credentials?.telegramChatId || ''
    }
  };
}

function clearRuntimeCache(shopId) {
  try {
    const { RUNTIME_CACHE } = require('./core/processor');
    RUNTIME_CACHE?.delete(shopId);
  } catch (err) {
    console.error('❌ Không thể clear runtime cache:', err.message);
  }
}

function clearShopRouteCache() {
  const shopCache = app.get('shopCache');
  if (shopCache?.clear) shopCache.clear();
}

function isValidShopId(id) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(String(id || ''));
}

function requireValidShopId(req, res, next) {
  const shopId = req.params.shopId || req.params.id;
  if (!isValidShopId(shopId)) {
    return res.status(400).json({ message: 'Shop ID không hợp lệ' });
  }
  next();
}

function getRequestedShopScope(req) {
  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  if (req.params?.shopId) return req.params.shopId;
  if (pathname === '/api/admin/shops' && req.method === 'POST') {
    return req.body?._id || req.body?.shopId || req.query?.shopId;
  }
  if (pathname.startsWith('/api/admin/shops/') && req.params?.id) {
    return req.params.id;
  }
  return req.body?.shopId || req.query?.shopId;
}

// ========== AUTHENTICATION & AUTHORIZATION ==========
const adminAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || req.query.token;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;

  if (!token) {
    return res.status(401).json({ message: 'Vui lòng đăng nhập để truy cập' });
  }

  try {
    // Nếu token trùng với ADMIN_EXPORT_TOKEN (bypass cho legacy/seeding), cho phép tiếp tục
    if (ADMIN_EXPORT_TOKEN && token === ADMIN_EXPORT_TOKEN) {
      req.user = { role: 'admin', shopIds: [] }; // Mock admin user
      return next();
    }

    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    req.user = decoded;

    // Check Authorization (Multi-tenant check)
    const requestedShopId = getRequestedShopScope(req);
    
    // Nếu là platform admin, cho phép tất cả
    if (req.user.role === 'admin') return next();

    // Nếu là staff, phải kiểm tra shopId có trong list được phép không
    if (requestedShopId && requestedShopId !== 'all') {
      if (!req.user.shopIds.includes(requestedShopId)) {
        return res.status(403).json({ message: 'Bạn không có quyền truy cập shop này' });
      }
    } else if (requestedShopId === 'all' && req.user.role !== 'admin') {
       // Staff không được xem "All Shops"
       return res.status(403).json({ message: 'Quyền xem toàn bộ hệ thống chỉ dành cho Admin' });
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Phiên làm việc hết hạn, vui lòng đăng nhập lại' });
  }
};

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, isActive: true });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: 'Email hoặc mật khẩu không chính xác' });
    }

    const token = jwt.sign(
      { userId: user._id, email: user.email, role: user.role, shopIds: user.shopIds },
      EFFECTIVE_JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { email: user.email, role: user.role, shopIds: user.shopIds, name: user.name }
    });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi đăng nhập: ' + err.message });
  }
});

app.get('/api/admin/shops', adminAuth, async (req, res) => {
  try {
    const filter = req.user?.role === 'admin'
      ? {}
      : { _id: { $in: req.user?.shopIds || [] } };
    const shops = await Shop.find(filter).sort({ createdAt: -1 }).lean();
    res.json(shops.map(sanitizeShop));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admin/shops', adminAuth, async (req, res) => {
  try {
    if (!isValidShopId(req.body?._id)) {
      return res.status(400).json({ message: 'Shop ID không hợp lệ' });
    }
    const shop = new Shop(req.body);
    await shop.save();
    clearRuntimeCache(shop._id);
    clearShopRouteCache();
    res.status(201).json(sanitizeShop(shop));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.patch('/api/admin/shops/:id', adminAuth, requireValidShopId, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    // Xử lý nested objects cho credentials và features
    if (req.body.credentials) {
      const shop = await Shop.findById(id);
      if (!shop) return res.status(404).json({ message: 'Shop không tồn tại' });
      updateData.credentials = { ...(shop.credentials || {}), ...req.body.credentials };
    }
    if (req.body.features) {
      const shop = await Shop.findById(id);
      if (!shop) return res.status(404).json({ message: 'Shop không tồn tại' });
      updateData.features = { ...(shop.features || {}), ...req.body.features };
    }
    
    const shop = await Shop.findByIdAndUpdate(id, updateData, { new: true });
    if (!shop) return res.status(404).json({ message: 'Shop không tồn tại' });
    clearRuntimeCache(id);
    clearShopRouteCache();
    res.json(sanitizeShop(shop));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete('/api/admin/shops/:id', adminAuth, requireValidShopId, async (req, res) => {
  try {
    await Shop.findByIdAndDelete(req.params.id);
    clearRuntimeCache(req.params.id);
    clearShopRouteCache();
    res.json({ message: 'Shop deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== ADMIN EXPORT & LEADS ==========
const storage = processor.storage;

app.get('/api/admin/leads', adminAuth, async (req, res) => {
  try {
    const { shopId } = req.query;
    const filter = shopId ? { shopId } : {};
    
    // Lấy 500 lead mới nhất từ MongoDB
    const leads = await Lead.find(filter)
      .sort({ at: -1 })
      .limit(500)
      .lean();
    
    res.json(leads);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi lấy danh sách leads từ DB: ' + err.message });
  }
});

// ========== LIVE CHAT ==========
const LIVECHAT_HANDOFF_MS = Number(process.env.LIVECHAT_HANDOFF_MS) || 60 * 60 * 1000;

function livechatStateKey(shopId, senderId) {
  return `${shopId}:${senderId}`;
}

async function persistLivechatState(stateKey) {
  await storage.saveUserToRedis(stateKey, redisConnection).catch(err => {
    console.error('❌ Lỗi lưu handoff livechat vào Redis:', err.message);
  });
}

async function updateLivechatHandoff(stateKey, enabled) {
  await storage.loadUserFromRedis(stateKey, redisConnection);
  storage.setHandoff(stateKey, enabled ? Date.now() + LIVECHAT_HANDOFF_MS : 0);
  await persistLivechatState(stateKey);
}

app.get('/api/admin/livechat/:shopId/conversations', adminAuth, requireValidShopId, async (req, res) => {
  try {
    const { shopId } = req.params;
    const latestLogs = await MessageLog.aggregate([
      { $match: { shopId } },
      { $sort: { timestamp: -1, createdAt: -1 } },
      {
        $group: {
          _id: '$userId',
          lastMessage: { $first: '$text' },
          lastRole: { $first: '$role' },
          lastIntent: { $first: '$intent' },
          lastAt: { $first: '$timestamp' },
          messageCount: { $sum: 1 }
        }
      },
      { $sort: { lastAt: -1 } },
      { $limit: 100 }
    ]);

    const senderIds = latestLogs.map(item => item._id);
    const leads = await Lead.find({ shopId, senderId: { $in: senderIds } }).lean();
    const leadBySender = new Map(leads.map(lead => [lead.senderId, lead]));

    res.json(latestLogs.map(item => {
      const lead = leadBySender.get(item._id) || {};
      const stateKey = livechatStateKey(shopId, item._id);
      return {
        senderId: item._id,
        name: lead.name || '',
        phone: lead.phone || '',
        address: lead.address || '',
        productCode: lead.productCode || '',
        status: lead.status || 'new',
        lastMessage: item.lastMessage || '',
        lastRole: item.lastRole || '',
        lastIntent: item.lastIntent || '',
        lastAt: item.lastAt,
        messageCount: item.messageCount,
        inHandoff: storage.inHandoff(stateKey)
      };
    }));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi tải hội thoại: ' + err.message });
  }
});

app.get('/api/admin/livechat/:shopId/conversations/:senderId', adminAuth, requireValidShopId, async (req, res) => {
  try {
    const { shopId, senderId } = req.params;
    const [lead, messages] = await Promise.all([
      Lead.findOne({ shopId, senderId }).lean(),
      MessageLog.find({ shopId, userId: senderId })
        .sort({ timestamp: 1, createdAt: 1 })
        .limit(200)
        .lean()
    ]);
    const stateKey = livechatStateKey(shopId, senderId);
    res.json({
      senderId,
      lead: lead || null,
      inHandoff: storage.inHandoff(stateKey),
      messages: messages.map(msg => ({
        id: msg._id,
        role: msg.role,
        text: msg.text,
        intent: msg.intent || '',
        timestamp: msg.timestamp || msg.createdAt
      }))
    });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi tải lịch sử chat: ' + err.message });
  }
});

app.post('/api/admin/livechat/:shopId/conversations/:senderId/handoff', adminAuth, requireValidShopId, async (req, res) => {
  try {
    const { shopId, senderId } = req.params;
    const enabled = req.body?.enabled !== false;
    const stateKey = livechatStateKey(shopId, senderId);
    await updateLivechatHandoff(stateKey, enabled);
    res.json({ ok: true, inHandoff: enabled });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi cập nhật handoff: ' + err.message });
  }
});

app.post('/api/admin/livechat/:shopId/conversations/:senderId/messages', adminAuth, requireValidShopId, async (req, res) => {
  try {
    const { shopId, senderId } = req.params;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ message: 'Tin nhắn không được trống' });

    const shop = await Shop.findById(shopId);
    const token = shop?.credentials?.fbPageToken;
    if (!shop || !shop.isActive) return res.status(404).json({ message: 'Shop không tồn tại hoặc đã tắt' });
    if (!token) return res.status(400).json({ message: 'Shop chưa có FB Page Token' });

    const stateKey = livechatStateKey(shopId, senderId);
    await storage.loadUserFromRedis(stateKey, redisConnection);
    storage.setHandoff(stateKey, Date.now() + LIVECHAT_HANDOFF_MS);

    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
      recipient: { id: senderId },
      message: { text }
    }, { timeout: 10000 });

    storage.appendHistory(stateKey, { role: 'bot', text });
    await MessageLog.create({
      shopId,
      userId: senderId,
      role: 'model',
      text,
      intent: 'HUMAN_ADMIN',
      timestamp: new Date()
    });
    await Lead.updateOne(
      { shopId, senderId },
      { $set: { lastInteractionAt: new Date(), handledBy: 'human', text } },
      { upsert: true }
    );
    await persistLivechatState(stateKey);

    res.json({ ok: true, inHandoff: true });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    res.status(500).json({ message: 'Lỗi gửi tin nhắn: ' + detail });
  }
});

function normalizeProductPayload(item, shopId) {
  const code = String(item?.code || '').trim().toUpperCase();
  const preorderRaw = String(item?.preorder ?? '').trim().toLowerCase();
  return {
    shopId,
    code,
    name: String(item?.name || code).trim() || code,
    price: String(item?.price || '').trim(),
    description: String(item?.description || '').trim(),
    size: String(item?.size || '').trim(),
    preorder: item?.preorder === true || ['true', 'yes', 'order', '1'].includes(preorderRaw),
    image: String(item?.image || item?.imageFile || item?.image_file || '').trim(),
    stockCount: Number.isFinite(Number(item?.stockCount)) ? Number(item.stockCount) : 0,
    isActive: true
  };
}

function serializeProduct(product) {
  const raw = typeof product.toObject === 'function' ? product.toObject() : product;
  return {
    code: raw.code || '',
    name: raw.name || raw.code || '',
    price: raw.price || '',
    description: raw.description || '',
    size: raw.size || '',
    preorder: Boolean(raw.preorder),
    image: raw.image || '',
    stockCount: raw.stockCount || 0
  };
}

// ========== PRODUCT MANAGEMENT ==========
app.get('/api/admin/products/:shopId', adminAuth, requireValidShopId, async (req, res) => {
  try {
    const csvPath = path.join(SHOPS_DIR, req.params.shopId, 'products.csv');
    const { getProductsForShop } = require('./core/products');
    const products = await getProductsForShop(req.params.shopId, csvPath);
    res.json(products.map(serializeProduct));
  } catch (err) {
    res.status(500).json({ message: 'Lỗi đọc sản phẩm: ' + err.message });
  }
});

// ========== ANALYTICS & CACHING ==========
const analyticsCache = new Map();
const CACHE_TTL = 60000; // 60s

app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const { shopId, range } = req.query;
    const cacheKey = `analytics:${shopId || 'all'}:${range || '7d'}`;
    
    // 1. Check Cache
    const cached = analyticsCache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return res.json(cached.data);
    }

    // 2. Build Filter
    const filter = {};
    if (shopId && shopId !== 'all') filter.shopId = shopId;
    
    const days = range === '30d' ? 30 : 7;
    const since = new Date();
    since.setDate(since.getDate() - days);
    filter.timestamp = { $gte: since };

    // 3. Import models for aggregation
    const FunnelEvent = require('./core/models/FunnelEvent');
    const Lead = require('./core/models/Lead');

    // 4. Run Aggregations in Parallel
    const [leadGrowth, intentDist, funnelStats] = await Promise.all([
      // Lead Growth (vẫn lấy từ Lead collection vì đây là dữ liệu khách hàng thực)
      Lead.aggregate([
        { $match: { ...(shopId && shopId !== 'all' ? { shopId } : {}), createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),

      // Intent Distribution (Lấy từ FunnelEvent mới triển khai)
      FunnelEvent.aggregate([
        { $match: filter },
        {
          $group: {
            _id: "$intent",
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } }
      ]),

      // AI handled rate (Lấy từ Lead collection)
      Lead.aggregate([
        { $match: { ...(shopId && shopId !== 'all' ? { shopId } : {}), createdAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            ai: {
              $sum: {
                $cond: [{ $eq: ["$handledBy", "ai"] }, 1, 0]
              }
            }
          }
        }
      ])
    ]);

    const stats = funnelStats[0] || { total: 0, ai: 0 };
    const aiRate = stats.total > 0 ? (stats.ai / stats.total) : 0;

    // Tính toán conversion rate từ FunnelEvent
    const intentMap = {};
    intentDist.forEach(i => intentMap[i._id] = i.count);
    const askPrice = intentMap['ASK_PRICE'] || 0;
    const buyIntent = intentMap['BUY_INTENT'] || 0;
    const conversionRate = askPrice > 0 ? parseFloat((buyIntent / askPrice).toFixed(4)) : 0;

    const data = {
      leadGrowth: leadGrowth.map(r => ({ date: r._id, count: r.count })),
      intentDistribution: intentDist.map(r => ({ intent: r._id || 'UNKNOWN', count: r.count })),
      aiRate: parseFloat(aiRate.toFixed(2)),
      conversionRate
    };

    // 4. Update Cache
    analyticsCache.set(cacheKey, {
      data,
      expiry: Date.now() + CACHE_TTL
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi aggregation: ' + err.message });
  }
});

// ========== CAMPAIGN ROUTES ==========

app.get('/api/admin/campaigns', adminAuth, async (req, res) => {
  try {
    const { shopId } = req.query;
    const filter = (shopId && shopId !== 'all') ? { shopId } : {};
    const Campaign = require('./core/models/Campaign');
    const campaigns = await Campaign.find(filter).sort({ createdAt: -1 });
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admin/campaigns', adminAuth, async (req, res) => {
  try {
    const Campaign = require('./core/models/Campaign');
    const data = { ...req.body };
    
    // Nếu client gửi conditions (dạng UI builder) thì convert sang mongo query
    if (data.conditions && Array.isArray(data.conditions)) {
      data.segmentQuery = buildMongoQuery(data.conditions);
    }
    
    const campaign = new Campaign(data);
    await campaign.save();
    res.status(201).json(campaign);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ========== SEGMENTATION ROUTES ==========

app.post('/api/admin/segments/preview', adminAuth, async (req, res) => {
  try {
    const { shopId, conditions } = req.body;
    if (!shopId || !conditions) return res.status(400).json({ message: 'Thiếu shopId hoặc conditions' });
    
    const Lead = require('./core/models/Lead');
    const query = buildMongoQuery(conditions);
    query.shopId = shopId;
    
    const count = await Lead.countDocuments(query);
    res.json({ count, query }); // Trả về query để debug nếu cần
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get('/api/admin/segments/presets', adminAuth, (req, res) => {
  res.json(PRESETS);
});

app.delete('/api/admin/campaigns/:id', adminAuth, async (req, res) => {
  try {
    const Campaign = require('./core/models/Campaign');
    await Campaign.findByIdAndDelete(req.params.id);
    res.json({ message: 'Đã xóa chiến dịch' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

function jsonToCsv(items) {
  if (!items || !items.length) return '';
  const header = Object.keys(items[0]);
  const rows = items.map(item => header.map(col => {
    let val = item[col] || '';
    if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
      val = '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  }).join(','));
  return [header.join(','), ...rows].join('\n');
}

// ========== UPLOAD ẢNH SẢN PHẨM ==========
const multer = require('multer');
const storageMulter = multer.diskStorage({
  destination: (req, file, cb) => {
    const shopId = req.params.shopId || 'default';
    const dir = path.join(SHOPS_DIR, shopId, 'images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({ 
  storage: storageMulter,
  limits: { fileSize: 5 * 1024 * 1024 }, // Giới hạn 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = /^image\/(jpeg|png|webp)$/.test(String(file.mimetype || '').toLowerCase());
    if (allowed.test(ext) && mimeOk) cb(null, true);
    else cb(new Error('Chỉ hỗ trợ ảnh (jpg, png, webp)'));
  }
});

app.post('/api/admin/upload/:shopId', uploadRateLimit, adminAuth, requireValidShopId, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Vui lòng chọn file' });
    
    const shopId = req.params.shopId;
    const imageAsset = await processUploadedImage(req.file, shopId);

    // Nếu là upload ảnh đại diện/logo cho Shop thì cập nhật vào MongoDB
    if (req.query.type === 'shop') {
      await Shop.findByIdAndUpdate(shopId, { image_url: imageAsset.url });
    }

    res.json(imageAsset);
  } catch (err) {
    if (req.file?.path) {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admin/products/:shopId', adminAuth, requireValidShopId, async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ message: 'Payload sản phẩm phải là một mảng' });
    }

    const shopId = req.params.shopId;
    const products = req.body
      .map(item => normalizeProductPayload(item, shopId))
      .filter(item => item.code);

    const seen = new Set();
    const uniqueProducts = products.filter(item => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });

    if (uniqueProducts.length) {
      await Product.bulkWrite(uniqueProducts.map(item => ({
        updateOne: {
          filter: { shopId, code: item.code },
          update: { $set: item },
          upsert: true
        }
      })), { ordered: false });
    }

    await Product.updateMany(
      { shopId, code: { $nin: uniqueProducts.map(item => item.code) } },
      { $set: { isActive: false } }
    );

    // CSV chỉ còn là bản backup/import legacy; MongoDB là nguồn dữ liệu chính của dashboard.
    const file = path.join(SHOPS_DIR, shopId, 'products.csv');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const csvContent = jsonToCsv(uniqueProducts.map(serializeProduct));
    fs.writeFileSync(file, csvContent, 'utf8');

    clearRuntimeCache(shopId);
    console.log(`♻️  Đã clear cache cho shop: ${shopId} (do cập nhật sản phẩm)`);

    res.json({ message: 'Đã lưu sản phẩm thành công', count: uniqueProducts.length });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi lưu sản phẩm: ' + err.message });
  }
});

app.get('/admin/customers.csv', (req, res) => {
  const token = req.query.token || req.get('x-admin-token');
  if (!ADMIN_EXPORT_TOKEN && !ALLOW_UNSAFE_ADMIN_WITHOUT_TOKEN) {
    return res.sendStatus(503);
  }
  if (ADMIN_EXPORT_TOKEN && token !== ADMIN_EXPORT_TOKEN) {
    return res.sendStatus(401);
  }
  const file = storage.getCustomersFile();
  if (!fs.existsSync(file)) return res.status(404).send('Chưa có file customers.csv.');
  res.download(file, 'customers.csv');
});

app.get('/admin/state/:userId', (req, res) => {
  const token = req.query.token || req.get('x-admin-token');
  if (!ADMIN_EXPORT_TOKEN && !ALLOW_UNSAFE_ADMIN_WITHOUT_TOKEN) {
    return res.sendStatus(503);
  }
  if (ADMIN_EXPORT_TOKEN && token !== ADMIN_EXPORT_TOKEN) {
    return res.sendStatus(401);
  }
  const userId = req.params.userId;
  res.json({
    userId,
    inHandoff: storage.inHandoff(userId),
    lastProductCode: storage.getLastProductCode(userId),
    orderDraft: storage.getOrderDraft(userId),
    sessionState: storage.getSessionState(userId)
  });
});

// ========== GRACEFUL SHUTDOWN ==========
let isShuttingDown = false;
const server = app.listen(PORT, () => {
  console.log(`🚀 Webhook Server (ZenBot) đang chạy trên port ${PORT}`);
});

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`🛑 Nhận ${signal}, đang dừng server...`);

  const closeWithTimeout = async (label, task) => {
    try {
      await Promise.race([
        task(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), 10000))
      ]);
    } catch (err) {
      console.error(`❌ Lỗi khi đóng ${label}:`, err.message);
    }
  };

  await closeWithTimeout('http server', () => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  }));
  stopSheetOutboxWorker();
  await closeWithTimeout('bullmq worker', () => chatWorker.close());
  await closeWithTimeout('bullmq queue', () => messageQueue.close());
  await closeWithTimeout('redis', () => redisConnection.quit());
  await closeWithTimeout('mongodb', () => mongoose.connection.close(false));

  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
