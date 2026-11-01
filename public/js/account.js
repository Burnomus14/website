import {
  createUserWithEmailAndPassword,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { auth } from './firebase.js';

const authPanel = document.getElementById('authPanel');
const accountPanel = document.getElementById('accountPanel');
const authForm = document.getElementById('authForm');
const authMessage = document.getElementById('authMessage');
const pendingRegistrationKey = 'pendingMarketplaceRegistration';
const verifiedAccountEmailKey = 'verifiedAccountEmail';
const pendingCheckoutKey = 'pendingMarketplaceCheckout';
let marketplaceUser = null;
let registrationMode = false;
let savedAddresses = [];
let currentAccountCart = [];
let sellerProducts = [];
let sellerPhoneNumber = '254728074301';
async function fetchSellerConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.sellerPhone) sellerPhoneNumber = data.sellerPhone;
  } catch {}
}
fetchSellerConfig();


function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = value == null ? '' : String(value);
  return element.innerHTML;
}

async function getAuthHeaders(extra = {}) {
  const headers = { ...extra };
  const adminToken = localStorage.getItem('adminToken');
  if (adminToken) {
    headers['x-admin-token'] = adminToken;
  } else {
    await auth.authStateReady();
    if (auth.currentUser) headers['x-marketplace-token'] = await auth.currentUser.getIdToken();
  }
  return headers;
}

async function api(path, options = {}) {
  const headers = await getAuthHeaders(options.headers || {});
  const response = await fetch(`/api/marketplace${path}`, { ...options, headers });
