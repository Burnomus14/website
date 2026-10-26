const token = localStorage.getItem('adminToken');
const statusMessage = document.getElementById('marketplaceStatusMessage');
const marketplaceWrap = document.getElementById('marketplaceWrap');
const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
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
  `).join('');
}

async function loadUsers() {
  const { users } = await api('/admin/users');
  const container = document.getElementById('usersList');
  if (!users || !users.length) {
    container.innerHTML = '<div class="marketplace-empty">No registered marketplace accounts yet.</div>';
    return;
  }
  container.innerHTML = users.map(user => `
    <article class="marketplace-record">
      <div>
        <h4>${escapeHtml(user.firstName || '')} ${escapeHtml(user.lastName || '')} · @${escapeHtml(user.username || 'unknown')}</h4>
        <p>${escapeHtml(user.email || 'No email')} · Roles: ${(user.roles || []).join(', ') || 'none'}</p>
        <div class="marketplace-role-controls">
          ${['customer', 'seller', 'shipper', 'admin'].map(role => `
            <label>
              <input type="checkbox" data-user-id="${escapeHtml(user.id)}" data-role="${role}" ${(user.roles || []).includes(role) ? 'checked' : ''} />
              ${role}
            </label>
          `).join('')}
        </div>
      </div>
    </article>
  `).join('');
}

async function loadShippers() {
  const { shippers } = await api('/admin/shippers');
  const container = document.getElementById('shippersList');
  if (!shippers || !shippers.length) {
    container.innerHTML = '<div class="marketplace-empty">No shippers registered. Assign the shipper role to a user above to add them here.</div>';
    return;
  }
  container.innerHTML = shippers.map(shipper => `
    <article class="marketplace-record">
      <div>
        <h4>${escapeHtml(shipper.user?.firstName || '')} ${escapeHtml(shipper.user?.lastName || '')} · @${escapeHtml(shipper.user?.username || 'shipper')}</h4>
        <p>${escapeHtml(shipper.area || 'No assigned area')} · ${escapeHtml(shipper.company || 'No company')} · ${escapeHtml(shipper.phone || 'No phone')}</p>
      </div>
      <div class="marketplace-record-actions">
        <input class="marketplace-select" placeholder="Area / county" value="${escapeHtml(shipper.area || '')}" data-shipper-area="${escapeHtml(shipper.userId)}" />
        <input class="marketplace-select" placeholder="Company" value="${escapeHtml(shipper.company || '')}" data-shipper-company="${escapeHtml(shipper.userId)}" />
        <input class="marketplace-select" placeholder="Phone" value="${escapeHtml(shipper.phone || '')}" data-shipper-phone="${escapeHtml(shipper.userId)}" />
        <button class="btn ghost" type="button" data-action="shipper-save" data-id="${escapeHtml(shipper.userId)}">Save</button>
      </div>
    </article>
  `).join('');
}

async function loadCategories() {
  const { categories } = await api('/categories');
  const container = document.getElementById('categoriesList');
  if (!categories || !categories.length) {
    container.innerHTML = '<div class="marketplace-empty">No custom categories yet. Add one above.</div>';
    return;
  }
  container.innerHTML = categories.map(cat => `
    <article class="marketplace-record">
      <div>
        <h4>${escapeHtml(cat.name)}</h4>
        <p>${escapeHtml(cat.description || 'No description')}</p>
      </div>
      <div class="marketplace-record-actions">
        <button class="btn danger" type="button" data-action="category-delete" data-id="${escapeHtml(cat.id)}">Delete</button>
      </div>
    </article>
  `).join('');
}

async function loadMarketplaceOrders() {
  const { orders } = await api('/orders');
  const container = document.getElementById('marketplaceOrdersList');
  if (!orders || !orders.length) {
    container.innerHTML = '<div class="marketplace-empty">No marketplace orders placed yet.</div>';
    return;
  }
  container.innerHTML = orders.map(order => `
    <article class="marketplace-record marketplace-order">
      <div class="marketplace-record-main">
        <div>
          <h4>Order ${escapeHtml(order.id.slice(0, 10))} · KSh ${Number(order.totalPrice || 0).toLocaleString()}</h4>
          <p>${new Date(order.createdAt).toLocaleString()} · Status: <strong>${escapeHtml(order.status)}</strong> · Payment: ${escapeHtml(order.paymentStatus || 'unknown')}</p>
          <p>Customer: ${escapeHtml(order.address?.recipient || order.customerName || 'Customer')} · Phone: ${escapeHtml(order.phoneNumber || order.address?.phone || '—')}</p>
          <p>Address: ${escapeHtml(order.address ? `${order.address.street}, ${order.address.city}, ${order.address.state}` : 'No delivery address recorded')}</p>
          <div class="marketplace-order-lines">
            ${(order.items || []).map(item => `
              <div class="marketplace-order-line">
                <p><strong>${escapeHtml(item.name)}</strong> · Qty ${Number(item.quantity)} · Status: ${escapeHtml(item.status)}</p>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      <span class="marketplace-status">${escapeHtml(order.status)}</span>
    </article>
  `).join('');
}

