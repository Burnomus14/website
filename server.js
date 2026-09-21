require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SELLER_PHONE_NUMBER = process.env.SELLER_PHONE_NUMBER || '';

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

function writeItems(items) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2));
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

app.post('/api/logout', requireAuth, (req, res) => {
  activeSessions.delete(req.headers['x-admin-token']);
  res.json({ ok: true });
});

// ---- Public routes ----
app.get('/api/items', (req, res) => {
  const items = readItems().sort((a, b) => b.createdAt - a.createdAt);
  res.json(items);
});

app.get('/api/config', (req, res) => {
  res.json({ sellerPhone: SELLER_PHONE_NUMBER });
});

// ---- Admin routes (all require a valid session token) ----
app.post('/api/items', requireAuth, uploadImages, (req, res) => {
  const { name, category, caption, price, status } = req.body;
  if (!name || !category) {
    return res.status(400).json({ error: 'Name and category are required' });
  }
  const items = readItems();
  const uploadedFiles = getUploadedFiles(req);
  const images = uploadedFiles.map(file => `/uploads/${file.filename}`);
  const item = {
    id: crypto.randomBytes(6).toString('hex'),
    name,
    category,           // "shoes" | "clothes"
    caption: caption || '',
    price: price || '',
    status: status || 'in-stock',   // "in-stock" | "sold" | "regular"
    images,
    image: images[0] || null,
    createdAt: Date.now()
  };
  items.push(item);
  writeItems(items);
  res.status(201).json(item);
});

app.patch('/api/items/:id', requireAuth, uploadImages, (req, res) => {
  const items = readItems();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });

  const { name, category, caption, price, status } = req.body;
  const existing = items[idx];
  const uploadedFiles = getUploadedFiles(req);
  const oldMedia = getMediaUrls(existing);
  const uploadedImages = uploadedFiles.map(file => `/uploads/${file.filename}`);
  const images = uploadedFiles.length ? uploadedImages : existing.images;
  items[idx] = {
    ...existing,
    name: name ?? existing.name,
    category: category ?? existing.category,
    caption: caption ?? existing.caption,
    price: price ?? existing.price,
    status: status ?? existing.status,
    ...(uploadedFiles.length ? { images, image: uploadedImages[0] } : {})
  };
  writeItems(items);
  if (uploadedFiles.length) removeUnreferencedMedia(oldMedia, items);
  res.json(items[idx]);
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const items = readItems();
  const idx = items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Item not found' });
  const [removed] = items.splice(idx, 1);
  writeItems(items);
  removeUnreferencedMedia(getMediaUrls(removed), items);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Site running at http://localhost:${PORT}`);
  console.log(`Admin panel at   http://localhost:${PORT}/admin.html`);
});
