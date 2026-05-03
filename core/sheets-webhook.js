const axios = require('axios');

// Web Google App (deploy as Web app, POST handler doPost). Nếu không set thì bỏ qua, không lỗi.
const WEBHOOK_URL = String(process.env.GOOGLE_SHEET_WEBHOOK_URL || '').trim();

/**
 * Đẩy lead lên Google Sheets qua Apps Script / endpoint tuỳ chỉnh.
 * Payload có `dedupeKey` (SHA-256) để phía Sheet bỏ qua trùng khi Meta retry webhook.
 * Gọi không await từ webhook handler để không chặn luồng trả lời Meta.
 */
async function pushLeadToSheet(leadData) {
  if (!WEBHOOK_URL) return;

  try {
    const { data, status } = await axios.post(WEBHOOK_URL, leadData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
      maxRedirects: 5
    });

    if (status >= 200 && status < 300) {
      const label = leadData?.name || leadData?.phone || leadData?.senderId || 'lead';
      console.log(`✅ Đã gửi lead (${label}) tới Google Sheets (HTTP ${status}).`);
    } else {
      console.warn(`⚠️ Google Sheets webhook HTTP ${status}:`, typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200));
    }
  } catch (err) {
    console.error('❌ Lỗi đẩy data lên Google Sheets:', err.response?.data || err.message);
  }
}

module.exports = { pushLeadToSheet };
