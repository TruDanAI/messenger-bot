require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { connectDB } = require('./core/db');
const { messageQueue } = require('./core/queue');
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
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, 'public')));

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_APP_SECRET   = process.env.FB_APP_SECRET;
const PORT            = process.env.PORT || 3000;

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

// ========== HEALTH CHECK ==========
app.get('/', (_req, res) => res.send('🤖 ZenBot đang chạy!'));
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ========== SERVE ẢNH SẢN PHẨM ==========
app.get('/media/:filename', (req, res) => {
  const { IMAGE_INDEX } = processor;
  const fullPath = IMAGE_INDEX && IMAGE_INDEX.get(String(req.params.filename || '').toLowerCase());
  if (!fullPath) return res.sendStatus(404);
  res.sendFile(fullPath);
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
app.post('/webhook', async (req, res) => {
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

function adminAuth(req, res, next) {
  const token = req.query.token || req.get('x-admin-token');
  if (ADMIN_EXPORT_TOKEN && token !== ADMIN_EXPORT_TOKEN) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

app.get('/api/admin/shops', adminAuth, async (req, res) => {
  try {
    const shops = await Shop.find().sort({ createdAt: -1 });
    res.json(shops);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post('/api/admin/shops', adminAuth, async (req, res) => {
  try {
    const shop = new Shop(req.body);
    await shop.save();
    res.status(201).json(shop);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.patch('/api/admin/shops/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };
    // Xử lý nested objects cho credentials và features
    if (req.body.credentials) {
      const shop = await Shop.findById(id);
      updateData.credentials = { ...(shop.credentials || {}), ...req.body.credentials };
    }
    if (req.body.features) {
      const shop = await Shop.findById(id);
      updateData.features = { ...(shop.features || {}), ...req.body.features };
    }
    
    const shop = await Shop.findByIdAndUpdate(id, updateData, { new: true });
    res.json(shop);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete('/api/admin/shops/:id', adminAuth, async (req, res) => {
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
app.get('/api/admin/products/:shopId', adminAuth, (req, res) => {
  try {
    const file = path.join(__dirname, 'shops', req.params.shopId, 'products.csv');
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

app.post('/api/admin/products/:shopId', adminAuth, (req, res) => {
  try {
    const file = path.join(__dirname, 'shops', req.params.shopId, 'products.csv');
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const csvContent = jsonToCsv(req.body);
    fs.writeFileSync(file, csvContent, 'utf8');
    res.json({ message: 'Đã lưu sản phẩm thành công' });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi ghi file sản phẩm: ' + err.message });
  }
});

app.get('/admin/customers.csv', (req, res) => {
  const token = req.query.token || req.get('x-admin-token');
  if (ADMIN_EXPORT_TOKEN && token !== ADMIN_EXPORT_TOKEN) {
    return res.sendStatus(401);
  }
  const file = storage.getCustomersFile();
  if (!fs.existsSync(file)) return res.status(404).send('Chưa có file customers.csv.');
  res.download(file, 'customers.csv');
});

app.get('/admin/state/:userId', (req, res) => {
  const token = req.query.token || req.get('x-admin-token');
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
