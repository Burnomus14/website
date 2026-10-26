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
let marketplaceUser = null;
let registrationMode = false;
let adminSessionMode = false;
let savedAddresses = [];
let currentAccountCart = [];
let sellerProducts = [];

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
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const error = new Error(data.message || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showMessage(element, message, isError = false) {
  if (!element) return;
  element.textContent = message || '';
  element.classList.toggle('is-error', isError);
}

function getSignInErrorMessage(error) {
  if (error.code === 'auth/invalid-credential' || error.code === 'auth/user-not-found' ||
      error.code === 'auth/wrong-password') {
    return 'Email or password is incorrect. If this is an older account, use “Forgot password?” to set a Firebase password.';
  }
  if (error.code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (error.code === 'auth/too-many-requests') return 'Too many sign-in attempts. Wait a while and try again.';
  return error.message || 'Unable to sign in. Please try again.';
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2600);
}

function setAuthMode(register) {
  registrationMode = register;
  document.getElementById('registerFields').hidden = !register;
  document.getElementById('authHeading').textContent = register ? 'Join the collection.' : 'Sign in to your account.';
  document.getElementById('identifierLabel').textContent = 'Email';
  document.querySelector('#authForm [name="identifier"]').type = 'email';
  document.querySelector('#authForm [name="identifier"]').autocomplete = 'email';
  document.querySelector('#authForm [name="password"]').autocomplete = register ? 'new-password' : 'current-password';
  document.querySelector('#authForm [name="password"]').minLength = register ? 10 : 1;
  document.getElementById('authSubmit').textContent = register ? 'Create account' : 'Sign in';
  document.getElementById('switchAuthMode').textContent = register ? 'Already a member? Sign in' : 'Create an account';
  showMessage(authMessage, '');
}

function setActivePanel(panelId) {
  document.querySelectorAll('.marketplace-content-panel').forEach(panel => {
    panel.hidden = panel.id !== panelId;
  });
  document.querySelectorAll('.marketplace-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.panel === panelId);
  });
}

function renderAccount() {
  authPanel.hidden = true;
  accountPanel.hidden = false;
  const roles = marketplaceUser.roles || [];
  document.getElementById('welcomeName').textContent = `Hello, ${marketplaceUser.firstName || marketplaceUser.username || 'admin'}`;
  document.getElementById('accountEmail').textContent = marketplaceUser.email || '';
  document.getElementById('roleLabel').textContent = adminSessionMode ? 'ADMIN SESSION' : roles.join(' / ').toUpperCase();
  document.querySelectorAll('[data-role-tab]').forEach(tab => {
    tab.hidden = tab.dataset.roleTab === 'seller'
      ? !roles.includes('seller') && !roles.includes('customer') && !roles.includes('admin')
      : !roles.includes(tab.dataset.roleTab);
  });
  const sellerToolsVisible = roles.includes('seller') || roles.includes('admin');
  document.getElementById('productForm').hidden = !sellerToolsVisible;
  document.getElementById('sellerProductsList').hidden = !sellerToolsVisible;
  document.getElementById('sellerOrdersList').previousElementSibling.hidden = !sellerToolsVisible;
  document.getElementById('sellerOrdersList').hidden = !sellerToolsVisible;
  document.querySelector('[data-panel="profilePanel"]').hidden = adminSessionMode;
  if (!adminSessionMode) {
    const form = document.getElementById('profileForm');
    form.elements.firstName.value = marketplaceUser.firstName || '';
    form.elements.lastName.value = marketplaceUser.lastName || '';
    form.elements.username.value = marketplaceUser.username || '';
    form.elements.email.value = marketplaceUser.email || '';
  }
  document.getElementById('sellerApplyForm').hidden =
    adminSessionMode || roles.includes('seller') || !roles.includes('customer');
  if (marketplaceUser.sellerApplication?.status === 'pending') {
    document.getElementById('sellerApplyMessage').textContent = 'Your seller application is awaiting admin review.';
    document.getElementById('sellerApplyForm').hidden = false;
    document.querySelector('#sellerApplyForm button').disabled = true;
  }
  setActivePanel('ordersPanel');
  loadAccountData().catch(error => showToast(error.message));
}

