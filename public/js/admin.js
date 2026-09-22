const adminWrap = document.getElementById('adminWrap');
const logoutBtn = document.getElementById('logoutBtn');

const itemForm = document.getElementById('itemForm');
const formTitle = document.getElementById('formTitle');
const submitBtn = document.getElementById('submitBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const formError = document.getElementById('formError');
const tableBody = document.getElementById('itemsTableBody');
const toast = document.getElementById('toast');
const customUploadBtn = document.getElementById('customUploadBtn');
const imageInput = document.getElementById('imageInput');

customUploadBtn.addEventListener('click', () => {
  imageInput.removeAttribute('capture');
  imageInput.click();
});

let token = localStorage.getItem('adminToken') || null;
let items = [];
let editingId = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

logoutBtn.addEventListener('click', async () => {
  try {
    await authedFetch('/api/logout', { method: 'POST' });
  } catch {}
  token = null;
  localStorage.removeItem('adminToken');
  window.location.href = '/admin-login.html';
});

async function authedFetch(url, options = {}) {
  const headers = options.headers || {};
  headers['x-admin-token'] = token;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    token = null;
    localStorage.removeItem('adminToken');
    window.location.href = '/admin-login.html';
    throw new Error('Session expired');
  }
  return res;
}

// ---- Load + render items ----
async function loadItems() {
  const res = await fetch('/api/items');
  items = await res.json();
  renderTable();
}

function renderTable() {
  if (items.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="6" style="color:var(--ink-dim); padding:24px 12px;">No items yet — add your first one above.</td></tr>`;
    return;
  }

  tableBody.innerHTML = items.map(item => {
    const image = getItemImages(item)[0];
    return `
    <tr data-id="${item.id}">
      <td>${image ? `<img class="admin-thumb" src="${image}" alt="" />` : `<div class="admin-thumb"></div>`}</td>
      <td>${escapeHtml(item.name)}</td>
      <td style="color:var(--ink-dim)">${escapeHtml(item.category)}</td>
      <td>${escapeHtml(item.price || '—')}</td>
      <td>
        <select class="status-select" data-id="${item.id}">
          <option value="in-stock" ${item.status === 'in-stock' ? 'selected' : ''}>In stock</option>
          <option value="regular" ${item.status === 'regular' ? 'selected' : ''}>In archive</option>
          <option value="sold" ${item.status === 'sold' ? 'selected' : ''}>Sold</option>
        </select>
      </td>
      <td>
        <div class="row-actions">
          <button class="btn ghost edit-btn" data-id="${item.id}">Edit</button>
          <button class="btn danger delete-btn" data-id="${item.id}">Delete</button>
        </div>
      </td>
    </tr>
  `;
  }).join('');

  tableBody.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', () => updateStatus(sel.dataset.id, sel.value));
  });
  tableBody.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => startEdit(btn.dataset.id));
  });
  tableBody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteItem(btn.dataset.id));
  });
}

async function updateStatus(id, status) {
  const fd = new FormData();
  fd.append('status', status);
  await authedFetch(`/api/items/${id}`, { method: 'PATCH', body: fd });
  const item = items.find(i => i.id === id);
  if (item) item.status = status;
  showToast(status === 'sold' ? 'Marked as sold' : status === 'in-stock' ? 'Marked as in stock' : 'Status updated');
}

async function deleteItem(id) {
  if (!confirm('Delete this item? This can\'t be undone.')) return;
  await authedFetch(`/api/items/${id}`, { method: 'DELETE' });
  items = items.filter(i => i.id !== id);
  renderTable();
  showToast('Item deleted');
}

function startEdit(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  editingId = id;
  document.getElementById('name').value = item.name;
  document.getElementById('category').value = item.category;
  document.getElementById('price').value = item.price || '';
  document.getElementById('status').value = item.status;
  document.getElementById('caption').value = item.caption || '';
  formTitle.textContent = `Editing "${item.name}"`;
  submitBtn.textContent = 'Save changes';
  cancelEditBtn.style.display = 'inline-block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

cancelEditBtn.addEventListener('click', resetForm);

function resetForm() {
  editingId = null;
  itemForm.reset();
  formTitle.textContent = 'Add a new item';
  submitBtn.textContent = 'Add item';
  cancelEditBtn.style.display = 'none';
  formError.textContent = '';
}

function getItemImages(item) {
  if (Array.isArray(item.images) && item.images.length > 0) return item.images;
  return item.image ? [item.image] : [];
}

// ---- Add / edit submit ----
itemForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';
  submitBtn.disabled = true;

  const fd = new FormData();
  fd.append('name', document.getElementById('name').value.trim());
  fd.append('category', document.getElementById('category').value);
  fd.append('price', document.getElementById('price').value.trim());
  fd.append('status', document.getElementById('status').value);
  fd.append('caption', document.getElementById('caption').value.trim());
  const imageFiles = Array.from(document.getElementById('imageInput').files);
  if (imageFiles.length > 12) {
    formError.textContent = 'Choose up to 12 images.';
    submitBtn.disabled = false;
    return;
  }
  imageFiles.forEach(imageFile => fd.append('images', imageFile));

  try {
    const url = editingId ? `/api/items/${editingId}` : '/api/items';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await authedFetch(url, { method, body: fd });
    if (!res.ok) throw new Error('Save failed');
    showToast(editingId ? 'Item updated' : 'Item added');
    resetForm();
    loadItems();
  } catch (err) {
    formError.textContent = 'Something went wrong saving this item.';
  } finally {
    submitBtn.disabled = false;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---- Init ----
async function initializeDashboard() {
  if (!token) {
    window.location.href = '/admin-login.html';
    return;
  }

  try {
    const res = await authedFetch('/api/session');
    if (!res.ok) throw new Error('Session validation failed');
    adminWrap.style.display = 'block';
    await loadItems();
  } catch {
    window.location.href = '/admin-login.html';
  }
}

initializeDashboard();
