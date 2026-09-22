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
    credential: cert(serviceAccount)
  });
  console.log('Firebase initialized successfully!');
} else if (!serviceAccount) {
  console.error('Firebase initialization skipped: No valid service account provided.');
}

const db = getFirestore();
const productsCollection = db.collection('products');
const FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || '';
const firebaseBucket = FIREBASE_STORAGE_BUCKET ? getStorage().bucket(FIREBASE_STORAGE_BUCKET) : null;

const CLOUDINARY_ENABLED = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// ---- Config ----
// Change this to your own password before running the site.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'qwerty';
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

  if (!CLOUDINARY_ENABLED) {
    return {
      images: files.map(file => `/uploads/${file.filename}`),
      publicIds: []
    };
  }

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

async function removeCloudinaryMedia(publicIds) {
  if (!CLOUDINARY_ENABLED || !Array.isArray(publicIds)) return;
  await Promise.all(publicIds.filter(Boolean).map(publicId =>
    cloudinary.uploader.destroy(publicId, { resource_type: 'image' })
  ));
}

// ---- Auth routes ----
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(24).toString('hex');
    activeSessions.add(token);
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const snapshot = await db.collection('admins')
      .where('username', '==', username)
      .where('password', '==', password)
      .get();

    if (snapshot.empty) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password'
      });
    }

    let adminData = {};
    snapshot.forEach(doc => {
      adminData = { id: doc.id, ...doc.data() };
    });

    const token = crypto.randomBytes(24).toString('hex');
    activeSessions.add(token);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      admin: {
        username: adminData.username,
        email: adminData.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
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
    const snapshot = await productsCollection.orderBy('createdAt', 'desc').get();
    const products = [];
    snapshot.forEach(doc => {
      products.push({ id: doc.id, ...doc.data() });
    });
    res.json(products);
  } catch (error) {
    console.error('FIREBASE FETCH ERROR:', error.message);
    res.status(500).json({
      success: false,
      message: 'Firebase connection failed',
      error: error.message
    });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ sellerPhone: SELLER_PHONE_NUMBER });
});

// ---- Admin routes (all require a valid session token) ----
app.post('/api/admin/create', requireAuth, async (req, res) => {
  const { email, password, username } = req.body;
  try {
    const userRecord = await getAuth().createUser({
      email,
      password,
      displayName: username
    });

    await db.collection('admin_profiles').doc(userRecord.uid).set({
      username,
      email,
      role: 'admin',
      createdAt: new Date()
    });

    res.json({ success: true, uid: userRecord.uid });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
