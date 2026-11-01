require('dotenv').config();

const express = require('express');
const compression = require('compression');
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
const { createRateLimiter } = require('./lib/rateLimiter');
const { fetchWithRetry } = require('./lib/fetchWithRetry');
const { syncProducts } = require('./lib/catalogWrite');

const app = express();
// Render (and most hosts) put a reverse proxy in front of the app. Without this,
// req.ip is the proxy's address for every visitor, which breaks per-IP rate limits.
app.set('trust proxy', 1);
// Express 4 does not catch rejected promises in async handlers; forward them to the error handler
// instead of leaving the request hanging.
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const register = app[method].bind(app);
  app[method] = (routePath, ...handlers) => register(
    routePath,
    ...handlers.map(handler => (typeof handler === 'function' && handler.constructor?.name === 'AsyncFunction')
      ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
      : handler)
  );
}
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
