const FunnelEvent = require('./models/FunnelEvent');
const DiscoveryLog = require('./models/DiscoveryLog');

/**
 * Ghi vết intent khách hàng để tính tỷ lệ chuyển đổi
 */
async function trackIntent(shopId, userId, intent) {
  try {
    await FunnelEvent.create({ shopId, userId, intent });
  } catch (err) {
    console.error('❌ Analytics Error (trackIntent):', err.message);
  }
}

/**
 * Lưu lại tin nhắn bot không hiểu để discovery
 */
async function logUnknown(shopId, userId, text) {
  try {
    await DiscoveryLog.create({ shopId, userId, text });
  } catch (err) {
    console.error('❌ Analytics Error (logUnknown):', err.message);
  }
}

/**
 * Tính toán Conversion Rate cho Dashboard
 */
async function getConversionStats(shopId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const stats = await FunnelEvent.aggregate([
    { $match: { shopId, timestamp: { $gte: since } } },
    { $group: { _id: '$intent', count: { $sum: 1 } } }
  ]);

  const map = {};
  stats.forEach(s => map[s._id] = s.count);

  const askPrice = map['ASK_PRICE'] || 0;
  const buyIntent = map['BUY_INTENT'] || 0;
  
  return {
    askPrice,
    buyIntent,
    conversionRate: askPrice > 0 ? parseFloat((buyIntent / askPrice).toFixed(4)) : 0,
    raw: map
  };
}

module.exports = {
  trackIntent,
  logUnknown,
  getConversionStats
};
