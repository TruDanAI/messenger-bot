const Campaign = require('./models/Campaign');
const Lead = require('./models/Lead');
const Shop = require('./models/Shop');
const axios = require('axios');
const { trackIntent } = require('./analytics');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendFbMessage(recipientId, text, fbPageToken) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${fbPageToken}`, {
      recipient: { id: recipientId },
      message: { text }
    });
    return true;
  } catch (err) {
    console.error(`❌ Broadcast Fail (User: ${recipientId}):`, err.response?.data || err.message);
    return false;
  }
}

async function processCampaign(campaignId) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign || campaign.status !== 'scheduled') return;

  console.log(`🚀 [BroadcastWorker] Khởi chạy chiến dịch: ${campaign.name}`);
  
  await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'sending' } });
  
  const shop = await Shop.findById(campaign.shopId);
  if (!shop || !shop.credentials?.fbPageToken) {
    await Campaign.updateOne({ _id: campaignId }, { $set: { status: 'failed' } });
    return;
  }

  // Lọc user theo segmentQuery
  // Lưu ý: segmentQuery cần được sanitize và validate trước khi lưu vào DB
  const leads = await Lead.find({ 
    shopId: campaign.shopId,
    ...campaign.segmentQuery 
  }).limit(1000); // Giới hạn 1000 user mỗi chiến dịch để an toàn

  let successCount = 0;
  let errorCount = 0;

  for (const lead of leads) {
    const success = await sendFbMessage(lead.senderId, campaign.messageTemplate, shop.credentials.fbPageToken);
    
    if (success) {
      successCount++;
      await trackIntent(campaign.shopId, lead.senderId, 'BROADCAST_SENT');
    } else {
      errorCount++;
    }

    // Rate limit: 2 tin / giây
    await sleep(500);
  }

  await Campaign.updateOne({ _id: campaignId }, { 
    $set: { 
      status: 'done',
      sentCount: leads.length,
      successCount,
      errorCount
    } 
  });
  
  console.log(`✅ [BroadcastWorker] Chiến dịch hoàn tất: ${campaign.name} (Thành công: ${successCount})`);
}

async function runBroadcastJob() {
  const now = new Date();
  const campaigns = await Campaign.find({ 
    status: 'scheduled', 
    scheduledAt: { $lte: now } 
  });

  for (const campaign of campaigns) {
    await processCampaign(campaign._id);
  }
}

function startBroadcastWorker() {
  console.log('📡 [BroadcastWorker] Đang hoạt động...');
  setInterval(runBroadcastJob, 60 * 1000); // Kiểm tra mỗi phút
}

module.exports = { startBroadcastWorker };