async function loadAccountData() {
  await Promise.all([
    loadOrders(),
    loadCart(),
    loadWishlist(),
    loadAddresses()
  ]);
  const roles = marketplaceUser.roles || [];
  if (roles.includes('seller') || roles.includes('admin')) {
    await Promise.all([loadSellerProducts(), loadCategories()]);
  }
  if (roles.includes('admin')) {
    await Promise.all([loadAdminUsers(), loadShippers(), loadCategories(), loadStats()]);
  }
}

async function loadOrders() {
  const { orders } = await api('/orders');
  const container = document.getElementById('ordersList');
  const updates = [];
  for (const order of orders) {
    for (const item of order.items) {
      if (marketplaceUser.roles.includes('customer') && order.userId === marketplaceUser.id && item.status !== 'delivered') {
        updates.push({ title: `${item.name}: ${item.status}`, details: `Order ${order.id.slice(0, 10)} · ${new Date(order.createdAt).toLocaleDateString()}` });
      } else if (marketplaceUser.roles.includes('seller') && item.sellerId === marketplaceUser.id && item.status === 'pending') {
        updates.push({ title: `New order for ${item.name}`, details: `Order ${order.id.slice(0, 10)} · Qty ${item.quantity}` });
      } else if (marketplaceUser.roles.includes('shipper') && item.status === 'shipped') {
        updates.push({ title: `Delivery assigned: ${item.name}`, details: `${order.address?.city || ''} · Order ${order.id.slice(0, 10)}` });
      }
    }
  }
  document.getElementById('updatesList').innerHTML = updates.length
    ? updates.map(update => `<article class="marketplace-record"><div><h4>${escapeHtml(update.title)}</h4><p>${escapeHtml(update.details)}</p></div><span class="marketplace-status">Update</span></article>`).join('')
    : '<div class="marketplace-empty">You are all caught up.</div>';
  if (!orders.length) {
    container.innerHTML = '<div class="marketplace-empty">No orders to show yet. Your paid M-Pesa orders will appear here.</div>';
    if (marketplaceUser.roles.includes('seller') || marketplaceUser.roles.includes('admin')) {
      document.getElementById('sellerOrdersList').innerHTML = container.innerHTML;
    }
    if (marketplaceUser.roles.includes('shipper') || marketplaceUser.roles.includes('admin')) {
      document.getElementById('shipperOrdersList').innerHTML = container.innerHTML;
    }
    return;
  }
  container.innerHTML = orders.map(order => `
    <article class="marketplace-record marketplace-order">
      <div class="marketplace-record-main">
        <div>
          <h4>Order ${escapeHtml(order.id.slice(0, 10))} · KSh ${Number(order.totalPrice || 0).toLocaleString()}</h4>
          <p>${new Date(order.createdAt).toLocaleString()} · ${escapeHtml(order.status)} · ${escapeHtml(order.paymentStatus)}</p>
          <p>To ${escapeHtml(order.address?.recipient || order.customerName)} · ${escapeHtml(order.phoneNumber || order.address?.phone || '')}</p>
          <p>${escapeHtml(order.address ? `${order.address.street}, ${order.address.city}, ${order.address.state}` : 'No delivery address supplied')}</p>
          <div class="marketplace-order-lines">${order.items.map(item => `
            <div class="marketplace-order-line">
              <p><strong>${escapeHtml(item.name)}</strong> · Qty ${Number(item.quantity)} · ${escapeHtml(item.status)}</p>
              ${adminSessionMode || marketplaceUser.roles.includes('admin') || marketplaceUser.roles.includes('seller') && item.sellerId === marketplaceUser.id
                ? `<div class="marketplace-record-actions">
                    ${item.status === 'pending' && (marketplaceUser.roles.includes('seller') || marketplaceUser.roles.includes('admin'))
                      ? `<button class="btn ghost" type="button" data-action="ship" data-order-id="${escapeHtml(order.id)}" data-item-id="${escapeHtml(item.id)}">Mark shipped</button>` : ''}
                    ${item.status === 'shipped' && (marketplaceUser.roles.includes('shipper') || marketplaceUser.roles.includes('admin'))
                      ? `<button class="btn ghost" type="button" data-action="deliver" data-order-id="${escapeHtml(order.id)}" data-item-id="${escapeHtml(item.id)}">Mark delivered</button>` : ''}
                  </div>` : ''}
            </div>`).join('')}</div>
        </div>
      </div>
      <span class="marketplace-status">${escapeHtml(order.status)}</span>
    </article>`).join('');
  const sellerOrders = document.getElementById('sellerOrdersList');
  const shipperOrders = document.getElementById('shipperOrdersList');
  if (sellerOrders && (marketplaceUser.roles.includes('seller') || marketplaceUser.roles.includes('admin'))) {
    sellerOrders.innerHTML = container.innerHTML;
  }
  if (shipperOrders && (marketplaceUser.roles.includes('shipper') || marketplaceUser.roles.includes('admin'))) {
    shipperOrders.innerHTML = container.innerHTML;
  }
}

