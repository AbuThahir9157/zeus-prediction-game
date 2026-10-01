require('dotenv').config(); // Load environment variables from .env file

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

// Load payment gateway credentials safely from environment variables
const TAILPAY_MCH_ID = process.env.TAILPAY_MCH_ID; 
const TAILPAY_SECRET = process.env.TAILPAY_SECRET;
const TAILPAY_API_URL = process.env.TAILPAY_API_URL;

// Safety check to ensure keys are loaded before starting
if (!TAILPAY_MCH_ID || !TAILPAY_SECRET || !TAILPAY_API_URL) {
  console.error("FATAL ERROR: Payment credentials missing in environment variables!");
  process.exit(1);
}

// Helper function to generate tailPay MD5 Signature
function generateTailPaySign(params, secret) {
  const sortedKeys = Object.keys(params)
    .filter(key => key !== 'sign' && params[key] !== null && params[key] !== undefined && params[key] !== '')
    .sort();

  let signStr = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
  if (secret) {
    signStr += `&secret=${secret}`;
  }

  return crypto.createHash('md5').update(signStr).digest('hex');
}

// SQLite database setup
const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY,
    name TEXT,
    balance REAL,
    total_profit REAL,
    total_loss REAL
  )`);
  
  db.run(`INSERT OR IGNORE INTO user (id, name, balance, total_profit, total_loss) 
          VALUES (1, 'ZEUS', 10000, 0, 0)`);
  
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outTradeNo TEXT,
    prediction TEXT,
    stake REAL,
    status TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Serve main HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});

// Fetch user profile
app.get('/api/user/profile', (req, res) => {
  db.get('SELECT * FROM user WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

// Initiate Payment & Prediction via tailPay Gateway
app.post('/api/predict/initiate-payment', async (req, res) => {
  const { prediction, stake } = req.body;

  if (!['ODD', 'EVEN'].includes(prediction) || ![100, 200, 300, 400, 500, 600, 700, 800, 900].includes(stake)) {
    return res.status(400).json({ error: 'Invalid prediction choice or stake amount' });
  }

  const outTradeNo = 'ORD' + Date.now() + Math.floor(1000 + Math.random() * 9000);
  const notifyUrl = `http://${req.headers.host}/api/payment/callback`;

  // Construct request payload according to tailPay specs
  const payload = {
    mchId: TAILPAY_MCH_ID,
    outTradeNo: outTradeNo,
    amount: parseFloat(stake).toFixed(2),
    notifyUrl: notifyUrl,
    attach: JSON.stringify({ prediction, stake, userId: 1 })
  };

  // Generate sign MD5 hash safely using loaded secret key
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
        `INSERT INTO transactions (outTradeNo, prediction, stake, status) VALUES (?, ?, ?, ?)`,
        [outTradeNo, prediction, stake, 'PENDING']
      );

      res.json({ success: true, payUrl: result.data.payUrl });
    } else {
      res.status(400).json({ success: false, error: result.message || 'Payment gateway error' });
    }
  } catch (err) {
    console.error("tailPay Gateway Error:", err);
    res.status(500).json({ success: false, error: 'Failed to connect to payment gateway.' });
  }
});

// Asynchronous Callback Webhook from tailPay
app.post('/api/payment/callback', (req, res) => {
  const { code, mchOrderNo, amount, utr, attach, sign } = req.body;

  // Verify signature
  const checkParams = { ...req.body };
  delete checkParams.sign;
  const expectedSign = generateTailPaySign(checkParams, TAILPAY_SECRET);

  if (sign !== expectedSign) {
    return res.status(400).send('fail');
  }

  // Handle successful payment callback
  if (code === '1' || code === 1) {
    let parsedAttach = {};
    try { parsedAttach = JSON.parse(attach); } catch(e) {}

    const { prediction, stake } = parsedAttach;

    const cleanUtr = utr || Math.floor(100000000000 + Math.random() * 900000000000).toString();
    const lastDigit = parseInt(cleanUtr.slice(-1));
    const actualResult = (lastDigit % 2 !== 0) ? 'ODD' : 'EVEN';
    const isWin = prediction === actualResult;

    let netChange = isWin ? (stake * 0.90) : -stake;

    const updateQuery = isWin
      ? `UPDATE user SET balance = balance + ?, total_profit = total_profit + ? WHERE id = 1`
      : `UPDATE user SET balance = balance - ?, total_loss = total_loss + ? WHERE id = 1`;

    db.run(updateQuery, [Math.abs(netChange), Math.abs(netChange)], () => {
      db.run(
        `UPDATE transactions SET status = ? WHERE outTradeNo = ?`,
        [isWin ? 'WIN' : 'LOSS', mchOrderNo]
      );
    });
  }

  res.send('success');
});

app.listen(PORT, () => {
  console.log(`Server running securely on port ${PORT}`);
});