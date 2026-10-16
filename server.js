require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SELLER_PHONE_NUMBER = process.env.SELLER_PHONE_NUMBER || '';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || '';
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : process.env.FIREBASE_SERVICE_ACCOUNT;
  } catch (error) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT env var:', error.message);
  }
} else {
  try {
    serviceAccount = require('./firebase-key.json');
  } catch (error) {
    console.warn('firebase-key.json not found locally.');
  }
}

if (serviceAccount && getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
    projectId: FIREBASE_PROJECT_ID || serviceAccount.project_id
  });
  console.log('Firebase initialized successfully!');
} else if (!serviceAccount) {
  console.error('Firebase initialization skipped: No valid service account provided.');
}

const db = getApps().length ? getFirestore() : null;
const productsCollection = db ? db.collection('products') : null;
const FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || '';
const firebaseBucket = FIREBASE_STORAGE_BUCKET && getApps().length ? getStorage().bucket(FIREBASE_STORAGE_BUCKET) : null;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qwerty';
const localAdmins = new Map();
localAdmins.set('admin', {
  username: 'admin',
  password: ADMIN_PASSWORD,
  email: 'nsmskipruto@gmail.com'
});

const CLOUDINARY_ENABLED = Boolean(
  process.env.CLOUDINARY_URL ||
  (process.env.CLOUDINARY_CLOUD_NAME &&
   process.env.CLOUDINARY_API_KEY &&
   process.env.CLOUDINARY_API_SECRET)
);

if (CLOUDINARY_ENABLED) {
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config();
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
  }
  console.log('☁️ Cloudinary storage configured successfully!');
}

// ---- Config ----
// Change this to your own password before running the site.
const STORAGE_DIR = process.env.STORAGE_DIR || '';
const DATA_DIR = STORAGE_DIR ? path.join(STORAGE_DIR, 'data') : path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'items.json');
const UPLOADS_DIR = STORAGE_DIR ? path.join(STORAGE_DIR, 'uploads') : path.join(__dirname, 'public', 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (STORAGE_DIR && !fs.existsSync(DATA_FILE)) {
  const bundledDataFile = path.join(__dirname, 'data', 'items.json');
  if (fs.existsSync(bundledDataFile)) fs.copyFileSync(bundledDataFile, DATA_FILE);
}

// Active admin session tokens live in memory only — they reset when the
// server restarts, which is fine for a single-owner admin panel.
const activeSessions = new Set();

// ---- Middleware ----
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && activeSessions.has(token)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ---- Data helpers ----
function readItems() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return raw.trim() ? JSON.parse(raw).map(item => ({
    ...item,
    status: item.status === 'new' ? 'in-stock' : item.status
  })) : [];
}

async function readCatalogItems() {
  if (!db) return readItems();
  const snapshot = await productsCollection.get();
  return snapshot.docs.map(doc => {
    const item = { id: doc.id, ...doc.data() };
    if (item.createdAt?.toMillis) item.createdAt = item.createdAt.toMillis();
    if (item.status === 'new') item.status = 'in-stock';
    return item;
  });
}

async function writeItems(items) {
  if (!db) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
    return;
  }

  const existing = await productsCollection.get();
  const nextIds = new Set(items.map(item => item.id));
  const batch = db.batch();
  existing.docs.forEach(doc => {
    if (!nextIds.has(doc.id)) batch.delete(doc.ref);
  });
  items.forEach(item => {
    const { id, ...data } = item;
    batch.set(productsCollection.doc(id), data);
  });
  await batch.commit();
}

// ---- Image upload ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = crypto.randomBytes(8).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp|gif)/.test(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed'), ok);
  }
});
const uploadImages = upload.fields([
  { name: 'images', maxCount: 12 },
  { name: 'image', maxCount: 1 }
]);

function getUploadedFiles(req) {
  if (req.files?.images?.length) return req.files.images;
  return req.files?.image || [];
}

function getMediaUrls(item) {
  const urls = Array.isArray(item.images) ? [...item.images] : [];
  if (item.image) urls.push(item.image);
  return [...new Set(urls)];
}