async function loadAllMarketplaceData() {
  if (!token) {
    window.location.href = '/admin-login.html';
    return;
  }

  statusMessage.hidden = false;
  statusMessage.textContent = 'Loading marketplace data...';
  marketplaceWrap.hidden = true;

  try {
    await Promise.all([
      loadStats(),
      loadUsers(),
      loadShippers(),
      loadCategories(),
      loadMarketplaceOrders()
    ]);
    statusMessage.hidden = true;
    marketplaceWrap.hidden = false;
  } catch (err) {
    statusMessage.textContent = err.message || 'Error loading marketplace data.';
  }
}

// User role checkbox handling
document.getElementById('usersList').addEventListener('change', async (event) => {
  if (event.target.type !== 'checkbox') return;
  const userId = event.target.dataset.userId;
  const role = event.target.dataset.role;
  const granted = event.target.checked;
  try {
    await api(`/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, granted })
    });
    showToast(`Role ${role} ${granted ? 'granted' : 'revoked'}.`);
    await Promise.all([loadUsers(), loadShippers(), loadStats()]);
  } catch (err) {
    event.target.checked = !granted;
    showToast(err.message);
  }
});

// Shipper saving
document.getElementById('shippersList').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-action="shipper-save"]');
  if (!btn) return;
  const id = btn.dataset.id;
  const area = document.querySelector(`[data-shipper-area="${id}"]`)?.value?.trim() || '';
  const company = document.querySelector(`[data-shipper-company="${id}"]`)?.value?.trim() || '';
  const phone = document.querySelector(`[data-shipper-phone="${id}"]`)?.value?.trim() || '';
  try {
    await api(`/admin/shippers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ area, company, phone })
    });
    showToast('Shipper profile updated.');
    await loadShippers();
  } catch (err) {
    showToast(err.message);
  }
});

// Category form
document.getElementById('categoryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim();
  const description = form.elements.description.value.trim();
  const msgEl = document.getElementById('categoryMessage');
  msgEl.textContent = '';
  try {
    await api('/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });
    form.reset();
    showToast('Category created.');
    await loadCategories();
  } catch (err) {
    msgEl.textContent = err.message;
  }
});

// Category delete
document.getElementById('categoriesList').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-action="category-delete"]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm('Are you sure you want to delete this category?')) return;
  try {
    await api(`/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Category deleted.');
    await loadCategories();
  } catch (err) {
    showToast(err.message);
  }
});

document.getElementById('refreshMarketplaceBtn').addEventListener('click', loadAllMarketplaceData);

document.getElementById('signOutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', headers: { 'x-admin-token': token || '' } });
  } catch {}
  localStorage.removeItem('adminToken');
  window.location.href = '/admin-login.html';
});

loadAllMarketplaceData();

