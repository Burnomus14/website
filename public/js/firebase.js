import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBsPR_RgRtmrepdVX8ftrr_SZJNfYlJsxE',
  authDomain: 'collection-6d7f6.firebaseapp.com',
  projectId: 'collection-6d7f6',
  appId: '1:234436994449:web:33681566de0a37f8aa6630'
};

export const auth = getAuth(initializeApp(firebaseConfig));

export async function getMarketplaceToken() {
  if (localStorage.getItem('adminToken')) return null;
  await auth.authStateReady();
  return auth.currentUser ? auth.currentUser.getIdToken() : null;
}
