require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createMarketplace = require('./marketplace');

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

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const passwordResetRequests = new Map();
const localAdmins = new Map();
localAdmins.set('admin', {
  username: 'admin',
  email: 'nsmskipruto@gmail.com'
});

const CLOUDINARY_ENABLED = Boolean(
  process.env.CLOUDINARY_URL ||
  (process.env.CLOUDINARY_CLOUD_NAME &&
   process.env.CLOUDINARY_API_KEY &&
   process.env.CLOUDINARY_API_SECRET)
);

function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

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
function normalizeCatalogItem(item) {
  const suppliedQuantity = item.quantity !== undefined && item.quantity !== null && item.quantity !== '';
  const parsedQuantity = Number(item.quantity);
  const quantity = suppliedQuantity && Number.isSafeInteger(parsedQuantity) && parsedQuantity >= 0
    ? parsedQuantity
    : item.status === 'sold' ? 0 : 1;
  const legacyStatus = item.status === 'new' ? 'in-stock' : item.status;
  return {
    ...item,
    quantity,
    status: legacyStatus === 'regular' ? 'regular' : quantity > 0 ? 'in-stock' : 'sold'
  };
}

function parseStockQuantity(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) && quantity >= 0 ? quantity : null;
}

function parseCatalogPrice(value) {
  const match = String(value ?? '').replace(/[\s,]/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const price = Number(match[0]);
  return Number.isFinite(price) && price > 0 ? Math.round(price) : null;
}

function readItems() {
  if (!fs.existsSync(DATA_FILE)) return [];
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return raw.trim() ? JSON.parse(raw).map(normalizeCatalogItem) : [];
}

async function readCatalogItems() {
  if (!db) return readItems();
  const snapshot = await productsCollection.get();
  return snapshot.docs.map(doc => {
    const item = normalizeCatalogItem({ id: doc.id, ...doc.data() });
    if (item.createdAt?.toMillis) item.createdAt = item.createdAt.toMillis();
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
  { name: 'images', maxCount: 8 },
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

const marketplace = createMarketplace({
  db,
  firebaseAuth: getApps().length ? getAuth() : null,
  dataDir: DATA_DIR,
  adminSessions: activeSessions,
  readCatalogItems,
  writeCatalogItems: writeItems,
  uploadImages,
  uploadMedia,
  getMediaUrls,
  removeUnreferencedMedia,
  removeCloudinaryMedia
});
app.use('/api/marketplace', marketplace.router);
app.use('/api/marketplace', (error, req, res, next) => {
  console.error('Marketplace request failed:', error);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ success: false, message: 'Marketplace request could not be completed.' });
});

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
        email: 'nsmskipruto@gmail.com'
      });
      console.log('✅ Admin account seeded in Firebase');
    }
  } catch (err) {
    console.error('Error seeding admin:', err.message);
  }
}

ensureAdminExists();

app.post('/api/admin/session', async (req, res) => {
  if (!db || !getApps().length) {
    return res.status(503).json({ success: false, message: 'Admin sign-in is temporarily unavailable.' });
  }
  try {
    const decoded = await getAuth().verifyIdToken(req.body?.idToken);
    const email = String(decoded.email || '').trim().toLowerCase();
    if (!decoded.email_verified || !email) {
      return res.status(403).json({ success: false, message: 'Verify your email address before signing in.' });
    }
    const snapshot = await db.collection('admins').where('email', '==', email).limit(1).get();
    if (snapshot.empty) {
      return res.status(403).json({ success: false, message: 'This Firebase account does not have admin access.' });
    }
    const adminDoc = snapshot.docs[0];
    const adminData = adminDoc.data();
    if (adminData.firebaseUid && adminData.firebaseUid !== decoded.uid) {
      return res.status(403).json({ success: false, message: 'This Firebase account does not have admin access.' });
    }
    if (!adminData.firebaseUid) {
      await adminDoc.ref.set({
        firebaseUid: decoded.uid,
        password: FieldValue.delete()
      }, { merge: true });
    }
    const token = crypto.randomBytes(24).toString('hex');
    activeSessions.add(token);
    return res.json({ success: true, token, admin: { username: adminData.username || 'admin', email } });
  } catch (error) {
    if (error.code === 'auth/argument-error' || error.code === 'auth/invalid-id-token' ||
        error.code === 'auth/id-token-expired' || error.code === 'auth/invalid-argument') {
      return res.status(401).json({ success: false, message: 'Sign in with a valid Firebase account.' });
    }
    console.error('Admin Firebase sign-in failed:', error.message);
    res.status(503).json({ success: false, message: 'Admin sign-in is temporarily unavailable.' });
  }
});