function removeUnreferencedMedia(urls, items) {
  const referenced = new Set(items.flatMap(getMediaUrls));
  for (const url of urls) {
    if (!url || referenced.has(url) || !url.startsWith('/uploads/')) continue;
    const filename = path.basename(url);
    if (filename !== url.slice('/uploads/'.length)) continue;
    fs.unlink(path.join(UPLOADS_DIR, filename), () => {});
  }
}

async function uploadMedia(files) {
  if (CLOUDINARY_ENABLED) {
    const uploaded = [];
    try {
      for (const file of files) {
        const result = await cloudinary.uploader.upload(file.path, {
          folder: 'shoe_collection',
          resource_type: 'image'
        });
        uploaded.push({ url: result.secure_url, publicId: result.public_id });
      }
    } catch (error) {
      await Promise.all(uploaded.map(media => cloudinary.uploader.destroy(media.publicId, { resource_type: 'image' })));
      throw error;
    } finally {
      for (const file of files) fs.unlink(file.path, () => {});
    }

    return {
      images: uploaded.map(media => media.url),
      publicIds: uploaded.map(media => media.publicId)
    };
  }

  if (firebaseBucket) {
    const uploaded = [];
    try {
      for (const file of files) {
        const fileName = `products/${Date.now()}_${file.originalname}`;
        const [uploadedFile] = await firebaseBucket.upload(file.path, {
          destination: fileName,
          metadata: { contentType: file.mimetype }
        });
        await uploadedFile.makePublic();
        uploaded.push(`https://storage.googleapis.com/${firebaseBucket.name}/${fileName}`);
      }
    } finally {
      for (const file of files) fs.unlink(file.path, () => {});
    }
    return { images: uploaded, publicIds: [] };
  }

  return {
    images: files.map(file => `/uploads/${file.filename}`),
    publicIds: []
  };
}

async function removeCloudinaryMedia(publicIds) {
  if (!CLOUDINARY_ENABLED || !Array.isArray(publicIds)) return;
  await Promise.all(publicIds.filter(Boolean).map(publicId =>
    cloudinary.uploader.destroy(publicId, { resource_type: 'image' })
  ));
}

// Ensure default admin exists in Firestore on startup
async function ensureAdminExists() {
  if (!db) {
    return;
  }

  try {
    const adminsRef = db.collection('admins');
    const snapshot = await adminsRef.get();
    if (snapshot.empty) {
      await adminsRef.doc('main_admin').set({
        username: 'admin',
        password: ADMIN_PASSWORD,
        email: 'nsmskipruto@gmail.com'
      });
      console.log('✅ Admin account seeded in Firebase');
    }
  } catch (err) {
    console.error('Error seeding admin:', err.message);
  }
}

ensureAdminExists();

// Flexible Admin Login Route
app.post('/api/admin/login', async (req, res) => {
  const { identifier, username, password } = req.body;
  const rawLookup = identifier ?? username;

  if (!rawLookup || !password) {
    return res.status(400).json({ success: false, message: 'Username/email and password are required' });
  }

  const lookup = String(rawLookup).trim().toLowerCase();
  const inputPassword = String(password);

  try {
    // 1. Check local admin map / master admin credentials first
    const localAdmin = [...localAdmins.values()].find(admin =>
      (admin.username.toLowerCase() === lookup || admin.email.toLowerCase() === lookup) && admin.password === inputPassword
    );

    const isMasterAdmin = (lookup === 'admin' || lookup === 'nsmskipruto@gmail.com') && inputPassword === ADMIN_PASSWORD;

    if (!db || localAdmin || isMasterAdmin) {
      if (localAdmin || isMasterAdmin) {
        const token = crypto.randomBytes(24).toString('hex');
        activeSessions.add(token);
        return res.json({
          success: true,
          message: 'Login successful',
          token,
          admin: {
            username: localAdmin ? localAdmin.username : 'admin',
            email: localAdmin ? localAdmin.email : 'nsmskipruto@gmail.com'
          }
        });
      }

      if (!db) {
        return res.status(401).json({ success: false, message: 'Invalid username/email or password' });
      }
    }

    // 2. Query Firestore admins collection
    const adminsRef = db.collection('admins');
    const snapshot = await adminsRef.get();

    let authenticatedAdmin = null;

    if (!snapshot.empty) {
      snapshot.forEach(doc => {
        const data = doc.data();
        const dataUser = (data.username || '').trim().toLowerCase();
        const dataEmail = (data.email || '').trim().toLowerCase();
        const matchesIdentifier = (dataUser === lookup || dataEmail === lookup);
        const matchesPassword = (data.password === inputPassword);

        if (matchesIdentifier && matchesPassword) {
          authenticatedAdmin = data;
        }
      });
    }

    if (authenticatedAdmin) {
      const token = crypto.randomBytes(24).toString('hex');
      activeSessions.add(token);
      return res.json({
        success: true,
        message: 'Login successful',
        token,
        admin: {
          username: authenticatedAdmin.username,
          email: authenticatedAdmin.email
        }
      });
    }

    return res.status(401).json({ success: false, message: 'Invalid username/email or password' });

  } catch (error) {
    console.error('Login error:', error);
    // If database connection fails, allow fallback to master admin
    if ((lookup === 'admin' || lookup === 'nsmskipruto@gmail.com') && inputPassword === ADMIN_PASSWORD) {
      const token = crypto.randomBytes(24).toString('hex');
      activeSessions.add(token);
      return res.json({
        success: true,
        message: 'Login successful',
        token,
        admin: { username: 'admin', email: 'nsmskipruto@gmail.com' }
      });
    }
    res.status(500).json({ success: false, message: 'Database query error: ' + error.message });
  }
});

