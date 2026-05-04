require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { connectDB } = require('./core/db');
const { messageQueue } = require('./core/queue');
require('./core/worker'); // Khởi động Worker chạy ngầm cùng server

// Kết nối DB ngay khi khởi động
connectDB();

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const PORT = process.env.PORT || 3000;

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

// ========== HEALTH CHECK ==========
app.get('/', (_req, res) => res.send('🤖 ZenBot Webhook Server đang chạy!'));
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

// ========== WEBHOOK VERIFY (Meta yêu cầu) ==========
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

function inferBaseUrlFromRequest(req) {
    const forwardedProto = req.get('x-forwarded-proto');
    const forwardedHost = req.get('x-forwarded-host');
    if (forwardedProto && forwardedHost) {
      return `${forwardedProto}://${forwardedHost}`;
    }
  
    const host = req.get('host');
    if (!host) return '';
    const proto = req.protocol || 'https';
    return `${proto}://${host}`;
}

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

  for (const entry of body.entry || []) {
    const pageId = entry.id; // Lỗ hổng #2: Lấy Page ID để định tuyến Shop sau này
    
    // Hiện tại: Tạm hardcode shopId từ env hoặc mặc định để tương thích bản cũ
    const shopId = process.env.SHOP_ID || 'adult-shop';

    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      if (!senderId) continue;

      // NÉM VÀO QUEUE thay vì xử lý ngay
      await messageQueue.add('process-chat', {
        shopId,
        pageId,
        senderId,
        event,
        baseUrlOverride
      }, {
        attempts: 3, // Retry 3 lần nếu lỗi API
        backoff: { type: 'fixed', delay: 5000 },
        jobId: event.message?.mid || undefined // Đảm bảo không xử lý trùng MID
      });
    }
  }
});

// Admin Export CSV vẫn giữ nguyên ở đây vì file CSV đang dùng local
const { storage } = require('./core/processor'); // Sẽ export storage ra tạm thời
app.get('/admin/customers.csv', (req, res) => {
    const ADMIN_EXPORT_TOKEN = process.env.ADMIN_EXPORT_TOKEN;
    const token = req.query.token || req.get('x-admin-token');
    if (ADMIN_EXPORT_TOKEN && token !== ADMIN_EXPORT_TOKEN) {
      return res.sendStatus(401);
    }
    
    // Tạm lấy file của processor.js (vì nó import storage.js)
    const file = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'customers.csv');
    if (!fs.existsSync(file)) return res.status(404).send('Chưa có file customers.csv.');
    res.download(file, 'customers.csv');
});

const path = require('path');

app.listen(PORT, () => {
    console.log(`🚀 Webhook Server (ZenBot) đang chạy trên port ${PORT}`);
});
