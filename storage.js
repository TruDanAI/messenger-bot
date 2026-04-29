const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'chat-state.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.jsonl');
const MIDS_FILE = path.join(DATA_DIR, 'processed-mids.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`⚠️ Không đọc được ${file}, dùng giá trị mặc định.`);
    return fallback;
  }
}

const state = loadJSON(STATE_FILE, { history: {}, handoff: {} });
const mids = new Set(loadJSON(MIDS_FILE, []));
const MID_LIMIT = 5000;

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

  appendOrder(order) {
    fs.appendFile(ORDERS_FILE, JSON.stringify(order) + '\n', err => {
      if (err) console.error('Lỗi ghi đơn:', err.message);
    });
  }
};
