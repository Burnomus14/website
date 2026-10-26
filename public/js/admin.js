const adminWrap = document.getElementById('adminWrap');
const logoutBtn = document.getElementById('logoutBtn');

const itemForm = document.getElementById('itemForm');
const formTitle = document.getElementById('formTitle');
const submitBtn = document.getElementById('submitBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const formError = document.getElementById('formError');
const tableBody = document.getElementById('itemsTableBody');
const itemsSearchInput = document.getElementById('itemsSearchInput');
const toast = document.getElementById('toast');
const customUploadBtn = document.getElementById('customUploadBtn');
const imageInput = document.getElementById('imageInput');
const cameraUploadBtn = document.getElementById('cameraUploadBtn');
const cameraInput = document.getElementById('cameraInput');
const priceInput = document.getElementById('price');
const quantityInput = document.getElementById('quantity');
const statusInput = document.getElementById('status');

customUploadBtn.addEventListener('click', () => {
  imageInput.removeAttribute('capture');
  imageInput.click();
});

cameraUploadBtn.addEventListener('click', () => {
  cameraInput.click();
});

function formatPriceInput() {
  const digitsBeforeCursor = priceInput.value.slice(0, priceInput.selectionStart).replace(/\D/g, '').length;
  const digits = priceInput.value.replace(/\D/g, '');
  const formattedDigits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  priceInput.value = digits ? `${formattedDigits}/=` : '';

  let cursor = 0;
  let digitCount = 0;
  while (cursor < formattedDigits.length && digitCount < digitsBeforeCursor) {
    if (/\d/.test(formattedDigits[cursor])) digitCount++;
    cursor++;
  }
  priceInput.setSelectionRange(cursor, cursor);
}

priceInput.addEventListener('input', formatPriceInput);

let token = localStorage.getItem('adminToken') || null;
let items = [];
let editingId = null;

itemsSearchInput.addEventListener('input', renderTable);

function syncStatusToQuantity() {
  if (statusInput.value === 'regular') return;
  statusInput.value = Number(quantityInput.value) > 0 ? 'in-stock' : 'sold';
}

quantityInput.addEventListener('input', syncStatusToQuantity);
statusInput.addEventListener('change', syncStatusToQuantity);

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
  try {
    const res = await fetch('/api/items');
    const data = await res.json();
    items = Array.isArray(data) ? data : [];
    renderTable();
  } catch (error) {
    console.error('Error loading items:', error);
    items = [];
    renderTable();
  }
}

function renderTable() {
  const query = itemsSearchInput.value.trim().toLowerCase();
  const filteredItems = items.filter(item =>
    [item.name, item.category, item.caption, item.price]
      .some(value => String(value || '').toLowerCase().includes(query))
  );

  if (filteredItems.length === 0) {
    const message = items.length === 0
      ? 'No items yet — add your first one above.'
      : 'No items match your search.';
    tableBody.innerHTML = `<tr><td colspan="7" style="color:var(--ink-dim); padding:24px 12px;">${message}</td></tr>`;
    return;
  }

  tableBody.innerHTML = filteredItems.map(item => {
    const image = getItemImages(item)[0];
    return `
    <tr data-id="${item.id}">
      <td>${image ? `<img class="admin-thumb" src="${image}" alt="" />` : `<div class="admin-thumb"></div>`}</td>
      <td>${escapeHtml(item.name)}</td>
      <td style="color:var(--ink-dim)">${escapeHtml(item.category)}</td>
      <td>${escapeHtml(item.price || '—')}</td>
      <td>${Number(item.quantity) || 0}</td>
      <td>
        <select class="status-select" data-id="${item.id}">
          <option value="auto" ${item.status !== 'regular' ? 'selected' : ''}>${Number(item.quantity) > 0 ? 'In stock' : 'Sold'}</option>
          <option value="regular" ${item.status === 'regular' ? 'selected' : ''}>In archive</option>
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
  const item = items.find(i => String(i.id) === String(id));
  if (!item) return;
  const normalizedStatus = status === 'regular' ? 'regular' : Number(item.quantity) > 0 ? 'in-stock' : 'sold';
  const fd = new FormData();
  fd.append('status', normalizedStatus);
  await authedFetch(`/api/items/${id}`, { method: 'PATCH', body: fd });
  item.status = normalizedStatus;
  renderTable();
  showToast(status === 'regular' ? 'Moved to archive' : normalizedStatus === 'sold' ? 'Marked as sold' : 'Marked as in stock');
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
  priceInput.value = item.price || '';
  formatPriceInput();
  quantityInput.value = Number.isInteger(Number(item.quantity)) ? item.quantity : (item.status === 'sold' ? 0 : 1);
  statusInput.value = item.status;
  syncStatusToQuantity();
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
  fd.append('quantity', quantityInput.value);
  fd.append('status', statusInput.value);
  fd.append('caption', document.getElementById('caption').value.trim());
  const imageFiles = [...imageInput.files, ...cameraInput.files];
  if (imageFiles.length > 8) {
    formError.textContent = 'Choose up to 8 images.';
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

// ---- Add Admin Handlers ----
const toggleAdminBtn = document.getElementById('toggleAdminBtn');
const adminUserSection = document.getElementById('adminUserSection');
const closeAdminSectionBtn = document.getElementById('closeAdminSectionBtn');
const cancelAdminBtn = document.getElementById('cancelAdminBtn');
const addAdminForm = document.getElementById('addAdminForm');
const saveAdminBtn = document.getElementById('saveAdminBtn');
const adminFormError = document.getElementById('adminFormError');

function toggleAdminSection(show) {
  const shouldShow = typeof show === 'boolean' ? show : (adminUserSection.style.display === 'none');
  adminUserSection.style.display = shouldShow ? 'block' : 'none';
  if (shouldShow) {
    adminFormError.textContent = '';
    document.getElementById('newAdminUsername').focus();
  }
}

if (toggleAdminBtn) {
  toggleAdminBtn.addEventListener('click', () => toggleAdminSection());
}
if (closeAdminSectionBtn) {
  closeAdminSectionBtn.addEventListener('click', () => toggleAdminSection(false));
}
if (cancelAdminBtn) {
  cancelAdminBtn.addEventListener('click', () => {
    addAdminForm.reset();
    toggleAdminSection(false);
  });
}

if (addAdminForm) {
  addAdminForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    adminFormError.textContent = '';
    saveAdminBtn.disabled = true;
    saveAdminBtn.textContent = 'Saving to Firebase...';

    const username = document.getElementById('newAdminUsername').value.trim();
    const email = document.getElementById('newAdminEmail').value.trim();
    const password = document.getElementById('newAdminPassword').value;

    try {
      const res = await authedFetch('/api/admin/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || 'Failed to create admin');
      }

      showToast(data.message || 'Admin added to Firebase!');
      addAdminForm.reset();
      toggleAdminSection(false);
    } catch (err) {
      adminFormError.textContent = err.message || 'Error creating admin';
    } finally {
      saveAdminBtn.disabled = false;
      saveAdminBtn.textContent = 'Save Admin to Firebase';
    }
  });
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
  } catch (err) {
    token = null;
    localStorage.removeItem('adminToken');
    window.location.href = '/admin-login.html';
    return;
  }

  adminWrap.style.display = 'block';
  await loadItems();
}

initializeDashboard();