async function sendAccountPasswordReset(req, res, accountType) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
  }
  if (!db || !getApps().length || !RESEND_API_KEY || !RESEND_FROM_EMAIL || !PUBLIC_BASE_URL) {
    return res.status(503).json({ success: false, message: 'Password reset is temporarily unavailable.' });
  }

  const now = Date.now();
  const requestIp = req.ip || req.socket.remoteAddress || 'unknown';
  const recentRequests = (passwordResetRequests.get(requestIp) || [])
    .filter(timestamp => now - timestamp < 15 * 60 * 1000);
  if (recentRequests.length >= 5) {
    return res.status(429).json({ success: false, message: 'Too many requests. Try again later.' });
  }
  passwordResetRequests.set(requestIp, [...recentRequests, now]);

  const genericResponse = {
    success: true,
    message: 'If an account matches that email, a password reset link will be sent.'
  };
  try {
    const collection = accountType === 'admin' ? 'admins' : 'marketplace_users';
    const snapshot = await db.collection(collection).where('email', '==', email).limit(1).get();
    if (snapshot.empty) return res.status(202).json(genericResponse);

    const accountDoc = snapshot.docs[0];
    const account = accountDoc.data();
    let firebaseUser;
    try {
      firebaseUser = await getAuth().getUserByEmail(email);
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      firebaseUser = await getAuth().createUser({
        email,
        emailVerified: true,
        password: crypto.randomBytes(48).toString('base64url'),
        displayName: accountType === 'admin'
          ? account.username || 'Admin'
          : `${account.firstName || ''} ${account.lastName || ''}`.trim() || 'Customer'
      });
    }
    if (account.firebaseUid && account.firebaseUid !== firebaseUser.uid) {
      return res.status(202).json(genericResponse);
    }
    await accountDoc.ref.set({
      firebaseUid: firebaseUser.uid,
      ...(accountType === 'admin' ? { password: FieldValue.delete() } : {})
    }, { merge: true });

    const continueUrl = `${PUBLIC_BASE_URL}/${accountType === 'admin' ? 'admin-login.html' : 'account.html'}`;
    const resetUrl = await getAuth().generatePasswordResetLink(email, { url: continueUrl });
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [email],
        subject: accountType === 'admin' ? 'Reset your admin password' : 'Reset your password',
        text: `Use this link to reset your password.\n\n${resetUrl}`,
        html: `<p>Use the link below to reset your password.</p><p><a href="${resetUrl}">Reset password</a></p>`
      })
    });
    if (!emailResponse.ok) {
      console.error('Password reset email provider returned:', emailResponse.status);
      return res.status(202).json(genericResponse);
    }
    return res.status(202).json(genericResponse);
  } catch (error) {
    console.error(`${accountType} password reset request failed:`, error.message);
    return res.status(202).json(genericResponse);
  }
}

app.post('/api/auth/password-reset/request', async (req, res) => {
  const accountType = req.body?.accountType === 'admin' ? 'admin' : 'customer';
  return sendAccountPasswordReset(req, res, accountType);
});

app.post('/api/admin/password-reset/request', (req, res) => sendAccountPasswordReset(req, res, 'admin'));

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
const inventoryReservations = new Map();
let inventoryLock = Promise.resolve();
let cachedMpesaToken = null;
let mpesaTokenExpiresAt = 0;

function withInventoryLock(callback) {
  const result = inventoryLock.then(callback, callback);
  inventoryLock = result.then(() => undefined, () => undefined);
  return result;
}

function reservedQuantity(itemId) {
  let total = 0;
  for (const lines of inventoryReservations.values()) {
    for (const line of lines) {
      if (line.itemId === itemId) total += line.quantity;
    }
  }
  return total;
}