app.get('/api/session', requireAuth, (req, res) => {
  res.json({ authenticated: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  activeSessions.delete(req.headers['x-admin-token']);
  res.json({ ok: true });
});

// ---- Public routes ----
app.get('/api/items', async (req, res) => {
  try {
    const items = await readCatalogItems();
    res.json(items);
  } catch (error) {
    console.error('FIREBASE FETCH ERROR:', error.message);
    try {
      const items = readItems();
      res.json(items);
    } catch (fallbackError) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch items',
        error: error.message
      });
    }
  }
});

// ---- Safaricom Daraja / M-Pesa Configuration ----
const MPESA_ENVIRONMENT = (process.env.MPESA_ENVIRONMENT || 'sandbox').toLowerCase();
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const MPESA_TRANSACTION_TYPE = process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline';
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || '';
const mpesaTransactionsCollection = db ? db.collection('mpesa_transactions') : null;

function formatMpesaPhone(phone) {
  let cleaned = String(phone || '').replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.slice(1);
  } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  }
  return cleaned;
}

const ADMIN_WHATSAPP_PHONE = formatMpesaPhone(SELLER_PHONE_NUMBER) || '254728074301';

app.get('/api/config', (req, res) => {
  res.json({
    sellerPhone: ADMIN_WHATSAPP_PHONE,
    mpesaEnvironment: MPESA_ENVIRONMENT,
    mpesaShortcode: MPESA_SHORTCODE
  });
});

const MPESA_BASE_URL = (MPESA_ENVIRONMENT === 'production' || MPESA_ENVIRONMENT === 'live')
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const activeMpesaTransactions = new Map();
let cachedMpesaToken = null;
let mpesaTokenExpiresAt = 0;

