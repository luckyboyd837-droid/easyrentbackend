require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const webpush = require('web-push');
const AfricasTalking = require('africastalking');

const app = express();
app.use(cors());
app.use(express.json());

// ========== LOAD KEYS ==========
const NOTCH_PUBLIC = process.env.NOTCHPAY_PUBLIC_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const AT_USERNAME = process.env.AT_USERNAME;
const AT_API_KEY = process.env.AT_API_KEY;

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

// Temporary storage (later you should use a real database)
const pushSubscriptions = {};   // phone → subscription
const resetCodes = {};          // phone → { code, expires }

// ==========================================
// 1. REAL NOTCHPAY PAYMENT
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
// 2. REAL PUSH NOTIFICATIONS
// ==========================================
app.post('/api/push/subscribe', (req, res) => {
  const { phone, subscription } = req.body;
  if (!phone || !subscription) {
    return res.status(400).json({ error: 'Missing data' });
  }
  pushSubscriptions[phone] = subscription;
  res.status(201).json({ ok: true });
});

app.post('/api/push/sync', (req, res) => {
  res.json({ ok: true });
});

// Helper to send push (you can use this later)
async function sendPush(phone, title, body) {
  const sub = pushSubscriptions[phone];
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
  } catch (err) {
    if (err.statusCode === 410) delete pushSubscriptions[phone];
  }
}

// ==========================================
// 3. REAL SMS (AFRICA'S TALKING)
// ==========================================
app.post('/api/auth/send-reset-code', async (req, res) => {
  try {
    const { phone } = req.body;
    const to = phone.startsWith('+') ? phone : `+237${phone.replace(/\D/g, '')}`;

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Save code for 10 minutes
    resetCodes[to] = {
      code,
      expires: Date.now() + 10 * 60 * 1000
    };

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