async function reserveInventory(itemLines) {
  const reservationsToRefresh = await withInventoryLock(async () => {
    const items = await readCatalogItems();
    const affectedItemIds = new Set();
    for (const line of itemLines) {
      const item = items.find(entry => String(entry.id) === line.itemId);
      if (item && line.quantity <= item.quantity && line.quantity > item.quantity - reservedQuantity(line.itemId)) {
        affectedItemIds.add(line.itemId);
      }
    }
    if (!affectedItemIds.size) return [];
    return Array.from(inventoryReservations.entries())
      .filter(([, lines]) => lines.some(line => affectedItemIds.has(line.itemId)))
      .map(([checkoutRequestId]) => checkoutRequestId);
  });

  for (const checkoutRequestId of reservationsToRefresh) {
    const transaction = await loadPendingTransaction(checkoutRequestId);
    if (!transaction.checkoutRequestId || transaction.status !== 'PENDING') continue;
    try {
      const queryData = await queryMpesaTransaction(checkoutRequestId, transaction);
      if (String(queryData.ResultCode) === '0') {
        await completeMpesaTransaction(checkoutRequestId, transaction, queryData.ResultCode);
      } else if (['1032', '1037', '1', '2001', '1001'].includes(String(queryData.ResultCode))) {
        await failMpesaTransaction(checkoutRequestId, {
          ...transaction,
          error: queryData.ResultDesc || 'Payment cancelled or failed.'
        });
      }
    } catch (error) {
      console.error('M-Pesa reservation check failed:', error.message);
    }
  }

  return withInventoryLock(async () => {
    const items = await readCatalogItems();
    for (const line of itemLines) {
      const item = items.find(entry => String(entry.id) === line.itemId);
      if (!item || item.status !== 'in-stock' || item.quantity < 1) {
        throw new Error(`${line.itemName} is no longer in stock.`);
      }
      if (line.quantity > item.quantity) {
        throw new Error(`Only ${item.quantity} ${line.itemName} available in the store.`);
      }
      const heldQuantity = reservedQuantity(line.itemId);
      const availableQuantity = Math.max(0, item.quantity - heldQuantity);
      if (line.quantity > availableQuantity) {
        throw new Error(`Only ${availableQuantity} ${line.itemName} currently available (${item.quantity} in the store, ${heldQuantity} reserved for pending payments).`);
      }
      line.itemName = item.name;
      line.unitAmount = parseCatalogPrice(item.price);
      if (!line.unitAmount) throw new Error(`${item.name} does not have a valid price.`);
    }
    const reservationId = crypto.randomUUID();
    inventoryReservations.set(reservationId, itemLines);
    return reservationId;
  });
}

function attachInventoryReservation(reservationId, checkoutRequestId) {
  const lines = inventoryReservations.get(reservationId);
  if (!lines) return;
  inventoryReservations.delete(reservationId);
  inventoryReservations.set(checkoutRequestId, lines);
}

function releaseInventoryReservation(checkoutRequestId) {
  inventoryReservations.delete(checkoutRequestId);
}

async function completeMpesaTransaction(checkoutRequestId, transaction, resultCode) {
  if (String(resultCode) !== '0') return transaction;

  return withInventoryLock(async () => {
    const latest = await loadPendingTransaction(checkoutRequestId);
    if (latest.inventoryApplied) {
      await marketplace.createPaidOrder(latest);
      releaseInventoryReservation(checkoutRequestId);
      return latest;
    }

    const lines = latest.itemLines || transaction.itemLines || [];
    if (lines.length) {
      const items = await readCatalogItems();
      let changed = false;
      for (const line of lines) {
        const item = items.find(entry => String(entry.id) === String(line.itemId));
        if (!item) continue;
        item.quantity = Math.max(0, item.quantity - line.quantity);
        if (item.quantity === 0) item.status = 'sold';
        else if (item.status !== 'regular') item.status = 'in-stock';
        changed = true;
      }
      if (changed) await writeItems(items);
    }

    const completed = {
      ...latest,
      ...transaction,
      status: 'COMPLETED',
      inventoryApplied: true,
      completedAt: latest.completedAt || Date.now()
    };
    await marketplace.createPaidOrder(completed);
    await storePendingTransaction(checkoutRequestId, completed);
    releaseInventoryReservation(checkoutRequestId);
    return completed;
  });
}

async function failMpesaTransaction(checkoutRequestId, transaction) {
  return withInventoryLock(async () => {
    const latest = await loadPendingTransaction(checkoutRequestId);
    if (latest.inventoryApplied || latest.status === 'COMPLETED') return latest;
    releaseInventoryReservation(checkoutRequestId);
    const failed = { ...latest, ...transaction, status: 'FAILED' };
    await storePendingTransaction(checkoutRequestId, failed);
    return failed;
  });
}

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

