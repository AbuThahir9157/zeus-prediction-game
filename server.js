require('dotenv').config();

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const TAILPAY_MCH_ID = process.env.TAILPAY_MCH_ID;
const TAILPAY_SECRET = process.env.TAILPAY_SECRET;
const TAILPAY_API_URL = process.env.TAILPAY_API_URL;

function generateTailPaySign(params, secret) {
  const sortedKeys = Object.keys(params)
    .filter(key => key !== 'sign' && params[key] !== null && params[key] !== undefined && params[key] !== '')
    .sort();

  let signStr = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
  if (secret) signStr += `&secret=${secret}`;

  return crypto.createHash('md5').update(signStr).digest('hex');
}

// Memory Database
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    balance REAL DEFAULT 10000,
    total_profit REAL DEFAULT 0,
    total_loss REAL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    outTradeNo TEXT,
    prediction TEXT,
    stake REAL,
    status TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Authentication / Registration endpoint
app.post('/api/user/auth', (req, res) => {
  const { username } = req.body;
  db.run(`INSERT OR IGNORE INTO users (username) VALUES (?)`, [username], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, username });
  });
});

// User profile retrieval
app.get('/api/user/profile', (req, res) => {
  const username = req.query.username || 'ZEUS';
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'User not found' });
    res.json(row);
  });
});

// Fetch user predictions history
app.get('/api/user/transactions', (req, res) => {
  const username = req.query.username;
  db.all('SELECT * FROM transactions WHERE username = ? ORDER BY id DESC LIMIT 10', [username], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Initiate Payment endpoint
app.post('/api/predict/initiate-payment', async (req, res) => {
  const { username, prediction, stake } = req.body;

  const outTradeNo = 'ORD' + Date.now() + Math.floor(1000 + Math.random() * 9000);
  const notifyUrl = `http://${req.headers.host}/api/payment/callback`;

  const payload = {
    mchId: TAILPAY_MCH_ID,
    outTradeNo: outTradeNo,
    amount: parseFloat(stake).toFixed(2),
    notifyUrl: notifyUrl,
    attach: JSON.stringify({ username, prediction, stake })
  };

  payload.sign = generateTailPaySign(payload, TAILPAY_SECRET);

  try {
    const response = await fetch(TAILPAY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (result.code === 1000 && result.data && result.data.payUrl) {
      db.run(
        `INSERT INTO transactions (username, outTradeNo, prediction, stake, status) VALUES (?, ?, ?, ?, ?)`,
        [username, outTradeNo, prediction, stake, 'PENDING']
      );

      res.json({ success: true, payUrl: result.data.payUrl });
    } else {
      res.status(400).json({ success: false, error: result.message || 'Payment error' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to connect to gateway' });
  }
});

// Callback Webhook
app.post('/api/payment/callback', (req, res) => {
  const { code, mchOrderNo, attach, sign } = req.body;

  const checkParams = { ...req.body };
  delete checkParams.sign;
  if (sign !== generateTailPaySign(checkParams, TAILPAY_SECRET)) {
    return res.status(400).send('fail');
  }

  if (code === '1' || code === 1) {
    let { username, prediction, stake } = JSON.parse(attach || '{}');

    const cleanUtr = Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const actualResult = (parseInt(cleanUtr.slice(-1)) % 2 !== 0) ? 'ODD' : 'EVEN';
    const isWin = prediction === actualResult;
    const netChange = isWin ? (stake * 0.90) : -stake;

    const updateQuery = isWin
      ? `UPDATE users SET balance = balance + ?, total_profit = total_profit + ? WHERE username = ?`
      : `UPDATE users SET balance = balance - ?, total_loss = total_loss + ? WHERE username = ?`;

    db.run(updateQuery, [Math.abs(netChange), Math.abs(netChange), username], () => {
      db.run(`UPDATE transactions SET status = ? WHERE outTradeNo = ?`, [isWin ? 'WIN' : 'LOSS', mchOrderNo]);
    });
  }

  res.send('success');
});

app.listen(PORT, () => {
  console.log(`ZEUS Server running on port ${PORT}`);
});