async function loadCart() {
  const { cart } = await api('/cart');
  currentAccountCart = cart.items || [];
  const container = document.getElementById('accountCartList');
  if (!currentAccountCart.length) {
    container.innerHTML = '<div class="marketplace-empty">Your signed-in basket is empty. Add a piece from the archive.</div>';
    return;
  }
  container.innerHTML = currentAccountCart.map(({ product, quantity }) => `
    <article class="marketplace-record">
      <div class="marketplace-record-main">${product.image ? `<img src="${escapeHtml(product.image)}" alt="" />` : ''}
        <div><h4><a class="marketplace-card-link" href="/">${escapeHtml(product.name)}</a></h4>
        <p>${escapeHtml(product.price)} · ${Number(product.quantity)} available</p></div>
      </div>
      <div class="marketplace-record-actions">
        <button class="btn ghost" type="button" data-action="cart-quantity" data-id="${escapeHtml(product.id)}" data-quantity="${Math.max(1, quantity - 1)}">−</button>
        <span>${quantity}</span>
        <button class="btn ghost" type="button" data-action="cart-quantity" data-id="${escapeHtml(product.id)}" data-quantity="${Math.min(product.quantity, quantity + 1)}" ${quantity >= product.quantity ? 'disabled' : ''}>+</button>
        <button class="btn ghost" type="button" data-action="cart-remove" data-id="${escapeHtml(product.id)}">Remove</button>
      </div>
    </article>`).join('');
}

async function loadWishlist() {
  const { wishlist } = await api('/wishlist');
  const container = document.getElementById('wishlistList');
  if (!wishlist.length) {
    container.innerHTML = '<div class="marketplace-empty">No saved pieces yet. Save a product from the archive to keep it here.</div>';
    return;
  }
  container.innerHTML = wishlist.map(product => `
    <article class="marketplace-record">
      <div class="marketplace-record-main">${product.image ? `<img src="${escapeHtml(product.image)}" alt="" />` : ''}
        <div><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.price || '')} · ${escapeHtml(product.category)}</p></div>
      </div>
      <div class="marketplace-record-actions">
        <a class="btn ghost" href="/">View archive</a>
        <button class="btn ghost" type="button" data-action="wishlist-remove" data-id="${escapeHtml(product.id)}">Remove</button>
      </div>
    </article>`).join('');
}

async function loadAddresses() {
  const { addresses } = await api('/addresses');
  savedAddresses = addresses;
  const container = document.getElementById('addressesList');
  if (!addresses.length) {
    container.innerHTML = '<div class="marketplace-empty">No delivery addresses saved.</div>';
    return;
  }
  container.innerHTML = addresses.map(address => `
    <article class="marketplace-record">
      <div><h4>${escapeHtml(address.recipient)} · ${escapeHtml(address.phone)}</h4>
        <p>${escapeHtml([address.street, address.addressLine, address.city, address.state, address.country].filter(Boolean).join(', '))}</p></div>
      <div class="marketplace-record-actions">
        <button class="btn ghost" type="button" data-action="address-edit" data-id="${escapeHtml(address.id)}">Edit</button>
        <button class="btn ghost" type="button" data-action="address-delete" data-id="${escapeHtml(address.id)}">Delete</button>
      </div>
    </article>`).join('');
}

