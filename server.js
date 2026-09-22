require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const webpush = require('web-push');
const AfricasTalking = require('africastalking');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

// ========== KEYS ==========
const NOTCH_PUBLIC = process.env.NOTCHPAY_PUBLIC_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const AT_USERNAME = process.env.AT_USERNAME;
const AT_API_KEY = process.env.AT_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

// ========== AFRICA'S TALKING ==========
const africastalking = AfricasTalking({
  apiKey: AT_API_KEY,
  username: AT_USERNAME
});
const sms = africastalking.SMS;

// ========== WEB PUSH ==========
webpush.setVapidDetails(
  'mailto:lucky@easyrent.com',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// ========== MONGODB ==========
let db;
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('easyrent');
  console.log('MongoDB connected');
}
connectDB().catch(console.error);

// Temporary codes for SMS (still in memory is fine)
const resetCodes = {};

// ==========================================
// 1. NOTCHPAY PAYMENT
// ==========================================
app.post('/api/pay/initiate', async (req, res) => {
  try {
    const { amount, phone, reference, callback_url } = req.body;

    const payload = {
      amount: Number(amount),
      currency: 'XAF',
      phone: phone.startsWith('+') ? phone : `+237${phone.replace(/\D/g, '')}`,
      description: 'Easy Rent Premium',
      reference: reference || `ER-${Date.now()}`,
      callback: callback_url
    };

    const response = await axios.post('https://api.notchpay.co/payments', payload, {
      headers: {
        Authorization: NOTCH_PUBLIC,
        'Content-Type': 'application/json'
      }
    });

    const paymentUrl = response.data.authorization_url || response.data.data?.authorization_url;

    if (!paymentUrl) {
      return res.status(400).json({ success: false, message: 'No payment URL received' });
    }

    res.json({ success: true, paymentUrl, reference: payload.reference });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'Payment failed to start' });
  }
});

app.get('/api/pay/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const response = await axios.get(`https://api.notchpay.co/payments/${reference}`, {
      headers: { Authorization: NOTCH_PUBLIC }
    });
    const status = response.data.transaction?.status || response.data.data?.status;
    res.json({ status });
  } catch (err) {
    res.status(500).json({ status: 'error' });
  }
});

// ==========================================
// 2. PUSH NOTIFICATIONS (with MongoDB)
// ==========================================
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { phone, subscription } = req.body;
    if (!phone || !subscription) {
      return res.status(400).json({ error: 'Missing data' });
    }

    await db.collection('push_subscriptions').updateOne(
      { phone },
      { $set: { phone, subscription, updatedAt: new Date() } },
      { upsert: true }
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.post('/api/push/sync', (req, res) => {
  res.json({ ok: true });
});

// Test endpoint
app.post('/api/push/test', async (req, res) => {
  try {
    const { phone } = req.body;
    const doc = await db.collection('push_subscriptions').findOne({ phone });

    if (!doc) {
      return res.status(404).json({ success: false, message: 'No subscription found' });
    }

    await webpush.sendNotification(doc.subscription, JSON.stringify({
      title: 'Easy Rent Test',
      body: 'This is a real push notification! It works.'
    }));

    res.json({ success: true, message: 'Notification sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to send' });
  }
});

// Helper function
async function sendPush(phone, title, body) {
  try {
    const doc = await db.collection('push_subscriptions').findOne({ phone });
    if (!doc) return;
    await webpush.sendNotification(doc.subscription, JSON.stringify({ title, body }));
  } catch (err) {
    if (err.statusCode === 410) {
      await db.collection('push_subscriptions').deleteOne({ phone });
    }
  }
}

// ==========================================
// 3. SMS (AFRICA'S TALKING)
// ==========================================
app.post('/api/auth/send-reset-code', async (req, res) => {
  try {
    const { phone } = req.body;
    const to = phone.startsWith('+') ? phone : `+237${phone.replace(/\D/g, '')}`;

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    resetCodes[to] = { code, expires: Date.now() + 10 * 60 * 1000 };

    await sms.send({
      to: [to],
      message: `Your Easy Rent verification code is: ${code}. Valid for 10 minutes.`
    });

    res.json({ success: true, message: 'Code sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to send SMS' });
  }
});

app.post('/api/auth/verify-reset-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const to = phone.startsWith('+') ? phone : `+237${phone.replace(/\D/g, '')}`;
    const saved = resetCodes[to];

    if (!saved) {
      return res.status(400).json({ success: false, message: 'No code found. Request a new one.' });
    }
    if (Date.now() > saved.expires) {
      delete resetCodes[to];
      return res.status(400).json({ success: false, message: 'Code expired' });
    }
    if (saved.code !== code) {
      return res.status(400).json({ success: false, message: 'Wrong code' });
    }

    delete resetCodes[to];
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Easy Rent backend running on port ${PORT}`);
}); 