const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// DATA_DIR có thể trỏ sang Railway Volume, ví dụ DATA_DIR=/data.
// Nếu không set env, bot vẫn dùng thư mục data/ local như trước.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'chat-state.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.csv');
const MIDS_FILE = path.join(DATA_DIR, 'processed-mids.json');
const CUSTOMER_HEADERS = ['at', 'type', 'senderId', 'productCode', 'phone', 'name', 'address', 'text', 'history'];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
ensureCustomersFile();

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`⚠️ Không đọc được ${file}, dùng giá trị mặc định.`);
    return fallback;
  }
}

const state = loadJSON(STATE_FILE, { history: {}, handoff: {}, context: {} });
if (!state.history) state.history = {};
if (!state.handoff) state.handoff = {};
if (!state.context) state.context = {};
const mids = new Set(loadJSON(MIDS_FILE, []));
const MID_LIMIT = 5000;
let customerWriteQueue = Promise.resolve();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(STATE_FILE, JSON.stringify(state), err => {
      if (err) console.error('Lỗi ghi state:', err.message);
    });
    fs.writeFile(MIDS_FILE, JSON.stringify([...mids].slice(-MID_LIMIT)), err => {
      if (err) console.error('Lỗi ghi mids:', err.message);
    });
  }, 1500);
}

function csvCell(value) {
  const text = value == null
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

  // Escape theo chuẩn CSV: dấu " trong nội dung phải nhân đôi, ô có dấu phẩy/xuống dòng phải bọc quote.
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function ensureCustomersFile() {
  if (!fs.existsSync(CUSTOMERS_FILE)) {
    fs.writeFileSync(CUSTOMERS_FILE, CUSTOMER_HEADERS.join(',') + '\n');
    return;
  }

  const csv = fs.readFileSync(CUSTOMERS_FILE, 'utf8');
  const firstLine = csv.split(/\r?\n/, 1)[0] || '';
  const currentHeaders = firstLine.split(',').map(header => header.trim());
  const hasAllHeaders = CUSTOMER_HEADERS.every(header => currentHeaders.includes(header));
  if (hasAllHeaders) return;

  try {
    const rows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false
    });
    const migrated = [
      CUSTOMER_HEADERS.join(','),
      ...rows.map(row => CUSTOMER_HEADERS.map(header => csvCell(row[header] || '')).join(','))
    ].join('\n') + '\n';
    fs.writeFileSync(CUSTOMERS_FILE, migrated, 'utf8');
    console.log('✅ Đã nâng cấp customers.csv với các cột lead mới.');
  } catch (e) {
    console.warn(`⚠️ Không nâng cấp được customers.csv: ${e.message}`);
  }
}

function appendCustomerQueued(customer) {
  const line = CUSTOMER_HEADERS
    .map(key => csvCell(customer[key]))
    .join(',') + '\n';

  // Queue này đảm bảo trong cùng một process Node chỉ có 1 lệnh appendFile chạy tại một thời điểm.
  // Nhờ vậy khi nhiều khách gửi SĐT đồng thời, mỗi lead vẫn được ghi thành một dòng CSV riêng.
  customerWriteQueue = customerWriteQueue
    .then(() => fs.promises.appendFile(CUSTOMERS_FILE, line, 'utf8'))
    .catch(err => {
      console.error('Lỗi ghi customers.csv:', err.message);
    });

  return customerWriteQueue;
}

module.exports = {
  getHistory(userId) {
    return state.history[userId] ? [...state.history[userId]] : [];
  },

  setHistory(userId, history) {
    state.history[userId] = history;
    scheduleSave();
  },

  setHandoff(userId, until) {
    state.handoff[userId] = until;
    scheduleSave();
  },

  inHandoff(userId) {
    const until = state.handoff[userId];
    if (!until) return false;
    if (Date.now() > until) {
      delete state.handoff[userId];
      scheduleSave();
      return false;
    }
    return true;
  },

  getLastProductCode(userId) {
    return state.context[userId]?.lastProductCode || '';
  },

  setLastProductCode(userId, code) {
    if (!userId || !code) return;
    if (!state.context[userId]) state.context[userId] = {};
    state.context[userId].lastProductCode = code;
    scheduleSave();
  },

  seenMid(mid) {
    return mids.has(mid);
  },

  markMid(mid) {
    mids.add(mid);
    if (mids.size > MID_LIMIT) {
      const arr = [...mids];
      mids.clear();
      arr.slice(-MID_LIMIT).forEach(m => mids.add(m));
    }
    scheduleSave();
  },

  appendCustomer(customer) {
    return appendCustomerQueued({
      at: customer.at || new Date().toISOString(),
      type: customer.type || 'lead',
      senderId: customer.senderId || '',
      productCode: customer.productCode || '',
      phone: customer.phone || '',
      name: customer.name || '',
      address: customer.address || '',
      text: customer.text || '',
      history: customer.history || ''
    });
  }
};
