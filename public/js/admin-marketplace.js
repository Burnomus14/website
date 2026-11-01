const token = localStorage.getItem('adminToken');
const statusMessage = document.getElementById('marketplaceStatusMessage');
const marketplaceWrap = document.getElementById('marketplaceWrap');
const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

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
  const element = document.createElement('div');
  element.textContent = value == null ? '' : String(value);
  return element.innerHTML;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers['x-admin-token'] = token;
  const response = await fetch(`/api/marketplace${path}`, { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem('adminToken');
    window.location.href = '/admin-login.html';
    throw new Error('Session expired');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.message || `Request failed (${response.status})`);
  }
  return data;
}

async function loadStats() {
  const { stats } = await api('/admin/overview');
  const container = document.getElementById('marketplaceStats');
  container.innerHTML = Object.entries(stats || {}).map(([key, value]) => `
    <div class="marketplace-stat">
      <strong>${Number(value).toLocaleString()}</strong>
      <span>${escapeHtml(key.replace(/[A-Z]/g, letter => ` ${letter}`).trim())}</span>
    </div>
