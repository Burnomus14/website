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


// Short, readable order code like SCH-7K3Q-M9XD. It is computed from the saved order ID, so it is the same on every page and for old orders too.
function orderCode(id) {
  const text = String(id || '');
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let code = '';
  for (const seed of [2166136261, 84696351]) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
    for (let i = 0; i < 4; i++) { code += alphabet[hash & 31]; hash >>>= 5; }
  }
  return `SCH-${code.slice(0, 4)}-${code.slice(4)}`;
}

function escapeHtml(value) {
