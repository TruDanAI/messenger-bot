require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');
const { connectDB } = require('./core/db');
const { messageQueue, connection: redisConnection } = require('./core/queue');
const { startSheetOutboxWorker } = require('./core/sheets-webhook');
const Shop = require('./core/models/Shop');
require('./core/worker'); // Khởi động BullMQ Worker chạy ngầm cùng server

// Lazy-load processor để lấy IMAGE_INDEX (tránh circular load)
const processor = require('./core/processor');

// Kết nối DB — chỉ gọi MỘT lần duy nhất ở đây
connectDB().then(() => {
  // Khởi động worker xử lý hàng đợi Google Sheets sau khi DB sẵn sàng
  startSheetOutboxWorker();
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
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
app.use('/static', express.static('/data'));

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

  // TRẢ VỀ 200 NGAY LẬP TỨC để Meta không retry
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  if (body.object !== 'page') return;

  const baseUrlOverride = inferBaseUrlFromRequest(req);

  // Cache mapping pageId -> shopId
  const shopCache = app.get('shopCache') || new Map();
  if (!app.get('shopCache')) app.set('shopCache', shopCache);

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    let shopId = shopCache.get(pageId);

    if (!shopId) {
      const shop = await Shop.findOne({ "credentials.fbPageId": pageId });
      if (shop) {
        shopId = shop._id;
        shopCache.set(pageId, shopId);
      } else {
        shopId = process.env.SHOP_ID || 'adult-shop';
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
          baseUrlOverride
        }, {
          attempts: 3,
          backoff: { type: 'fixed', delay: 5000 },
          jobId: event.message?.mid || undefined
        });
      } catch (err) {
        console.error('❌ Lỗi thêm vào Queue:', err.message);
      }
    }
  }
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

function adminAuth(req, res, next) {
  if (!ADMIN_EXPORT_TOKEN && !ALLOW_UNSAFE_ADMIN_WITHOUT_TOKEN) {
    return res.status(503).json({
      message: 'Admin API chưa được cấu hình ADMIN_EXPORT_TOKEN'
    });
  }
  const token = req.query.token || req.get('x-admin-token');
  if (ADMIN_EXPORT_TOKEN && token !== ADMIN_EXPORT_TOKEN) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/shops', adminAuth, async (req, res) => {
  try {
    const shops = await Shop.find().sort({ createdAt: -1 }).lean();
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
    res.json(sanitizeShop(shop));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete('/api/admin/shops/:id', adminAuth, requireValidShopId, async (req, res) => {
  try {
    await Shop.findByIdAndDelete(req.params.id);
    res.json({ message: 'Shop deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ========== ADMIN EXPORT & LEADS ==========
const storage = processor.storage;

app.get('/api/admin/leads', adminAuth, (req, res) => {
  try {
    const file = storage.getCustomersFile();
    if (!fs.existsSync(file)) return res.json([]);
    
    const csv = fs.readFileSync(file, 'utf8');
    const records = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true
    });
    
    // Đảo ngược danh sách để lead mới nhất lên đầu
    res.json(records.reverse());
  } catch (err) {
    res.status(500).json({ message: 'Lỗi đọc file leads: ' + err.message });
  }
});

// ========== PRODUCT MANAGEMENT ==========
app.get('/api/admin/products/:shopId', adminAuth, requireValidShopId, (req, res) => {
  try {
    const file = path.join(SHOPS_DIR, req.params.shopId, 'products.csv');
    if (!fs.existsSync(file)) return res.json([]);
    const csv = fs.readFileSync(file, 'utf8');
    const records = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
    res.json(records);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi đọc file sản phẩm: ' + err.message });
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
    // Giữ nguyên logic đặt tên file để đảm bảo tính duy nhất
    const safeName = file.originalname.replace(/\s+/g, '-').toLowerCase();
    cb(null, Date.now() + '-' + safeName);
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
    // URL truy cập qua web (phục vụ dashboard hiển thị)
    const webUrl = `/media/${shopId}/${req.file.filename}`;

    // Nếu là upload ảnh đại diện/logo cho Shop thì cập nhật vào MongoDB
    if (req.query.type === 'shop') {
      await Shop.findByIdAndUpdate(shopId, { image_url: webUrl });
    }

    res.json({ 
      filename: req.file.filename,
      url: webUrl 
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admin/products/:shopId', adminAuth, requireValidShopId, (req, res) => {
  try {
    const file = path.join(SHOPS_DIR, req.params.shopId, 'products.csv');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const csvContent = jsonToCsv(req.body);
    fs.writeFileSync(file, csvContent, 'utf8');

    // Xóa cache của shop này để bot cập nhật dữ liệu mới ngay lập tức
    const { RUNTIME_CACHE } = require('./core/processor');
    if (RUNTIME_CACHE) {
      RUNTIME_CACHE.delete(req.params.shopId);
      console.log(`♻️  Đã clear cache cho shop: ${req.params.shopId} (do cập nhật sản phẩm)`);
    }

    res.json({ message: 'Đã lưu sản phẩm thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi ghi file sản phẩm: ' + err.message });
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
function shutdown(signal) {
  console.log(`🛑 Nhận ${signal}, đang dừng server...`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

app.listen(PORT, () => {
  console.log(`🚀 Webhook Server (ZenBot) đang chạy trên port ${PORT}`);
});