async function loadSellerProducts() {
  const { products } = await api('/products');
  sellerProducts = products;
  const container = document.getElementById('sellerProductsList');
  if (!products.length) {
    container.innerHTML = '<div class="marketplace-empty">No products listed yet.</div>';
    return;
  }
  container.innerHTML = products.map(product => `
    <article class="marketplace-record">
      <div class="marketplace-record-main">${product.image ? `<img src="${escapeHtml(product.image)}" alt="" />` : ''}
        <div><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.category)} · ${escapeHtml(product.price)} · ${product.quantity} in stock</p></div>
      </div>
      <div class="marketplace-record-actions">
        <button class="btn ghost" type="button" data-action="product-edit" data-id="${escapeHtml(product.id)}">Edit</button>
        <button class="btn ghost" type="button" data-action="product-delete" data-id="${escapeHtml(product.id)}">Delete</button>
      </div>
    </article>`).join('');
}

async function loadCategories() {
  const { categories } = await api('/categories');
  const datalist = document.getElementById('marketplaceCategories');
  if (datalist) datalist.innerHTML = categories.map(category => `<option value="${escapeHtml(category.name)}"></option>`).join('');
  const adminList = document.getElementById('categoriesList');
  if (adminList) adminList.innerHTML = categories.map(category => {
    return `<article class="marketplace-record">
      <div><h4>${escapeHtml(category.name)}</h4><p>${escapeHtml(category.description || '')}</p></div>
      <div class="marketplace-record-actions">
        <button class="btn ghost" type="button" data-action="category-edit" data-id="${escapeHtml(category.id)}" data-name="${escapeHtml(category.name)}" data-description="${escapeHtml(category.description || '')}">Edit</button>
        <button class="btn ghost" type="button" data-action="category-delete" data-id="${escapeHtml(category.id)}">Delete</button>
      </div>
    </article>`;
  }).join('') || '<div class="marketplace-empty">Categories are inferred from the existing archive. Add one to create a new product category.</div>';
}

async function loadAdminUsers() {
  const { users } = await api('/admin/users');
  document.getElementById('usersList').innerHTML = users.map(user => `
    <article class="marketplace-record marketplace-admin-user">
      <div class="marketplace-record-main"><div>
        <h4>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)} · @${escapeHtml(user.username)}</h4>
        <p>${escapeHtml(user.email)} · ${user.isRestricted ? 'Restricted' : 'Active'}${user.sellerApplication ? ` · Seller application: ${escapeHtml(user.sellerApplication.status)}` : ''}</p>
        <div class="marketplace-role-controls">${['seller', 'shipper', 'admin'].map(role => `
          <label><input type="checkbox" data-role="${role}" data-user-id="${escapeHtml(user.id)}" ${user.roles.includes(role) ? 'checked' : ''} /> ${role}</label>`).join('')}</div>
      </div></div>
      <div class="marketplace-record-actions">
        <button class="btn ghost" type="button" data-action="roles-save" data-id="${escapeHtml(user.id)}">Save roles</button>
        <button class="btn ghost" type="button" data-action="user-restrict" data-id="${escapeHtml(user.id)}" data-restricted="${!user.isRestricted}">${user.isRestricted ? 'Unrestrict' : 'Restrict'}</button>
      </div>
    </article>`).join('') || '<div class="marketplace-empty">No registered accounts yet.</div>';
}

async function loadShippers() {
  const { shippers } = await api('/admin/shippers');
  document.getElementById('shippersList').innerHTML = shippers.map(shipper => `
    <article class="marketplace-record">
      <div><h4>${escapeHtml(shipper.user?.firstName)} ${escapeHtml(shipper.user?.lastName)} · @${escapeHtml(shipper.user?.username)}</h4>
        <p>${escapeHtml(shipper.area || 'No area')} · ${escapeHtml(shipper.company || 'No company')} · ${escapeHtml(shipper.phone || 'No phone')}</p></div>
      <div class="marketplace-record-actions">
        <input class="marketplace-select" aria-label="Delivery area" placeholder="Area / county" value="${escapeHtml(shipper.area || '')}" data-shipper-area="${escapeHtml(shipper.userId)}" />
        <input class="marketplace-select" aria-label="Company" placeholder="Company" value="${escapeHtml(shipper.company || '')}" data-shipper-company="${escapeHtml(shipper.userId)}" />
        <input class="marketplace-select" aria-label="Phone" placeholder="Phone" value="${escapeHtml(shipper.phone || '')}" data-shipper-phone="${escapeHtml(shipper.userId)}" />
        <button class="btn ghost" type="button" data-action="shipper-save" data-id="${escapeHtml(shipper.userId)}">Save</button>
      </div>
    </article>`).join('') || '<div class="marketplace-empty">Grant the shipper role to an account, then assign its delivery area here.</div>';
}

