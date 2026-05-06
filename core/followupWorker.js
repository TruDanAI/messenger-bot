const Lead = require('./models/Lead');
const Shop = require('./models/Shop');
const axios = require('axios');
const { trackIntent } = require('./analytics');

const FOLLOWUP_TEMPLATES = [
  "Dạ mẫu này bên em vẫn còn hàng ạ, mình có muốn em giữ size để lên đơn luôn cho mình không ạ? 😊",
  "Hàng đang về nhanh lắm ạ, mình chốt sớm em giữ mẫu này cho mình nhé? Shop vẫn đang miễn ship ạ! 📦",
  "Nãy mình hỏi sản phẩm này, không biết mình có cần em tư vấn thêm gì để chốt đơn luôn không ạ? shop sẵn sàng hỗ trợ mình nhé! ✨"
];

function pickTemplate(seed) {
  const idx = seed % FOLLOWUP_TEMPLATES.length;
  return FOLLOWUP_TEMPLATES[idx];
}

async function sendFbMessage(recipientId, text, fbPageToken) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${fbPageToken}`, {
      recipient: { id: recipientId },
      message: { text }
    });
    return true;
  } catch (err) {
    console.error(`❌ FollowUp Fail (User: ${recipientId}):`, err.response?.data || err.message);
    return false;
  }
}

async function runFollowUpJob() {
  console.log('🤖 [FollowUpWorker] Đang quét Lead để follow-up...');
  const now = new Date();
  const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000);

  try {
    // Tìm các lead:
    // 1. Có hỏi giá trong quá khứ
    // 2. Lần hỏi giá cuối cùng là > 30 phút trước
    // 3. Chưa chốt đơn HOẶC lần chốt đơn cuối cùng cũ hơn lần hỏi giá cuối cùng
    // 4. Số lần follow-up < 2
    // 5. Lần follow-up cuối cùng (nếu có) cũng phải > 30 phút trước
    const leads = await Lead.find({
      lastAskPriceAt: { $lte: thirtyMinsAgo },
      followUpCount: { $lt: 2 },
      $or: [
        { lastBuyIntentAt: { $exists: false } },
        { $expr: { $gt: ["$lastAskPriceAt", "$lastBuyIntentAt"] } }
      ],
      $or: [
        { lastFollowUpAt: { $exists: false } },
        { lastFollowUpAt: { $lte: thirtyMinsAgo } }
      ]
    });

    if (leads.length === 0) {
      console.log('✅ [FollowUpWorker] Không có Lead nào cần follow-up.');
      return;
    }

    // Cache shop credentials để tránh query lặp trong loop
    const shopCache = new Map();

    for (const lead of leads) {
      let shop = shopCache.get(lead.shopId);
      if (!shop) {
        shop = await Shop.findById(lead.shopId);
        if (shop) shopCache.set(lead.shopId, shop);
      }

      if (!shop || !shop.credentials?.fbPageToken) continue;

      const message = pickTemplate(lead.senderId.length);
      const success = await sendFbMessage(lead.senderId, message, shop.credentials.fbPageToken);

      if (success) {
        await Lead.updateOne(
          { _id: lead._id },
          { 
            $set: { lastFollowUpAt: now },
            $inc: { followUpCount: 1 }
          }
        );
        // Track funnel event cho follow-up
        await trackIntent(lead.shopId, lead.senderId, 'FOLLOW_UP');
        console.log(`🚀 [FollowUp] Đã gửi cho khách ${lead.senderId} (Shop: ${lead.shopId})`);
      }
    }
  } catch (err) {
    console.error('❌ [FollowUpWorker] Lỗi hệ thống:', err.message);
  }
}

// Chạy job mỗi 10 phút
function startFollowUpWorker() {
  // Chạy ngay lập tức khi khởi động
  runFollowUpJob();
  setInterval(runFollowUpJob, 10 * 60 * 1000);
}

module.exports = { startFollowUpWorker };