async function queryMpesaTransaction(checkoutRequestId, transaction) {
  const token = await getMpesaToken();
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const shortcode = transaction.businessShortCode || MPESA_SHORTCODE;
  const password = Buffer.from(`${shortcode}${MPESA_PASSKEY}${timestamp}`).toString('base64');
  const response = await fetch(`${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`, {
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
  return response.json();
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
  const { phoneNumber, itemName, customerName, itemId, itemLines: rawItemLines } = req.body;
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_PASSKEY || !MPESA_CALLBACK_URL) {
    return res.status(503).json({
      success: false,
      message: 'M-Pesa checkout is not configured. Set the Daraja credentials and public callback URL.'
    });
  }
  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: 'Phone number is required.' });
  }

  const phone = formatMpesaPhone(phoneNumber);
  if (!/^254[17][0-9]{8}$/.test(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid Kenyan phone number. Use 07XXXXXXXX or 254XXXXXXXXX.' });
  }

  if (!Array.isArray(rawItemLines) || rawItemLines.length === 0 || rawItemLines.length > 50) {
    return res.status(400).json({ success: false, message: 'A valid list of items is required for checkout.' });
  }
  const itemLines = [];
  for (const line of rawItemLines) {
    const itemId = line?.itemId ? String(line.itemId).slice(0, 128) : '';
    const quantity = Number(line?.quantity);
    if (!itemId || !Number.isSafeInteger(quantity) || quantity < 1) {
      return res.status(400).json({ success: false, message: 'Each checkout item must have a valid ID and quantity.' });
    }
    const existingLine = itemLines.find(entry => entry.itemId === itemId);
    if (existingLine) existingLine.quantity += quantity;
    else itemLines.push({ itemId, itemName: String(line?.itemName || '').trim().slice(0, 120), quantity });
  }

  let reservationId;
  try {
    let marketplaceUser = null;
    let deliveryAddress = null;
    const accountToken = req.headers['x-marketplace-token'] || req.headers['x-auth-token'];
    if (accountToken) {
      marketplaceUser = await marketplace.resolveUserToken(accountToken);
      if (!marketplaceUser) {
        return res.status(401).json({ success: false, message: 'Your account session has expired. Sign in again to place a tracked order.' });
      }
      if (req.body.addressId) {
        deliveryAddress = await marketplace.findAddress(marketplaceUser.id, String(req.body.addressId));
        if (!deliveryAddress) {
          return res.status(400).json({ success: false, message: 'Choose a valid saved delivery address.' });
        }
      }
    }
    if (!deliveryAddress && req.body.deliveryAddress && typeof req.body.deliveryAddress === 'object') {
      const suppliedAddress = req.body.deliveryAddress;
      deliveryAddress = {
        recipient: String(suppliedAddress.recipient || customerName || '').trim().slice(0, 120),
        phone: String(suppliedAddress.phone || phoneNumber).trim().slice(0, 30),
        country: String(suppliedAddress.country || 'Kenya').trim().slice(0, 80),
        state: String(suppliedAddress.state || '').trim().slice(0, 100),
        city: String(suppliedAddress.city || '').trim().slice(0, 100),
        street: String(suppliedAddress.street || '').trim().slice(0, 160),
        addressLine: String(suppliedAddress.addressLine || '').trim().slice(0, 240),
        postalCode: String(suppliedAddress.postalCode || '').trim().slice(0, 20)
      };
      if (!deliveryAddress.state || !deliveryAddress.city || !deliveryAddress.street) {
        return res.status(400).json({ success: false, message: 'Enter a delivery area, city, and street.' });
      }
    }
    reservationId = await reserveInventory(itemLines);
    const numericAmount = itemLines.reduce((total, line) => total + line.unitAmount * line.quantity, 0);
    if (!Number.isSafeInteger(numericAmount) || numericAmount < 1) {
      throw new Error('The checkout total is invalid. Please check the item prices.');
    }
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
      AccountReference: 'Collection',
      TransactionDesc: 'Collection'
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
      attachInventoryReservation(reservationId, stkData.CheckoutRequestID);
      reservationId = stkData.CheckoutRequestID;
      await storePendingTransaction(stkData.CheckoutRequestID, {
        checkoutRequestId: stkData.CheckoutRequestID,
        merchantRequestId: stkData.MerchantRequestID,
        phoneNumber: phone,
        amount: numericAmount,
        itemName: itemName || 'Collection Piece',
        customerName: customerName || 'Valued Customer',
        marketplaceUserId: marketplaceUser?.id || null,
        deliveryAddress,
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

    releaseInventoryReservation(reservationId);
    return res.status(400).json({
      success: false,
      message: stkData.errorMessage || stkData.ResponseDescription || 'Failed to initiate M-Pesa prompt.'
    });

  } catch (error) {
    if (reservationId) releaseInventoryReservation(reservationId);
    console.error('M-Pesa STK push error:', error);
    const statusCode = /no longer in stock|available\./i.test(error.message) ? 409 : 500;
    res.status(statusCode).json({ success: false, message: error.message || 'M-Pesa server error.' });
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
    if (!transaction.checkoutRequestId) {
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted; transaction is not stored yet' });
    }

    if (String(ResultCode) === '0') {
      await completeMpesaTransaction(CheckoutRequestID, transaction, ResultCode);
    } else {
      await failMpesaTransaction(CheckoutRequestID, { ...transaction, error: ResultDesc });
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
    const queryData = await queryMpesaTransaction(checkoutRequestId, transaction);
    if (String(queryData.ResultCode) === '0') {
      await completeMpesaTransaction(checkoutRequestId, transaction, queryData.ResultCode);
      return res.json({ success: true, status: 'COMPLETED' });
    }
    const failedCodes = ['1032', '1037', '1', '2001', '1001'];
    if (failedCodes.includes(String(queryData.ResultCode))) {
      await failMpesaTransaction(checkoutRequestId, {
        ...transaction,
        error: queryData.ResultDesc || 'Payment cancelled or failed.'
      });
      return res.json({ success: false, status: 'FAILED', message: queryData.ResultDesc || 'Payment cancelled or failed.' });
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
  if (!db || !getApps().length) {
    return res.status(503).json({ success: false, message: 'Admin account creation is temporarily unavailable.' });
  }

  const cleanUsername = String(username).trim();
  const cleanEmail = String(email).trim().toLowerCase();
  const rawPassword = String(password);

  if (rawPassword.length < 10 || rawPassword.length > 128) {
    return res.status(400).json({ success: false, message: 'Password must be between 10 and 128 characters.' });
  }

  let createdUid = null;
  try {
    const userRecord = await getAuth().createUser({
      email: cleanEmail,
      password: rawPassword,
      displayName: cleanUsername
    });
    createdUid = userRecord.uid;
    await db.collection('admins').doc(createdUid).set({
      firebaseUid: createdUid,
      username: cleanUsername,
      email: cleanEmail,
      role: 'admin',
      createdAt: new Date()
    });

    res.json({
      success: true,
      message: 'Admin account created in Firebase. The new admin must verify their email before signing in.',
      admin: { username: cleanUsername, email: cleanEmail }
    });
  } catch (error) {
    if (createdUid) {
      try {
        await getAuth().deleteUser(createdUid);
      } catch (cleanupError) {
        console.error('Could not remove incomplete Firebase admin account:', cleanupError.message);
      }
    }
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ success: false, message: 'An account already uses that email address.' });
    }
    console.error('Error creating admin:', error);
    res.status(503).json({ success: false, message: 'Admin account creation is temporarily unavailable.' });
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
  const quantity = parseStockQuantity(req.body.quantity ?? (status === 'sold' ? 0 : 1));
  if (quantity === null) return res.status(400).json({ error: 'Quantity must be a non-negative whole number' });
  const normalizedStatus = status === 'regular' ? 'regular' : quantity > 0 ? 'in-stock' : 'sold';
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
    quantity,
    status: normalizedStatus,
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
  const quantity = req.body.quantity === undefined
    ? existing.quantity
    : parseStockQuantity(req.body.quantity);
  if (quantity === null) return res.status(400).json({ error: 'Quantity must be a non-negative whole number' });
  if (quantity < reservedQuantity(String(existing.id))) {
    return res.status(409).json({ error: 'Quantity cannot be lower than the amount reserved for pending checkouts' });
  }
  const requestedStatus = status ?? existing.status;
  const normalizedStatus = requestedStatus === 'regular' ? 'regular' : quantity > 0 ? 'in-stock' : 'sold';
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
    quantity,
    status: normalizedStatus,
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