async function loadStats() {
  const { stats } = await api('/admin/overview');
  document.getElementById('marketplaceStats').innerHTML = Object.entries(stats).map(([key, value]) => `
    <div class="marketplace-stat"><strong>${Number(value).toLocaleString()}</strong><span>${escapeHtml(key.replace(/[A-Z]/g, letter => ` ${letter}`).trim())}</span></div>`).join('');
}

function resetAddressForm() {
  const form = document.getElementById('addressForm');
  form.reset();
  form.elements.id.value = '';
  document.getElementById('cancelAddressEdit').hidden = true;
}

function setProductForm(product) {
  const form = document.getElementById('productForm');
  form.elements.id.value = product?.id || '';
  for (const key of ['name', 'category', 'caption', 'quantity']) {
    form.elements[key].value = product?.[key] ?? (key === 'quantity' ? 1 : '');
  }
  form.elements.price.value = product ? Number(String(product.price).replace(/[^\d.]/g, '')) : '';
  document.getElementById('cancelProductEdit').hidden = !product;
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const values = Object.fromEntries(formData.entries());
  try {
    if (registrationMode) {
      if (auth.currentUser && localStorage.getItem(pendingRegistrationKey)) {
        localStorage.setItem(pendingRegistrationKey, JSON.stringify({
          firstName: values.firstName,
          lastName: values.lastName,
          username: values.username
        }));
        if (await finishVerifiedRegistration(auth.currentUser)) return;
        await sendEmailVerification(auth.currentUser, verificationActionSettings);
        showMessage(authMessage, 'Check your email and confirm your address to finish creating your account.');
        return;
      }
      const credential = await createUserWithEmailAndPassword(auth, values.identifier.trim(), values.password);
      const profile = {
        firstName: values.firstName,
        lastName: values.lastName,
        username: values.username
      };
      localStorage.setItem(pendingRegistrationKey, JSON.stringify(profile));
      await updateProfile(credential.user, { displayName: `${profile.firstName} ${profile.lastName}`.trim() });
      await sendEmailVerification(credential.user, verificationActionSettings);
      showMessage(authMessage, 'Account created. Check your email and confirm your address to continue.');
      return;
    }

    const credential = await signInWithEmailAndPassword(auth, values.identifier.trim(), values.password);
    const credential = await signInWithEmailAndPassword(auth, values.identifier, values.password);
    await reload(credential.user);
    if (!credential.user.emailVerified) {
      await sendEmailVerification(credential.user, verificationActionSettings);
      showMessage(authMessage, 'Confirm your email using the link we sent before signing in.');
      return;
    }
    if (await finishVerifiedRegistration(credential.user)) return;
    await completePendingRegistration();
    const result = await api('/auth/me');
    marketplaceUser = result.user;
    adminSessionMode = false;
    renderAccount();
  } catch (error) {
    showMessage(authMessage, registrationMode ? error.message : getSignInErrorMessage(error), true);
  }
}

const verificationActionSettings = {
  url: `${window.location.origin}/account.html`
};

async function finishVerifiedRegistration(user) {
  if (!localStorage.getItem(pendingRegistrationKey)) return false;
  await reload(user);
  if (!user.emailVerified) return false;
  await completePendingRegistration();
  sessionStorage.setItem(verifiedAccountEmailKey, user.email || '');
  await firebaseSignOut(auth);
  document.getElementById('accountCreatedDialog').showModal();
  return true;
}

async function completePendingRegistration() {
  const pending = localStorage.getItem(pendingRegistrationKey);
  if (!pending) return;
  const profile = JSON.parse(pending);
  const result = await api('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile)
  });
  localStorage.removeItem(pendingRegistrationKey);
  marketplaceUser = result.user;
  return true;
}

async function handleAddressSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const id = payload.id;
  delete payload.id;
  try {
    await api(id ? `/addresses/${encodeURIComponent(id)}` : '/addresses', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    showMessage(document.getElementById('addressMessage'), 'Address saved.');
    resetAddressForm();
    await loadAddresses();
  } catch (error) {
    showMessage(document.getElementById('addressMessage'), error.message, true);
  }
}