async function getMpesaToken() {
  if (cachedMpesaToken && Date.now() < mpesaTokenExpiresAt) {
    return cachedMpesaToken;
  }
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Daraja OAuth failed (${res.status}): ${errorText}`);
  }
  const data = await res.json();
  cachedMpesaToken = data.access_token;
  mpesaTokenExpiresAt = Date.now() + (Number(data.expires_in) - 60) * 1000;
  return cachedMpesaToken;
}

async function storePendingTransaction(checkoutRequestId, data) {
  activeMpesaTransactions.set(checkoutRequestId, data);
  if (!mpesaTransactionsCollection) return;
  try {
    await mpesaTransactionsCollection.doc(checkoutRequestId).set(data, { merge: true });
  } catch (err) {
    console.error('Error saving pending M-Pesa transaction:', err.message);
  }
}

async function loadPendingTransaction(checkoutRequestId) {
  const cached = activeMpesaTransactions.get(checkoutRequestId);
  if (cached) return cached;
  if (!mpesaTransactionsCollection) return {};
  try {
    const snap = await mpesaTransactionsCollection.doc(checkoutRequestId).get();
    return snap.exists ? snap.data() : {};
  } catch (err) {
    console.error('Error loading M-Pesa transaction:', err.message);
    return {};
  }
}

// ---- M-Pesa Endpoints ----
app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phoneNumber, amount, itemName, customerName, itemId, itemLines: rawItemLines } = req.body;
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_PASSKEY || !MPESA_CALLBACK_URL) {
    return res.status(503).json({
      success: false,
      message: 'M-Pesa checkout is not configured. Set the Daraja credentials and public callback URL.'
    });
  }
  if (!phoneNumber || !amount) {
    return res.status(400).json({ success: false, message: 'Phone number and amount are required.' });
  }

  const phone = formatMpesaPhone(phoneNumber);
  if (!/^254[17][0-9]{8}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid Kenyan phone number. Use 07XXXXXXXX or 254XXXXXXXXX.' });
  }

  const numericAmount = Math.max(1, Math.round(Number(String(amount).replace(/[^0-9.]/g, '')) || 1));
  const itemLines = Array.isArray(rawItemLines) ? rawItemLines
    .map(line => ({
      itemId: line?.itemId ? String(line.itemId).slice(0, 128) : null,
      itemName: String(line?.itemName || '').trim().slice(0, 120),
      quantity: Math.min(999, Math.max(1, Math.floor(Number(line?.quantity) || 1)))
    }))
    .filter(line => line.itemName)
    .slice(0, 50) : [];

  try {
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

    let shortcodeToUse = MPESA_SHORTCODE;
    let password = Buffer.from(`${shortcodeToUse}${MPESA_PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: shortcodeToUse,
      Password: password,
      Timestamp: timestamp,
      TransactionType: MPESA_TRANSACTION_TYPE,
      Amount: numericAmount,
      PartyA: phone,
      PartyB: shortcodeToUse,
      PhoneNumber: phone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: 'TheCollection',
      TransactionDesc: `Pay for ${itemName || 'Order'}`
    };

    let stkRes = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    let stkData = await stkRes.json();

    // If sandbox custom shortcode fails with "Merchant does not exist", fallback to standard sandbox paybill 174379
    if (stkRes.status !== 200 && MPESA_ENVIRONMENT === 'sandbox' && shortcodeToUse !== '174379') {
      shortcodeToUse = '174379';
      password = Buffer.from(`${shortcodeToUse}${MPESA_PASSKEY}${timestamp}`).toString('base64');
      payload.BusinessShortCode = shortcodeToUse;
      payload.Password = password;
      payload.PartyB = shortcodeToUse;
      payload.TransactionType = 'CustomerPayBillOnline';

      stkRes = await fetch(`${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      stkData = await stkRes.json();
    }

    if (stkData.ResponseCode === '0' || stkData.CheckoutRequestID) {
      await storePendingTransaction(stkData.CheckoutRequestID, {
        checkoutRequestId: stkData.CheckoutRequestID,
        merchantRequestId: stkData.MerchantRequestID,
        phoneNumber: phone,
        amount: numericAmount,
        itemName: itemName || 'Collection Piece',
        customerName: customerName || 'Valued Customer',
        itemId: itemId || null,
        itemLines,
        quantity: itemLines.reduce((total, line) => total + line.quantity, 0) || null,
        businessShortCode: shortcodeToUse,
        status: 'PENDING',
        createdAt: Date.now()
      });

      return res.json({
        success: true,
        checkoutRequestId: stkData.CheckoutRequestID,
        customerMessage: stkData.CustomerMessage || 'STK Push sent. Please enter your M-Pesa PIN on your phone.'
      });
    }

    return res.status(400).json({
      success: false,
      message: stkData.errorMessage || stkData.ResponseDescription || 'Failed to initiate M-Pesa prompt.'
    });

  } catch (error) {
    console.error('M-Pesa STK push error:', error);
    res.status(500).json({ success: false, message: error.message || 'M-Pesa server error.' });
  }
});

app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callbackData = req.body?.Body?.stkCallback;
    if (!callbackData) {
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const { CheckoutRequestID, ResultCode, ResultDesc } = callbackData;
    console.log('M-Pesa Callback:', CheckoutRequestID, ResultCode, ResultDesc);

    const transaction = await loadPendingTransaction(CheckoutRequestID);

    if (ResultCode === 0) {
      await storePendingTransaction(CheckoutRequestID, {
        ...transaction,
        status: 'COMPLETED',
        completedAt: Date.now()
      });
    } else {
      await storePendingTransaction(CheckoutRequestID, {
        ...transaction,
        status: 'FAILED',
        error: ResultDesc
      });
    }

    res.json({ ResultCode: 0, ResultDesc: 'Callback processed successfully' });
  } catch (err) {
    console.error('Error in M-Pesa callback:', err);
    res.json({ ResultCode: 0, ResultDesc: 'Error recorded' });
  }
});

app.get('/api/mpesa/status/:checkoutRequestId', async (req, res) => {
  const { checkoutRequestId } = req.params;
  const transaction = await loadPendingTransaction(checkoutRequestId);

  if (!transaction || !transaction.checkoutRequestId) {
    return res.status(404).json({ success: false, message: 'Transaction not found.' });
  }

  if (transaction.status === 'COMPLETED') {
    return res.json({ success: true, status: 'COMPLETED' });
  }

  if (transaction.status === 'FAILED') {
    return res.json({ success: false, status: 'FAILED', message: transaction.error || 'Payment cancelled or failed.' });
  }

  try {
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const shortcode = transaction.businessShortCode || MPESA_SHORTCODE;
    const password = Buffer.from(`${shortcode}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const queryRes = await fetch(`${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId
      })
    });
    const queryData = await queryRes.json();
    if (String(queryData.ResultCode) === '0') {
      await storePendingTransaction(checkoutRequestId, {
        ...transaction,
        status: 'COMPLETED',
        completedAt: Date.now()
      });
      return res.json({ success: true, status: 'COMPLETED' });
    }
    if (queryData.ResultCode && String(queryData.ResultCode) !== '1032' && String(queryData.ResultCode) !== '4999') {
      const failedCodes = ['1032', '1037', '1', '2001', '1001'];
      if (failedCodes.includes(String(queryData.ResultCode))) {
        await storePendingTransaction(checkoutRequestId, {
          ...transaction,
          status: 'FAILED',
          error: queryData.ResultDesc || 'Payment cancelled or failed.'
        });
        return res.json({ success: false, status: 'FAILED', message: queryData.ResultDesc || 'Payment cancelled or failed.' });
      }
    }
  } catch (err) {
    console.error('M-Pesa status query error:', err.message);
  }

  return res.json({ success: true, status: 'PENDING' });
});

app.get('/api/admin/transactions', requireAuth, async (req, res) => {
  if (!mpesaTransactionsCollection) {
    return res.status(503).json({ success: false, message: 'Transaction history is unavailable because Firestore is not configured.' });
  }

  try {
    const snapshot = await mpesaTransactionsCollection.get();
    const transactionTime = value => {
      if (typeof value === 'number') return value;
      if (typeof value?.toMillis === 'function') return value.toMillis();
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const transactions = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(transaction => transaction.status === 'COMPLETED')
      .sort((first, second) =>
        transactionTime(second.completedAt || second.createdAt) - transactionTime(first.completedAt || first.createdAt)
      );

    res.json({ success: true, transactions });
  } catch (error) {
    console.error('Error loading M-Pesa transactions:', error.message);
    res.status(503).json({ success: false, message: 'Transaction history is temporarily unavailable.' });
  }
});

// ---- Admin routes (all require a valid session token) ----
app.post('/api/admin/create', requireAuth, async (req, res) => {
  const { email, password, username } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: 'Username, email, and password are required.' });
  }

  const cleanUsername = String(username).trim();
  const cleanEmail = String(email).trim().toLowerCase();
  const rawPassword = String(password);

  if (rawPassword.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  try {
    let uid = null;

    // 1. Try Firebase Auth if available
    try {
      const userRecord = await getAuth().createUser({
        email: cleanEmail,
        password: rawPassword,
        displayName: cleanUsername
      });
      uid = userRecord.uid;
    } catch (authErr) {
      console.warn('Firebase Auth user creation note:', authErr.message);
    }

    // 2. Save directly to Firestore 'admins' collection
    if (db) {
      const docRef = uid ? db.collection('admins').doc(uid) : db.collection('admins').doc();
      await docRef.set({
        username: cleanUsername,
        email: cleanEmail,
        password: rawPassword,
        role: 'admin',
        createdAt: new Date()
      });

      if (uid) {
        await db.collection('admin_profiles').doc(uid).set({
          username: cleanUsername,
          email: cleanEmail,
          role: 'admin',
          createdAt: new Date()
        }).catch(() => {});
      }
    }

    // 3. Register in local memory fallback
    localAdmins.set(cleanUsername.toLowerCase(), {
      username: cleanUsername,
      password: rawPassword,
      email: cleanEmail
    });

    res.json({
      success: true,
      message: db ? 'Admin directly added to Firebase!' : 'Admin added locally!',
      admin: { username: cleanUsername, email: cleanEmail }
    });
  } catch (error) {
    console.error('Error creating admin:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to create admin' });
  }
});

app.get('/api/admin/list', requireAuth, async (req, res) => {
  try {
    const list = [];
    if (db) {
      const snapshot = await db.collection('admins').get();
      snapshot.forEach(doc => {
        const d = doc.data();
        list.push({
          id: doc.id,
          username: d.username,
          email: d.email,
          createdAt: d.createdAt ? (d.createdAt.toDate ? d.createdAt.toDate() : d.createdAt) : null
        });
      });
    }

    if (list.length === 0) {
      for (const [key, admin] of localAdmins.entries()) {
        list.push({
          id: key,
          username: admin.username,
          email: admin.email,
          createdAt: new Date()
        });
      }
    }

    res.json({ success: true, admins: list });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/items', requireAuth, uploadImages, async (req, res) => {
  const { name, category, caption, price, status } = req.body;
  if (!name || !category) {
    return res.status(400).json({ error: 'Name and category are required' });
  }
  const items = await readCatalogItems();
  const uploadedFiles = getUploadedFiles(req);
  let media;
  try {
    media = await uploadMedia(uploadedFiles);
  } catch (error) {
    console.error('Image upload failed:', error);
    return res.status(500).json({ error: 'Image upload failed' });
  }
  const item = {
    id: crypto.randomBytes(6).toString('hex'),
    name,
    category,           // "shoes" | "clothes"
    caption: caption || '',
    price: price || '',
    status: status || 'in-stock',   // "in-stock" | "sold" | "regular"
    images: media.images,
    image: media.images[0] || null,
    cloudinaryPublicIds: media.publicIds,
    createdAt: Date.now()
  };
  items.push(item);
  await writeItems(items);
  res.status(201).json(item);
});

app.patch('/api/items/:id', requireAuth, uploadImages, async (req, res) => {
  const items = await readCatalogItems();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });

  const { name, category, caption, price, status } = req.body;
  const existing = items[idx];
  const uploadedFiles = getUploadedFiles(req);
  const oldMedia = getMediaUrls(existing);
  let media = null;
  if (uploadedFiles.length) {
    try {
      media = await uploadMedia(uploadedFiles);
    } catch (error) {
      console.error('Image upload failed:', error);
      return res.status(500).json({ error: 'Image upload failed' });
    }
  }
  const images = media ? media.images : existing.images;
  items[idx] = {
    ...existing,
    name: name ?? existing.name,
    category: category ?? existing.category,
    caption: caption ?? existing.caption,
    price: price ?? existing.price,
    status: status ?? existing.status,
    ...(media ? { images, image: media.images[0] || null, cloudinaryPublicIds: media.publicIds } : {})
  };
  await writeItems(items);
  if (uploadedFiles.length) removeUnreferencedMedia(oldMedia, items);
  if (media) await removeCloudinaryMedia(existing.cloudinaryPublicIds);
  res.json(items[idx]);
});

app.delete('/api/items/:id', requireAuth, async (req, res) => {
  const items = await readCatalogItems();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  const [removed] = items.splice(idx, 1);
  await writeItems(items);
  removeUnreferencedMedia(getMediaUrls(removed), items);
  await removeCloudinaryMedia(removed.cloudinaryPublicIds);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Site running at http://localhost:${PORT}`);
  console.log(`Admin panel at   http://localhost:${PORT}/admin.html`);
});
