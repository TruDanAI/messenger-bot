const fs = require('fs');
const path = require('path');
const axios = require('axios');
const storage = require('./storage');

const OUTBOX_FILE = path.join(storage.getDataDir(), 'sheet-outbox.jsonl');
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const OUTBOX_INTERVAL_MS = 15 * 60 * 1000;
let outboxWriteQueue = Promise.resolve();
let outboxDrainInFlight = false;
let outboxTimer = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (status && status >= 500) return true;
  const code = String(err?.code || '').toUpperCase();
  return [
    'ECONNABORTED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ERR_NETWORK'
  ].includes(code) || !err?.response;
}

function leadLabel(leadData) {
  return leadData?.name || leadData?.phone || leadData?.senderId || 'lead';
}

async function postSheetOnce(url, leadData) {
  return axios.post(url, leadData, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
    maxRedirects: 5
  });
}

async function sendWithRetry(url, leadData) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const { status } = await postSheetOnce(url, leadData);
      if (status >= 200 && status < 300) return { ok: true, attempt, status };
      lastError = new Error(`HTTP ${status}`);
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
      }
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt >= RETRY_ATTEMPTS) break;
      await sleep(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
    }
  }
  return { ok: false, error: lastError };
}

function stringifyError(err) {
  if (!err) return 'unknown_error';
  return JSON.stringify({
    message: err.message || 'unknown_error',
    code: err.code || '',
    status: err.response?.status || '',
    data: err.response?.data || ''
  });
}

function appendOutbox(record) {
  const line = `${JSON.stringify(record)}\n`;
  outboxWriteQueue = outboxWriteQueue
    .then(() => fs.promises.appendFile(OUTBOX_FILE, line, 'utf8'))
    .catch(err => {
      console.error('❌ Lỗi ghi sheet-outbox.jsonl:', err.message);
    });
  return outboxWriteQueue;
}

async function writeOutboxAtomic(records) {
  const tempFile = `${OUTBOX_FILE}.tmp`;
  const body = records.length ? `${records.map(x => JSON.stringify(x)).join('\n')}\n` : '';
  await fs.promises.writeFile(tempFile, body, 'utf8');
  await fs.promises.rename(tempFile, OUTBOX_FILE);
}

async function drainOutbox() {
  if (outboxDrainInFlight) return;
  outboxDrainInFlight = true;
  try {
    await outboxWriteQueue;
    if (!fs.existsSync(OUTBOX_FILE)) return;

    const url = String(process.env.GOOGLE_SHEET_WEBHOOK_URL || '').trim();
    if (!url) {
      console.warn('⚠️ Outbox worker: thiếu GOOGLE_SHEET_WEBHOOK_URL, tạm hoãn replay.');
      return;
    }

    const content = await fs.promises.readFile(OUTBOX_FILE, 'utf8');
    const lines = content.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) return;

    const pending = [];
    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        pending.push({ enqueuedAt: new Date().toISOString(), parseError: true, raw: line });
        continue;
      }
      const leadData = item?.leadData || null;
      if (!leadData) {
        pending.push(item);
        continue;
      }
      const result = await sendWithRetry(url, leadData);
      if (result.ok) {
        console.log(`✅ Replay outbox thành công (${leadLabel(leadData)}) sau lỗi tạm thời.`);
      } else {
        pending.push({
          ...item,
          lastRetryAt: new Date().toISOString(),
          retryError: stringifyError(result.error)
        });
      }
    }

    await writeOutboxAtomic(pending);
  } catch (err) {
    console.error('❌ Outbox worker lỗi:', err.message);
  } finally {
    outboxDrainInFlight = false;
  }
}

function startSheetOutboxWorker(opts = {}) {
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : OUTBOX_INTERVAL_MS;
  if (outboxTimer) return outboxTimer;

  outboxTimer = setInterval(() => {
    void drainOutbox();
  }, intervalMs);
  outboxTimer.unref?.();
  void drainOutbox();
  return outboxTimer;
}

/**
 * Đẩy lead lên Google Sheets qua Apps Script / endpoint tuỳ chỉnh.
 * Nếu lỗi tạm thời sẽ retry; fail sau retry sẽ đẩy vào outbox để worker nền replay.
 */
async function pushLeadToSheet(leadData) {
  const url = String(process.env.GOOGLE_SHEET_WEBHOOK_URL || '').trim();
  if (!url) {
    console.warn('⚠️ GOOGLE_SHEET_WEBHOOK_URL chưa cấu hình — bỏ qua đồng bộ Google Sheet.');
    return false;
  }

  const result = await sendWithRetry(url, leadData);
  if (result.ok) {
    console.log(`✅ Đã gửi lead (${leadLabel(leadData)}) tới Google Sheets (HTTP ${result.status}, attempt ${result.attempt}).`);
    return true;
  }

  const errorText = stringifyError(result.error);
  console.error(`❌ Đẩy Google Sheets thất bại sau ${RETRY_ATTEMPTS} lần: ${errorText}`);
  await appendOutbox({
    enqueuedAt: new Date().toISOString(),
    dedupeKey: leadData?.dedupeKey || '',
    leadData,
    lastError: errorText
  });
  return false;
}

module.exports = { pushLeadToSheet, startSheetOutboxWorker };