async function handleProfileSubmit(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  delete payload.email;
  try {
    const result = await api('/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    marketplaceUser = result.user;
    document.getElementById('welcomeName').textContent = `Hello, ${marketplaceUser.firstName}`;
    showMessage(document.getElementById('profileMessage'), 'Account information saved.');
  } catch (error) {
    showMessage(document.getElementById('profileMessage'), error.message, true);
  }
}

async function handleProductSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const id = formData.get('id');
  formData.delete('id');
  try {
    const response = await fetch(`/api/marketplace/products${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: id ? 'PATCH' : 'POST',
      headers: getAuthHeaders(),
      body: formData
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Could not save product.');
    showMessage(document.getElementById('productMessage'), 'Product saved.');
    form.reset();
    setProductForm(null);
    await Promise.all([loadSellerProducts(), loadCategories()]);
  } catch (error) {
    showMessage(document.getElementById('productMessage'), error.message, true);
  }
}

async function handleSellerApplication(event) {
  event.preventDefault();
  try {
    await api('/seller/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: new FormData(event.currentTarget).get('note') })
    });
    marketplaceUser.sellerApplication = { status: 'pending' };
    document.querySelector('#sellerApplyForm button').disabled = true;
    showMessage(document.getElementById('sellerApplyMessage'), 'Application submitted for admin review.');
  } catch (error) {
    showMessage(document.getElementById('sellerApplyMessage'), error.message, true);
  }
}

async function handleCategorySubmit(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api('/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    event.currentTarget.reset();
    showMessage(document.getElementById('categoryMessage'), 'Category added.');
    await loadCategories();
  } catch (error) {
    showMessage(document.getElementById('categoryMessage'), error.message, true);
  }
}

async function handleRecordAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  try {
    switch (button.dataset.action) {
      case 'cart-quantity': {
        const item = currentAccountCart.find(line => String(line.product.id) === id);
        if (!item) return;
        if (Number(button.dataset.quantity) < 1) {
          currentAccountCart = currentAccountCart.filter(line => String(line.product.id) !== id);
        } else {
          item.quantity = Number(button.dataset.quantity);
        }
        await api('/cart', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: currentAccountCart.map(line => ({ productId: line.product.id, quantity: line.quantity })) }) });
        await loadCart();
        break;
      }
      case 'cart-remove':
        await api(`/cart/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadCart();
        break;
      case 'wishlist-remove':
        await api(`/wishlist/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadWishlist();
        break;
      case 'address-edit': {
        const address = savedAddresses.find(record => record.id === id);
        if (!address) return;
        const form = document.getElementById('addressForm');
        form.elements.id.value = address.id;
        for (const key of ['recipient', 'phone', 'state', 'city', 'street', 'addressLine']) form.elements[key].value = address[key] || '';
        document.getElementById('cancelAddressEdit').hidden = false;
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
      case 'address-delete':
        if (!confirm('Delete this delivery address?')) return;
        await api(`/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadAddresses();
        break;
      case 'product-edit':
        setProductForm(sellerProducts.find(product => product.id === id));
        break;
      case 'product-delete':
        if (!confirm('Delete this product from the archive?')) return;
        await api(`/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadSellerProducts();
        break;
      case 'roles-save': {
        const checks = [...document.querySelectorAll(`[data-user-id="${CSS.escape(id)}"][data-role]`)];
        const roles = ['customer', ...checks.filter(check => check.checked).map(check => check.dataset.role)];
        await api(`/admin/users/${encodeURIComponent(id)}/roles`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles }) });
        await Promise.all([loadAdminUsers(), loadShippers()]);
        showToast('Account roles updated.');
        break;
      }
      case 'user-restrict':
        await api(`/admin/users/${encodeURIComponent(id)}/restrict`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restricted: button.dataset.restricted === 'true' })
        });
        await loadAdminUsers();
        break;
      case 'shipper-save': {
        const area = document.querySelector(`[data-shipper-area="${CSS.escape(id)}"]`).value;
        const company = document.querySelector(`[data-shipper-company="${CSS.escape(id)}"]`).value;
        const phone = document.querySelector(`[data-shipper-phone="${CSS.escape(id)}"]`).value;
        await api(`/admin/shippers/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ area, company, phone }) });
        await loadShippers();
        showToast('Shipper information saved.');
        break;
      }
      case 'category-edit': {
        const name = prompt('Category name', button.dataset.name);
        if (name === null) return;
        const description = prompt('Category description', button.dataset.description || '');
        if (description === null) return;
        await api(`/categories/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description })
        });
        await loadCategories();
        break;
      }
      case 'category-delete':
        if (!confirm('Delete this category? Categories currently used by products cannot be removed.')) return;
        await api(`/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadCategories();
        break;
      case 'ship':
        await api(`/orders/${encodeURIComponent(button.dataset.orderId)}/items/${encodeURIComponent(button.dataset.itemId)}/ship`, { method: 'PATCH' });
        await loadOrders();
        break;
      case 'deliver':
        await api(`/orders/${encodeURIComponent(button.dataset.orderId)}/items/${encodeURIComponent(button.dataset.itemId)}/deliver`, { method: 'PATCH' });
        await loadOrders();
        break;
      default:
        break;
    }
  } catch (error) {
    showToast(error.message);
  }
}

