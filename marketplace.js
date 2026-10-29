const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createMarketplace({
  db,
  firebaseAuth,
  dataDir,
  adminSessions,
  readCatalogItems,
  writeCatalogItems,
  uploadImages,
  uploadMedia,
  getMediaUrls,
  removeUnreferencedMedia,
  removeCloudinaryMedia
}) {
  const router = express.Router();
  const localStoreFile = path.join(dataDir, 'marketplace.json');
  const sessions = new Map();
  const collections = ['users', 'carts', 'wishlists', 'addresses', 'orders', 'shippers', 'categories'];

  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const register = router[method].bind(router);
    router[method] = (routePath, ...handlers) => register(
      routePath,
      ...handlers.map(handler => {
        if (handler.constructor?.name !== 'AsyncFunction') return handler;
        return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
      })
    );
  }

  function readLocalStore() {
    if (!fs.existsSync(localStoreFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(localStoreFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  function writeLocalStore(store) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryFile = `${localStoreFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2));
    fs.renameSync(temporaryFile, localStoreFile);
  }

  async function listRecords(collection) {
    if (!collections.includes(collection)) throw new Error(`Unknown marketplace collection: ${collection}`);
    if (!db) return Object.values(readLocalStore()[collection] || {});
    const snapshot = await db.collection(`marketplace_${collection}`).get();
    return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
  }

  async function saveRecord(collection, record) {
    if (!collections.includes(collection)) throw new Error(`Unknown marketplace collection: ${collection}`);
    if (!record.id) throw new Error('A marketplace record ID is required.');
    if (db) {
      const { id, ...data } = record;
      await db.collection(`marketplace_${collection}`).doc(id).set(data);
      return record;
    }
    const store = readLocalStore();
    store[collection] = store[collection] || {};
    store[collection][record.id] = record;
    writeLocalStore(store);
    return record;
  }

  async function deleteRecord(collection, id) {
    if (!collections.includes(collection)) throw new Error(`Unknown marketplace collection: ${collection}`);
    if (db) {
      await db.collection(`marketplace_${collection}`).doc(id).delete();
      return;
    }
    const store = readLocalStore();
    if (store[collection]) {
      delete store[collection][id];
      writeLocalStore(store);
    }
  }

  function publicUser(user) {
    const { passwordHash, ...safe } = user;
    return safe;
  }

  async function getUser(userId) {
    const users = await listRecords('users');
    const user = users.find(record =>
      (record.id === userId || record.firebaseUid === userId) && !record.isRestricted
    ) || null;

    if (user?.firebaseUid && user.passwordHash) {
      delete user.passwordHash;
      await saveRecord('users', user);
    }
    return user;
  }

  async function resolveUserToken(token) {
    if (!token) return null;
    const userId = sessions.get(token);
    if (userId) {
      const user = await getUser(userId);
      if (!user) sessions.delete(token);
      return user;
    }
    if (!firebaseAuth) return null;

    try {
      const decodedToken = await firebaseAuth.verifyIdToken(token);
      if (!decodedToken.email_verified) return null;
      return await getUser(decodedToken.uid);
    } catch (error) {
      if (error.code === 'auth/argument-error' || error.code === 'auth/id-token-expired' ||
          error.code === 'auth/invalid-id-token' || error.code === 'auth/invalid-argument') {
        return null;
      }
      throw error;
    }
  }

  async function authenticate(req, res, next) {
    const adminToken = req.headers['x-admin-token'];
    if (adminToken && adminSessions.has(adminToken)) {
      req.marketUser = { id: 'admin', username: 'admin', email: '', roles: ['admin'] };
      req.marketAdminToken = true;
      return next();
    }

    const token = req.headers['x-marketplace-token'] || req.headers['x-auth-token'];
    const user = await resolveUserToken(token);
    if (!user) return res.status(401).json({ success: false, message: 'Sign in to continue.' });
    req.marketUser = user;
    req.marketToken = token;
    return next();
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (req.marketUser.roles?.some(role => roles.includes(role))) return next();
      return res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
    };
  }

  function cleanText(value, maxLength = 180) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function makeId() {
    return crypto.randomBytes(12).toString('hex');
  }

  function getTrackingId(existingOrders = []) {
    const existingIds = new Set(existingOrders.map(order => order.trackingId).filter(Boolean));
    let trackingId;
    do {
      trackingId = crypto.randomBytes(8).toString('hex').toUpperCase();
    } while (existingIds.has(trackingId));
    return trackingId;
  }

  function getOrderStatus(items) {
    if (items.every(item => item.status === 'delivered')) return 'delivered';
    if (items.every(item => item.status === 'shipped' || item.status === 'delivered')) return 'shipped';
    return items.some(item => item.status !== 'pending') ? 'processing' : 'pending';
  }

  async function ensureOrderTrackingId(order, existingOrders) {
    const orders = existingOrders || await listRecords('orders');
    const matches = orders.filter(record => record.trackingId === order.trackingId);
    if (/^[A-F0-9]{16}$/.test(order.trackingId || '') && matches.length <= 1) return;
    order.trackingId = getTrackingId(orders.filter(record => record.id !== order.id));
    await saveRecord('orders', order);
  }

  async function getCatalogItem(id) {
    const items = await readCatalogItems();
    return items.find(item => String(item.id) === String(id)) || null;
  }

  async function loadCart(userId) {
    const carts = await listRecords('carts');
    return carts.find(cart => cart.userId === userId) || { id: userId, userId, items: [], updatedAt: Date.now() };
  }

  async function populateCart(cart) {
    const products = await readCatalogItems();
    return {
      ...cart,
      items: cart.items.map(line => {
        const product = products.find(item => String(item.id) === String(line.productId));
        return product ? { product, quantity: line.quantity } : null;
      }).filter(Boolean)
    };
  }

  async function recordPaidOrder(transaction) {
    const orderId = transaction.orderId || transaction.checkoutRequestId || makeId();
    const orders = await listRecords('orders');
    const existing = orders.find(order => order.id === orderId);
    if (existing) {
      await ensureOrderTrackingId(existing, orders);
      return existing;
    }

    const productItems = await readCatalogItems();
    const orderItems = (transaction.itemLines || []).map(line => {
      const product = productItems.find(item => String(item.id) === String(line.itemId));
      return {
        id: makeId(),
        productId: String(line.itemId),
        name: product?.name || line.itemName || 'Collection item',
        image: product?.image || product?.images?.[0] || '',
        quantity: line.quantity,
        unitPrice: Number(line.unitAmount) || 0,
        sellerId: product?.ownerId || 'admin',
        status: 'pending',
        shippedAt: null,
        deliveredAt: null
      };
    });

    const order = {
      id: orderId,
      trackingId: getTrackingId(orders),
      userId: transaction.marketplaceUserId || null,
      customerName: cleanText(transaction.customerName, 120) || 'Guest customer',
      phoneNumber: cleanText(transaction.phoneNumber, 20),
      address: transaction.deliveryAddress || null,
      items: orderItems,
      totalPrice: Number(transaction.amount) || orderItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
      paymentMethod: 'mpesa',
      paymentStatus: 'paid',
      status: 'processing',
      checkoutRequestId: transaction.checkoutRequestId || null,
      createdAt: Date.now(),
      paidAt: Date.now()
    };

    await saveRecord('orders', order);
    return order;
  }

  router.post('/auth/register', async (req, res) => {
    if (!firebaseAuth || !db) {
      return res.status(503).json({ success: false, message: 'Account registration is temporarily unavailable.' });
    }

    let decodedToken;
    try {
      decodedToken = await firebaseAuth.verifyIdToken(req.headers['x-marketplace-token']);
    } catch (error) {
      if (error.code === 'auth/argument-error' || error.code === 'auth/id-token-expired' ||
          error.code === 'auth/invalid-id-token' || error.code === 'auth/invalid-argument') {
        return res.status(401).json({ success: false, message: 'Sign in and verify your email to continue.' });
      }
      throw error;
    }

    if (!decodedToken.email_verified) {
      return res.status(403).json({ success: false, message: 'Verify your email address before continuing.' });
    }

    const firstName = cleanText(req.body.firstName, 80);
    const lastName = cleanText(req.body.lastName, 80);
    const username = cleanText(req.body.username, 40);
    const email = cleanText(decodedToken.email, 254).toLowerCase();

    if (!firstName || !lastName || !username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Enter your first name, last name, and username.' });
    }

    const users = await listRecords('users');
    const linkedUser = users.find(user => user.firebaseUid === decodedToken.uid || user.id === decodedToken.uid);
    const legacyUser = users.find(user => String(user.email || '').toLowerCase() === email);
    const user = linkedUser || legacyUser;

    if (user?.isRestricted) {
      return res.status(403).json({ success: false, message: 'This account is restricted. Contact the store administrator.' });
    }

    if (legacyUser?.firebaseUid && legacyUser.firebaseUid !== decodedToken.uid) {
      return res.status(409).json({ success: false, message: 'This email is linked to a different sign-in account. Use password recovery.' });
    }

    if (users.some(candidate => candidate.id !== user?.id &&
        String(candidate.username || '').toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ success: false, message: 'That username is already registered.' });
    }

    const updatedUser = user || {
      id: decodedToken.uid,
      roles: ['customer'],
      isRestricted: false,
      sellerApplication: null,
      createdAt: Date.now()
    };

    updatedUser.firebaseUid = decodedToken.uid;
    updatedUser.username = username;
    updatedUser.email = email;
    updatedUser.firstName = firstName;
    updatedUser.lastName = lastName;
    delete updatedUser.passwordHash;

    const savedUser = updatedUser;
    await saveRecord('users', savedUser);

    res.status(user ? 200 : 201).json({ success: true, user: publicUser(savedUser) });
  });

  router.get('/auth/me', authenticate, (req, res) => {
    res.json({ success: true, user: publicUser(req.marketUser) });
  });

  router.patch('/profile', authenticate, requireRole('customer', 'seller', 'shipper', 'admin'), async (req, res) => {
    if (req.marketAdminToken) return res.status(400).json({ success: false, message: 'Edit admin details in the admin panel.' });

    const users = await listRecords('users');
    const user = users.find(record => record.id === req.marketUser.id);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

    const firstName = req.body.firstName === undefined ? user.firstName : cleanText(req.body.firstName, 80);
    const lastName = req.body.lastName === undefined ? user.lastName : cleanText(req.body.lastName, 80);
    const username = req.body.username === undefined ? user.username : cleanText(req.body.username, 40);

    if (!firstName || !lastName || !username) {
      return res.status(400).json({ success: false, message: 'First name, last name, and username are required.' });
    }

    if (users.some(candidate => candidate.id !== user.id && candidate.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ success: false, message: 'That username is already in use.' });
    }

    user.firstName = firstName;
    user.lastName = lastName;
    user.username = username;
    await saveRecord('users', user);

    res.json({ success: true, user: publicUser(user) });
  });

  router.post('/auth/logout', (req, res) => {
    const token = req.headers['x-marketplace-token'] || req.headers['x-auth-token'];
    if (token) sessions.delete(token);
    res.json({ success: true });
  });

  router.post('/seller/apply', authenticate, requireRole('customer', 'seller'), async (req, res) => {
    const user = req.marketUser;
    if (user.roles.includes('seller')) return res.status(409).json({ success: false, message: 'Your account is already a seller.' });

    user.sellerApplication = { status: 'pending', submittedAt: Date.now(), note: cleanText(req.body.note, 500) };
    await saveRecord('users', user);

    res.json({ success: true, user: publicUser(user) });
  });

  router.get('/products', authenticate, requireRole('seller', 'admin'), async (req, res) => {
    const items = await readCatalogItems();
    const products = req.marketUser.roles.includes('admin')
      ? items
      : items.filter(item => item.ownerId === req.marketUser.id);

    res.json({ success: true, products });
  });

  router.post('/products', authenticate, requireRole('seller', 'admin'), uploadImages, async (req, res) => {
    const name = cleanText(req.body.name, 120);
    const category = cleanText(req.body.category, 80);
    const quantity = Number(req.body.quantity);

    if (!name || !category || !Number.isSafeInteger(quantity) || quantity < 0) {
      return res.status(400).json({ success: false, message: 'Name, category, and a non-negative whole-number quantity are required.' });
    }

    const price = Number(String(req.body.price || '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, message: 'Enter a valid price.' });
    }

    const files = req.files?.images?.length ? req.files.images : req.files?.image || [];
    let media;

    try {
      media = await uploadMedia(files);
    } catch (error) {
      console.error('Marketplace product image upload failed:', error.message);
      return res.status(500).json({ success: false, message: 'Could not upload product images.' });
    }

    const items = await readCatalogItems();
    const product = {
      id: makeId(),
      name,
      category,
      caption: cleanText(req.body.caption, 2000),
      price: `KSh ${Math.round(price)}`,
      quantity,
      status: quantity > 0 ? 'in-stock' : 'sold',
      images: media.images,
      image: media.images[0] || null,
      cloudinaryPublicIds: media.publicIds,
      ownerId: req.marketUser.id,
      createdAt: Date.now()
    };

    items.push(product);
    await writeCatalogItems(items);

    res.status(201).json({ success: true, product });
  });

  router.patch('/products/:id', authenticate, requireRole('seller', 'admin'), uploadImages, async (req, res) => {
    const items = await readCatalogItems();
    const index = items.findIndex(item => String(item.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ success: false, message: 'Product not found.' });

    const existing = items[index];
    if (!req.marketUser.roles.includes('admin') && existing.ownerId !== req.marketUser.id) {
      return res.status(403).json({ success: false, message: 'You can only edit your own products.' });
    }

    const quantity = req.body.quantity === undefined ? existing.quantity : Number(req.body.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      return res.status(400).json({ success: false, message: 'Quantity must be a non-negative whole number.' });
    }

    const files = req.files?.images?.length ? req.files.images : req.files?.image || [];
    let media;

    if (files.length) {
      try {
        media = await uploadMedia(files);
      } catch (error) {
        console.error('Marketplace product image upload failed:', error.message);
        return res.status(500).json({ success: false, message: 'Could not upload product images.' });
      }
    }

    const nextPrice = req.body.price === undefined
      ? existing.price
      : `KSh ${Math.round(Number(String(req.body.price).replace(/[^\d.]/g, '')) || 0)}`;

    if (req.body.price !== undefined && Number(nextPrice.replace(/[^\d.]/g, '')) <= 0) {
      return res.status(400).json({ success: false, message: 'Enter a valid price.' });
    }

    const previousMedia = getMediaUrls(existing);

    items[index] = {
      ...existing,
      name: req.body.name === undefined ? existing.name : cleanText(req.body.name, 120),
      category: req.body.category === undefined ? existing.category : cleanText(req.body.category, 80),
      caption: req.body.caption === undefined ? existing.caption : cleanText(req.body.caption, 2000),
      price: nextPrice,
      quantity,
      status: quantity > 0 ? 'in-stock' : 'sold',
      ...(media ? { images: media.images, image: media.images[0] || null, cloudinaryPublicIds: media.publicIds } : {})
    };

    await writeCatalogItems(items);

    if (media) {
      removeUnreferencedMedia(previousMedia, items);
      await removeCloudinaryMedia(existing.cloudinaryPublicIds);
    }

    res.json({ success: true, product: items[index] });
  });

  router.delete('/products/:id', authenticate, requireRole('seller', 'admin'), async (req, res) => {
    const items = await readCatalogItems();
    const index = items.findIndex(item => String(item.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ success: false, message: 'Product not found.' });

    const product = items[index];
    if (!req.marketUser.roles.includes('admin') && product.ownerId !== req.marketUser.id) {
      return res.status(403).json({ success: false, message: 'You can only delete your own products.' });
    }

    items.splice(index, 1);
    await writeCatalogItems(items);
    removeUnreferencedMedia(getMediaUrls(product), items);
    await removeCloudinaryMedia(product.cloudinaryPublicIds);

    res.json({ success: true });
  });

  router.get('/categories', async (req, res) => {
    const categories = await listRecords('categories');
    const items = await readCatalogItems();
    const names = new Set(categories.map(category => category.name));
    items.forEach(item => { if (item.category) names.add(item.category); });

    const result = [...names].map(name => {
      const managed = categories.find(category => category.name === name);
      return managed ? { ...managed, managed: true } : { id: `archive:${encodeURIComponent(name)}`, name, managed: false };
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ success: true, categories: result });
  });

  router.post('/categories', authenticate, requireRole('seller', 'admin'), async (req, res) => {
    const name = cleanText(req.body.name, 80);
    const description = cleanText(req.body.description, 500);

    if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });

    const categories = await listRecords('categories');
    const items = await readCatalogItems();

    if (categories.some(category => category.name.toLowerCase() === name.toLowerCase()) ||
        items.some(item => String(item.category || '').toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ success: false, message: 'That category already exists.' });
    }

    const category = { id: makeId(), name, description, managed: true, createdAt: Date.now() };
    await saveRecord('categories', category);

    res.status(201).json({ success: true, category });
  });

  router.patch('/categories/:id', authenticate, requireRole('admin'), async (req, res) => {
    const categories = await listRecords('categories');
    const name = cleanText(req.body.name, 80);
    if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });

    const existing = categories.find(record => record.id === req.params.id);
    const items = await readCatalogItems();
    let oldName = existing?.name || '';

    if (!existing && req.params.id.startsWith('archive:')) {
      try {
        oldName = decodeURIComponent(req.params.id.slice('archive:'.length));
      } catch {
        return res.status(400).json({ success: false, message: 'Invalid category identifier.' });
      }
    }

    if ([...categories.map(record => record.name), ...items.map(item => item.category)]
      .some(categoryName => String(categoryName || '').toLowerCase() === name.toLowerCase() && categoryName !== oldName)) {
      return res.status(409).json({ success: false, message: 'That category already exists.' });
    }

    if (existing) {
      existing.name = name;
      existing.description = cleanText(req.body.description, 500);
      await saveRecord('categories', existing);

      let changed = false;
      items.forEach(item => {
        if (item.category === oldName) {
          item.category = name;
          changed = true;
        }
      });

      if (changed) await writeCatalogItems(items);
      return res.json({ success: true, category: existing });
    }

    if (!req.params.id.startsWith('archive:')) return res.status(404).json({ success: false, message: 'Category not found.' });

    let legacyName;
    try {
      legacyName = decodeURIComponent(req.params.id.slice('archive:'.length));
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid category identifier.' });
    }

    if (!items.some(item => item.category === legacyName)) return res.status(404).json({ success: false, message: 'Category not found.' });

    items.forEach(item => { if (item.category === legacyName) item.category = name; });
    await writeCatalogItems(items);

    res.json({ success: true, category: { name, managed: false } });
  });

  router.delete('/categories/:id', authenticate, requireRole('admin'), async (req, res) => {
    const categories = await listRecords('categories');
    let category = categories.find(record => record.id === req.params.id);

    if (!category && req.params.id.startsWith('archive:')) {
      try {
        category = { name: decodeURIComponent(req.params.id.slice('archive:'.length)), managed: false };
      } catch {
        return res.status(400).json({ success: false, message: 'Invalid category identifier.' });
      }
    }

    if (!category) return res.status(404).json({ success: false, message: 'Category not found.' });

    const items = await readCatalogItems();
    if (items.some(item => item.category === category.name)) {
      return res.status(409).json({ success: false, message: 'This category is assigned to products and cannot be deleted.' });
    }

    if (category.id) await deleteRecord('categories', req.params.id);

    res.json({ success: true });
  });

  router.get('/cart', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const cart = await loadCart(req.marketUser.id);
    res.json({ success: true, cart: await populateCart(cart) });
  });

  router.put('/cart', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    if (!Array.isArray(req.body.items) || req.body.items.length > 100) {
      return res.status(400).json({ success: false, message: 'Basket items must be a list of 100 items or fewer.' });
    }

    const products = await readCatalogItems();
    const items = [];

    for (const line of req.body.items) {
      const productId = String(line?.productId || '');
      const quantity = Number(line?.quantity);
      const product = products.find(item => String(item.id) === productId);

      if (!product || product.status !== 'in-stock' || !Number.isSafeInteger(quantity) ||
          quantity < 1 || quantity > Number(product.quantity)) {
        return res.status(400).json({ success: false, message: 'One or more basket items are unavailable or exceed current stock.' });
      }

      items.push({ productId, quantity });
    }

    const cart = { id: req.marketUser.id, userId: req.marketUser.id, items, updatedAt: Date.now() };
    await saveRecord('carts', cart);

    res.json({ success: true, cart: await populateCart(cart) });
  });

  router.put('/cart/items/:productId', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const product = await getCatalogItem(req.params.productId);
    const quantity = Number(req.body.quantity);

    if (!product || product.status !== 'in-stock' || product.quantity < 1) {
      return res.status(404).json({ success: false, message: 'This product is not available.' });
    }

    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > product.quantity) {
      return res.status(400).json({ success: false, message: 'Choose a valid quantity within available stock.' });
    }

    const cart = await loadCart(req.marketUser.id);
    const line = cart.items.find(item => item.productId === String(product.id));
    if (line) line.quantity = quantity;
    else cart.items.push({ productId: String(product.id), quantity });

    cart.updatedAt = Date.now();
    await saveRecord('carts', cart);

    res.json({ success: true, cart: await populateCart(cart) });
  });

  router.delete('/cart/items/:productId', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const cart = await loadCart(req.marketUser.id);
    cart.items = cart.items.filter(item => item.productId !== String(req.params.productId));
    cart.updatedAt = Date.now();
    await saveRecord('carts', cart);

    res.json({ success: true, cart: await populateCart(cart) });
  });

  router.get('/wishlist', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const lists = await listRecords('wishlists');
    const wishlist = lists.find(list => list.userId === req.marketUser.id) || { id: req.marketUser.id, userId: req.marketUser.id, productIds: [] };
    const products = await readCatalogItems();

    res.json({ success: true, wishlist: wishlist.productIds.map(id => products.find(product => String(product.id) === id)).filter(Boolean) });
  });

  router.put('/wishlist/:productId', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    if (!await getCatalogItem(req.params.productId)) return res.status(404).json({ success: false, message: 'Product not found.' });

    const lists = await listRecords('wishlists');
    const wishlist = lists.find(list => list.userId === req.marketUser.id) || { id: req.marketUser.id, userId: req.marketUser.id, productIds: [] };
    if (!wishlist.productIds.includes(String(req.params.productId))) wishlist.productIds.push(String(req.params.productId));

    await saveRecord('wishlists', wishlist);

    res.json({ success: true });
  });

  router.delete('/wishlist/:productId', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const lists = await listRecords('wishlists');
    const wishlist = lists.find(list => list.userId === req.marketUser.id) || { id: req.marketUser.id, userId: req.marketUser.id, productIds: [] };
    wishlist.productIds = wishlist.productIds.filter(id => id !== String(req.params.productId));
    await saveRecord('wishlists', wishlist);

    res.json({ success: true });
  });

  router.get('/addresses', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const addresses = await listRecords('addresses');
    res.json({ success: true, addresses: addresses.filter(address => address.userId === req.marketUser.id) });
  });

  router.post('/addresses', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const address = {
      id: makeId(),
      userId: req.marketUser.id,
      recipient: cleanText(req.body.recipient, 120),
      phone: cleanText(req.body.phone, 20),
      country: cleanText(req.body.country, 80) || 'Kenya',
      state: cleanText(req.body.state, 100),
      city: cleanText(req.body.city, 100),
      street: cleanText(req.body.street, 160),
      addressLine: cleanText(req.body.addressLine, 240),
      postalCode: cleanText(req.body.postalCode, 20),
      createdAt: Date.now()
    };

    if (!address.recipient || !address.phone || !address.state || !address.city || !address.street) {
      return res.status(400).json({ success: false, message: 'Recipient, phone, area/county, city, and street are required.' });
    }

    await saveRecord('addresses', address);

    res.status(201).json({ success: true, address });
  });

  router.patch('/addresses/:id', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const addresses = await listRecords('addresses');
    const address = addresses.find(record => record.id === req.params.id && record.userId === req.marketUser.id);
    if (!address) return res.status(404).json({ success: false, message: 'Address not found.' });

    for (const key of ['recipient', 'phone', 'country', 'state', 'city', 'street', 'addressLine', 'postalCode']) {
      if (req.body[key] !== undefined) address[key] = cleanText(req.body[key], key === 'addressLine' ? 240 : 160);
    }

    if (!address.recipient || !address.phone || !address.state || !address.city || !address.street) {
      return res.status(400).json({ success: false, message: 'Recipient, phone, area/county, city, and street are required.' });
    }

    await saveRecord('addresses', address);

    res.json({ success: true, address });
  });

  router.delete('/addresses/:id', authenticate, requireRole('customer', 'seller', 'admin'), async (req, res) => {
    const addresses = await listRecords('addresses');
    const address = addresses.find(record => record.id === req.params.id && record.userId === req.marketUser.id);
    if (!address) return res.status(404).json({ success: false, message: 'Address not found.' });

    await deleteRecord('addresses', address.id);

    res.json({ success: true });
  });

  router.get('/orders', authenticate, async (req, res) => {
    const orders = await listRecords('orders');
    for (const order of orders) {
      await ensureOrderTrackingId(order, orders);
    }

    const user = req.marketUser;
    let visible;

    if (user.roles.includes('admin')) visible = orders;
    else {
      const orderMap = new Map();

      if (user.roles.includes('customer')) {
        orders.filter(order => order.userId === user.id).forEach(order => orderMap.set(order.id, order));
      }

      if (user.roles.includes('seller')) {
        orders.forEach(order => {
          const sellerItems = order.items.filter(item => item.sellerId === user.id);
          if (sellerItems.length && !orderMap.has(order.id)) orderMap.set(order.id, { ...order, items: sellerItems });
        });
      }

      visible = [...orderMap.values()].filter(order => order.items.length);
    }

    visible.sort((a, b) => b.createdAt - a.createdAt);

    res.json({ success: true, orders: visible });
  });

  router.get('/seller/orders', authenticate, requireRole('seller'), async (req, res) => {
    const orders = await listRecords('orders');
    const visible = [];

    for (const order of orders) {
      const sellerItems = order.items.filter(item => item.sellerId === req.marketUser.id);
      if (!sellerItems.length) continue;
      await ensureOrderTrackingId(order, orders);
      visible.push({ ...order, items: sellerItems });
    }

    visible.sort((a, b) => b.createdAt - a.createdAt);

    res.json({ success: true, orders: visible });
  });

  router.get('/shipper/orders', authenticate, requireRole('shipper', 'admin'), async (req, res) => {
    const orders = await listRecords('orders');
    const shippers = await listRecords('shippers');
    const profile = shippers.find(record => record.userId === req.marketUser.id);
    const area = String(profile?.area || '').trim().toLowerCase();

    const visible = req.marketUser.roles.includes('admin')
      ? orders
      : area
        ? orders.filter(order => String(order.address?.state || '').trim().toLowerCase() === area)
        : [];

    for (const order of visible) {
      await ensureOrderTrackingId(order, orders);
    }

    const deliveries = visible.map(order => ({
      ...order,
      items: order.items.filter(item => item.status === 'shipped' || item.status === 'delivered')
    })).filter(order => order.items.length);

    deliveries.sort((a, b) => b.createdAt - a.createdAt);

    res.json({ success: true, orders: deliveries });
  });

  router.patch('/orders/:orderId/items/:itemId/ship', authenticate, requireRole('seller', 'admin'), async (req, res) => {
    const orders = await listRecords('orders');
    const order = orders.find(record => record.id === req.params.orderId);
    const item = order?.items.find(record => record.id === req.params.itemId);

    if (!order || !item) return res.status(404).json({ success: false, message: 'Order item not found.' });
    if (!req.marketUser.roles.includes('admin') && item.sellerId !== req.marketUser.id) {
      return res.status(403).json({ success: false, message: 'You can only update your own order items.' });
    }
    if (item.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'Only pending order items can be marked as shipped.' });
    }

    item.status = 'shipped';
    item.shippedAt = Date.now();
    order.status = getOrderStatus(order.items);

    await saveRecord('orders', order);

    res.json({ success: true, order });
  });

  router.patch('/orders/:orderId/items/:itemId/deliver', authenticate, requireRole('shipper', 'admin'), async (req, res) => {
    const orders = await listRecords('orders');
    const order = orders.find(record => record.id === req.params.orderId);
    const item = order?.items.find(record => record.id === req.params.itemId);

    if (!order || !item) return res.status(404).json({ success: false, message: 'Order item not found.' });
    if (item.status !== 'shipped') {
      return res.status(409).json({ success: false, message: 'Only shipped order items can be marked as delivered.' });
    }

    if (!req.marketUser.roles.includes('admin')) {
      const shippers = await listRecords('shippers');
      const profile = shippers.find(record => record.userId === req.marketUser.id);

      if (!profile?.area || profile.area.trim().toLowerCase() !== String(order.address?.state || '').trim().toLowerCase()) {
        return res.status(403).json({ success: false, message: 'This order is outside your assigned delivery area.' });
      }
    }

    item.status = 'delivered';
    item.deliveredAt = Date.now();
    order.status = getOrderStatus(order.items);

    await saveRecord('orders', order);

    res.json({ success: true, order });
  });

  router.get('/admin/users', authenticate, requireRole('admin'), async (req, res) => {
    const users = await listRecords('users');
    res.json({ success: true, users: users.map(publicUser) });
  });

  router.patch('/admin/users/:id/roles', authenticate, requireRole('admin'), async (req, res) => {
    const users = await listRecords('users');
    const user = users.find(record => record.id === req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const allowedRoles = new Set(['customer', 'seller', 'shipper', 'admin']);
    const roles = [...new Set(Array.isArray(req.body.roles) ? req.body.roles : [])];

    if (!roles.includes('customer') || roles.some(role => !allowedRoles.has(role))) {
      return res.status(400).json({ success: false, message: 'Roles must include customer and contain only supported roles.' });
    }

    user.roles = roles;
    if (roles.includes('seller') && user.sellerApplication) user.sellerApplication.status = 'approved';
    if (!roles.includes('seller') && user.sellerApplication?.status === 'pending') user.sellerApplication.status = 'declined';
await saveRecord('users', user);

    res.json({ success: true, user: publicUser(user) });
  });

  router.patch('/admin/users/:id/restrict', authenticate, requireRole('admin'), async (req, res) => {
    const users = await listRecords('users');
    const user = users.find(record => record.id === req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (typeof req.body.restricted !== 'boolean') {
      return res.status(400).json({ success: false, message: 'A boolean restricted value is required.' });
    }

    user.isRestricted = req.body.restricted;

    await saveRecord('users', user);

    res.json({ success: true, user: publicUser(user) });

  router.get('/admin/shippers', authenticate, requireRole('admin'), async (req, res) => {
    const [users, shippers] = await Promise.all([listRecords('users'), listRecords('shippers')]);

    const profiles = users.filter(user => user.roles.includes('shipper')).map(user => {
      const profile = shippers.find(shipper => shipper.userId === user.id) || { id: user.id, userId: user.id };
      return { ...profile, user: publicUser(user) };
    });

    res.json({ success: true, shippers: profiles });
  });

  router.put('/admin/shippers/:userId', authenticate, requireRole('admin'), async (req, res) => {
    const users = await listRecords('users');
    const user = users.find(record => record.id === req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const area = cleanText(req.body.area, 100);
    if (!area) return res.status(400).json({ success: false, message: 'A delivery area is required.' });

    user.roles = [...new Set([...(user.roles || ['customer']), 'shipper'])];
    await saveRecord('users', user);

    const shippers = await listRecords('shippers');
    const profile = shippers.find(record => record.userId === user.id) || { id: user.id, userId: user.id };
    profile.area = area;
    profile.company = cleanText(req.body.company, 120);
    profile.phone = cleanText(req.body.phone, 30);
    profile.updatedAt = Date.now();

    await saveRecord('shippers', profile);

    res.json({ success: true, shipper: { ...profile, user: publicUser(user) } });
  });

  router.get('/admin/overview', authenticate, requireRole('admin'), async (req, res) => {
    const [items, users, orders] = await Promise.all([readCatalogItems(), listRecords('users'), listRecords('orders')]);
    const totalStock = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

    res.json({
      success: true,
      stats: {
        totalItems: items.length,
        totalStock,
        lowStockCount: items.filter(item => Number(item.quantity) <= 3).length,
        customerCount: users.filter(user => user.roles.includes('customer')).length,
        orderCount: orders.length,
        pendingOrders: orders.filter(order => order.status !== 'delivered').length
      }
    });
  });

  return {
    router,
    resolveUserToken,
    createPaidOrder: recordPaidOrder,
    findAddress: async (userId, addressId) => {
      const addresses = await listRecords('addresses');
      return addresses.find(address => address.id === addressId && address.userId === userId) || null;
    }
  };
}

module.exports = createMarketplace;