async function signOut() {
  if (adminSessionMode) {
    const adminToken = localStorage.getItem('adminToken');
    await fetch('/api/logout', { method: 'POST', headers: { 'x-admin-token': adminToken } });
    localStorage.removeItem('adminToken');
    await firebaseSignOut(auth);
  } else {
    await firebaseSignOut(auth);
  }
  location.reload();
}

authForm.addEventListener('submit', handleAuthSubmit);
document.getElementById('switchAuthMode').addEventListener('click', () => setAuthMode(!registrationMode));
document.getElementById('signOutButton').addEventListener('click', signOut);
document.querySelectorAll('.marketplace-tab').forEach(tab => tab.addEventListener('click', () => {
  setActivePanel(tab.dataset.panel);
  if (tab.dataset.panel === 'ordersPanel') loadOrders().catch(error => showToast(error.message));
}));
accountPanel.addEventListener('click', handleRecordAction);
document.querySelectorAll('[data-refresh="orders"]').forEach(button => button.addEventListener('click', () => loadOrders().catch(error => showToast(error.message))));
document.getElementById('addressForm').addEventListener('submit', handleAddressSubmit);
document.getElementById('profileForm').addEventListener('submit', handleProfileSubmit);
document.getElementById('cancelAddressEdit').addEventListener('click', resetAddressForm);
document.getElementById('productForm').addEventListener('submit', handleProductSubmit);
document.getElementById('cancelProductEdit').addEventListener('click', () => setProductForm(null));
document.getElementById('sellerApplyForm').addEventListener('submit', handleSellerApplication);
document.getElementById('categoryForm').addEventListener('submit', handleCategorySubmit);
document.getElementById('accountCreatedContinue').addEventListener('click', () => {
  document.getElementById('accountCreatedDialog').close();
  window.location.assign('/account.html?auth=signin');
});

async function initializeAccount() {
  const adminToken = localStorage.getItem('adminToken');
  await auth.authStateReady();
  const currentUser = adminToken ? null : auth.currentUser;
  const verifiedEmail = sessionStorage.getItem(verifiedAccountEmailKey);
  if (verifiedEmail) {
    document.querySelector('#authForm [name="identifier"]').value = verifiedEmail;
    sessionStorage.removeItem(verifiedAccountEmailKey);
  }
  if (!currentUser && !adminToken) return;
  try {
    if (currentUser) {
      if (await finishVerifiedRegistration(currentUser)) return;
      if (localStorage.getItem(pendingRegistrationKey)) {
        authPanel.hidden = false;
        accountPanel.hidden = true;
        showMessage(authMessage, 'Account created. Confirm your email using the link we sent to continue.');
        return;
      }
    }
    const result = await api('/auth/me');
    marketplaceUser = result.user;
    adminSessionMode = !currentUser && Boolean(adminToken);
    renderAccount();
  } catch (error) {
    if (error.status === 401 && adminToken) localStorage.removeItem('adminToken');
    authPanel.hidden = false;
    accountPanel.hidden = true;
    showMessage(authMessage, error.status === 401 && adminToken
      ? 'Your session expired. Sign in to continue.'
      : error.message, true);
  }
}

setAuthMode(false);
initializeAccount();
