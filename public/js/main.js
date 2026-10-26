const galleryEl = document.getElementById('gallery');
const filterBtns = document.querySelectorAll('.filter-btn');
const viewToggleBtns = document.querySelectorAll('.view-toggle-btn');
const columnsPerRowSelect = document.getElementById('columns-per-row');
const searchInput = document.getElementById('search-input');
const clearSearch = document.getElementById('clear-search');
const searchResultPopup = document.getElementById('search-result-popup');
let sellerPhoneNumber = '254728074301';

let allItems = [];
let activeFilter = 'all';
let searchQuery = '';
let sortOrder = 'newest';
let collectionView = localStorage.getItem('collection_view') === 'compact' ? 'compact' : 'cards';
const savedColumnsPerRow = localStorage.getItem('cards_per_row');
let cardsPerRow = ['2', '3', '4', '5', '6'].includes(savedColumnsPerRow) ? Number(savedColumnsPerRow) : 3;
let cart = JSON.parse(localStorage.getItem('shoe_cart') || '[]');
let marketplaceAddresses = [];
let activeProduct = null;
let lastFocusedElement = null;
let activeGalleryImages = [];
let activeGalleryIndex = 0;

function setCollectionView(view) {
  collectionView = view === 'compact' ? 'compact' : 'cards';
  galleryEl.classList.toggle('compact-view', collectionView === 'compact');
  document.getElementById('filters').classList.toggle('compact-view-active', collectionView === 'compact');
  viewToggleBtns.forEach(button => {
    const isActive = button.dataset.view === collectionView;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
  localStorage.setItem('collection_view', collectionView);
}

function setCardsPerRow(columns) {
  cardsPerRow = Number(columns);
  galleryEl.style.setProperty('--gallery-columns', cardsPerRow);
  galleryEl.classList.toggle('dense-cards', cardsPerRow > 1);
  columnsPerRowSelect.value = String(cardsPerRow);
  localStorage.setItem('cards_per_row', String(cardsPerRow));
}

setCollectionView(collectionView);
setCardsPerRow(cardsPerRow);
viewToggleBtns.forEach(button => {
  button.addEventListener('click', () => {
    setCollectionView(button.dataset.view);
    render();
  });
});
columnsPerRowSelect.addEventListener('change', () => {
  setCardsPerRow(columnsPerRowSelect.value);
  render();
});

async function loadItems() {
  try {
    const [itemsRes, configRes, categoriesRes] = await Promise.all([
      fetch('/api/items'),
      fetch('/api/config'),
      fetch('/api/marketplace/categories')
    ]);
    if (!itemsRes.ok || !configRes.ok || !categoriesRes.ok) {
      throw new Error('The collection could not be loaded. Please try again.');
    }
    allItems = await itemsRes.json();
    const config = await configRes.json();
    const categoryData = await categoriesRes.json();
    sellerPhoneNumber = config.sellerPhone || sellerPhoneNumber;
    addCategoryFilters(categoryData.categories || []);
    await loadSignedInCart().catch(error => showToast(error.message));
    reconcileCartWithStock();
    render();
  } catch {
    galleryEl.innerHTML = `<div class="empty-state"><h2>Couldn't load the collection</h2><p>Make sure the server is running, then refresh.</p></div>`;
  }
}

function addCategoryFilters(categories) {
  const container = document.getElementById('filters');
  const existing = new Set(['shoes', 'clothes', 'full outfit']);
  container.querySelectorAll('[data-category-value]').forEach(button => existing.add(button.dataset.categoryValue));
  const stockFilter = container.querySelector('[data-filter="in-stock"]');
  categories.forEach(category => {
    if (!category.name || existing.has(category.name)) return;
    const button = document.createElement('button');
    button.className = 'filter-btn';
    button.dataset.filter = `category:${category.name}`;
    button.dataset.categoryValue = category.name;
    button.textContent = category.name;
    button.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn').forEach(filter => filter.classList.remove('active'));
      button.classList.add('active');
      activeFilter = button.dataset.filter;
      render();
    });
    container.insertBefore(button, stockFilter);
    existing.add(category.name);
  });
}

function matchesFilter(item) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'in-stock' || activeFilter === 'sold') return item.status === activeFilter;
  if (activeFilter.startsWith('category:')) return item.category === activeFilter.slice('category:'.length);
  return item.category === activeFilter;
}

function matchesSearch(item) {
  if (!searchQuery) return true;
  const searchableText = `${item.name || ''} ${item.caption || ''}`.toLowerCase();
  return searchableText.includes(searchQuery);
}

function getItemImages(item) {
  if (Array.isArray(item.images)) {
    const images = item.images.filter(image => typeof image === 'string' && image.trim());
    if (images.length > 0) return images;
  }
  return item.image ? [item.image] : [];
}

function getCurrentProduct(productId) {
  return allItems.find(item => String(item.id) === String(productId));
}

function isPurchasable(item) {
  return item?.status === 'in-stock' && Number(item.quantity) > 0;
}

function reconcileCartWithStock() {
  cart = cart.reduce((nextCart, cartItem) => {
    const product = getCurrentProduct(cartItem.id);
    if (!isPurchasable(product)) return nextCart;
    const quantity = Math.min(Number(cartItem.quantity) || 0, Number(product.quantity));
    if (quantity > 0) nextCart.push({ ...product, quantity });
    return nextCart;
  }, []);
  saveCart();
  updateCartCount();
}

function render() {
  const items = allItems.filter(item => matchesFilter(item) && matchesSearch(item));
  items.sort((first, second) => {
    if (sortOrder === 'price-low') return parsePrice(first.price) - parsePrice(second.price);
    if (sortOrder === 'price-high') return parsePrice(second.price) - parsePrice(first.price);
    if (sortOrder === 'name-asc') return (first.name || '').localeCompare(second.name || '', undefined, { sensitivity: 'base' });
    if (sortOrder === 'name-desc') return (second.name || '').localeCompare(first.name || '', undefined, { sensitivity: 'base' });
    return (Number(second.createdAt) || 0) - (Number(first.createdAt) || 0);
  });
  if (searchResultPopup) {
    searchResultPopup.textContent = searchQuery && items.length > 0
      ? `${items.length} ${items.length === 1 ? 'result' : 'results'} found`
      : '';
    searchResultPopup.hidden = !searchQuery || items.length === 0;
  }
  if (items.length === 0) {
    galleryEl.innerHTML = `<div class="empty-state"><h2>Nothing here yet</h2><p>Add items from the admin panel to start the archive.</p></div>`;
    return;
  }

  galleryEl.innerHTML = items.map((item, i) => {
    const image = getItemImages(item)[0];
    const media = image ? `<img src="${image}" alt="${escapeHtml(item.name)}" loading="lazy" />` : '<span>No image</span>';
    const actions = isPurchasable(item)
      ? `<button class="btn btn-add-cart" type="button" data-cart-id="${item.id}">Add to basket</button>
         <button class="btn ghost" type="button" data-wishlist-id="${item.id}">Save</button>
         <button class="btn btn-whatsapp-direct" type="button" data-whatsapp-id="${item.id}">WhatsApp</button>`
      : `<button class="btn ghost" type="button" data-wishlist-id="${item.id}">Save</button>
         <button class="btn btn-whatsapp-direct" type="button" data-whatsapp-id="${item.id}">WhatsApp</button>`;
    return `
      <article class="card ${item.status === 'sold' ? 'sold' : ''}" style="animation-delay:${Math.min(i * 40, 400)}ms">
        <div class="card-media ${image ? '' : 'placeholder'}" data-product-id="${item.id}" role="button" tabindex="0" aria-label="View ${escapeHtml(item.name)}">${media}</div>
        <div class="card-body">
          <span class="card-tag ${item.status}">${statusLabel(item.status)}</span>
          <h3 class="card-name" data-product-id="${item.id}" tabindex="0">${escapeHtml(item.name)}</h3>
          ${item.caption ? `<div class="card-caption-wrap">
            <p class="card-caption">${escapeHtml(item.caption)}</p>
            ${collectionView === 'cards' && cardsPerRow > 1 ? `<button class="caption-toggle" type="button" data-product-id="${item.id}" aria-label="View ${escapeHtml(item.name)} images and details">Show more</button>` : ''}
          </div>` : ''}
          ${item.price ? `<div class="card-price">${escapeHtml(item.price)}</div>` : ''}
          <div class="card-actions">
            ${actions}
          </div>
        </div>
      </article>`;
  }).join('');

  galleryEl.querySelectorAll('[data-cart-id]').forEach(button => {
    button.addEventListener('click', () => addToCart(button.dataset.cartId, button));
  });
  galleryEl.querySelectorAll('[data-whatsapp-id]').forEach(button => {
    button.addEventListener('click', () => orderSingleWhatsApp(button.dataset.whatsappId));
  });
  galleryEl.querySelectorAll('[data-wishlist-id]').forEach(button => {
    button.addEventListener('click', () => saveToWishlist(button.dataset.wishlistId));
  });
  galleryEl.querySelectorAll('.caption-toggle').forEach(button => {
    if (button.previousElementSibling.scrollHeight <= button.previousElementSibling.clientHeight) {
      button.hidden = true;
    }
  });
  galleryEl.querySelectorAll('[data-product-id]').forEach(element => {
    element.addEventListener('click', () => openProductModal(element.dataset.productId));
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openProductModal(element.dataset.productId);
      }
    });
  });
}

function statusLabel(status) {
  if (status === 'in-stock') return 'In stock';
  if (status === 'sold') return 'Sold out';
  return 'In the archive';
}

function openProductModal(productId) {
  const product = getCurrentProduct(productId);
  const modal = document.getElementById('product-modal');
  if (!product || !modal) return;

  activeProduct = product;
  lastFocusedElement = document.activeElement;
  const images = getItemImages(product);
  activeGalleryImages = images;
  activeGalleryIndex = 0;
  const mainImage = document.getElementById('gallery-main-img');
  const thumbnails = document.getElementById('gallery-thumbnails');
  document.getElementById('gallery-prev').hidden = images.length < 2;
  document.getElementById('gallery-next').hidden = images.length < 2;
  document.getElementById('modal-product-title').textContent = product.name || '';
  document.getElementById('modal-product-price').textContent = product.price || 'Price on request';
  document.getElementById('modal-product-desc').textContent = product.caption || 'No caption available.';

  if (images.length > 0) {
    mainImage.src = images[0];
    mainImage.alt = `${product.name || 'Product'} image 1 of ${images.length}`;
    thumbnails.innerHTML = images.map((image, index) => `
      <button class="thumb-button ${index === 0 ? 'active' : ''}" type="button" data-image-index="${index}" aria-label="View image ${index + 1}">
        <img src="${image}" alt="" />
      </button>`).join('');
    thumbnails.querySelectorAll('[data-image-index]').forEach(button => {
      button.addEventListener('click', () => changeGalleryImage(images, Number(button.dataset.imageIndex)));
    });
  } else {
    mainImage.removeAttribute('src');
    mainImage.alt = 'No product image';
    thumbnails.innerHTML = '<span class="modal-no-image">No images available</span>';
  }

  const addCartButton = document.getElementById('modal-add-cart');
  const mpesaButton = document.getElementById('modal-buy-mpesa');
  const available = isPurchasable(product);
  addCartButton.hidden = !available;
  mpesaButton.hidden = !available;
  addCartButton.onclick = () => addToCart(product.id, addCartButton);
  mpesaButton.onclick = () => startMpesaCheckout({
    itemName: product.name,
    amount: parsePrice(product.price),
    itemId: product.id,
    itemLines: [{ itemId: String(product.id), itemName: product.name, quantity: 1 }],
    image: getItemImages(product)[0] || ''
  });
  document.getElementById('modal-save-wishlist').onclick = () => saveToWishlist(product.id);
  document.getElementById('modal-buy-whatsapp').onclick = () => orderSingleWhatsApp(product.id);
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('active'));
  document.getElementById('close-product-modal').focus();
}

function changeGalleryImage(images, index) {
  if (!images.length) return;
  activeGalleryImages = images;
  activeGalleryIndex = (index + images.length) % images.length;
  const mainImage = document.getElementById('gallery-main-img');
  mainImage.src = images[activeGalleryIndex];
  mainImage.alt = `${activeProduct?.name || 'Product'} image ${activeGalleryIndex + 1} of ${images.length}`;
  document.querySelectorAll('.thumb-button').forEach((button, buttonIndex) => {
    button.classList.toggle('active', buttonIndex === activeGalleryIndex);
  });
}

function closeProductModal() {
  const modal = document.getElementById('product-modal');
  if (!modal) return;
  modal.classList.remove('active');
  setTimeout(() => { modal.hidden = true; }, 220);
  if (lastFocusedElement) lastFocusedElement.focus();
  activeProduct = null;
}

function addToCart(productId, button) {
  const product = getCurrentProduct(productId);
  if (!isPurchasable(product)) return;
  const existing = cart.find(item => String(item.id) === String(productId));
  if (existing && existing.quantity >= Number(product.quantity)) {
    showToast(`Only ${product.quantity} available`);
    return;
  }
  if (existing) existing.quantity += 1;
  else cart.push({ ...product, quantity: 1 });
  saveCart();
  updateCartCount();
  showAddedFeedback(button);
  showToast(`${product.name} added to basket`);
}

function showAddedFeedback(button) {
  if (!button) return;
  clearTimeout(button.addedFeedbackTimer);
  button.textContent = 'Added';
  button.classList.remove('is-added');
  void button.offsetWidth;
  button.classList.add('is-added');
  button.addedFeedbackTimer = setTimeout(() => {
    button.textContent = 'Add to basket';
    button.classList.remove('is-added');
  }, 850);
}

function updateQuantity(productId, delta) {
  const item = cart.find(entry => String(entry.id) === String(productId));
  if (!item) return;
  const product = getCurrentProduct(productId);
  if (delta > 0 && (!isPurchasable(product) || item.quantity >= Number(product.quantity))) {
    showToast(product ? `Only ${product.quantity} available` : 'This item is no longer available');
    reconcileCartWithStock();
    renderCartModal();
    return;
  }
  item.quantity += delta;
  if (item.quantity <= 0) cart = cart.filter(entry => String(entry.id) !== String(productId));
  saveCart();
  updateCartCount();
  renderCartModal();
}

function removeFromCart(productId) {
  cart = cart.filter(item => String(item.id) !== String(productId));
  saveCart();
  updateCartCount();
  renderCartModal();
}

function saveCart() {
  localStorage.setItem('shoe_cart', JSON.stringify(cart));
  const token = localStorage.getItem('marketplaceToken');
  if (token) {
    fetch('/api/marketplace/cart', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-marketplace-token': token },
      body: JSON.stringify({
        items: cart.map(item => ({ productId: String(item.id), quantity: Number(item.quantity) }))
      })
    }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not sync your basket.');
    }).catch(error => showToast(error.message));
  }
}

async function loadSignedInCart() {
  const token = localStorage.getItem('marketplaceToken');
  if (!token) return;
  const response = await fetch('/api/marketplace/cart', { headers: { 'x-marketplace-token': token } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) localStorage.removeItem('marketplaceToken');
    throw new Error(data.message || 'Could not load your account basket.');
  }
  const merged = new Map();
  for (const { product, quantity } of data.cart.items) {
    const current = getCurrentProduct(product.id);
    if (isPurchasable(current)) {
      merged.set(String(product.id), { ...current, quantity: Math.min(Number(quantity), Number(current.quantity)) });
    }
  }
  for (const item of cart) {
    const product = getCurrentProduct(item.id);
    if (!isPurchasable(product)) continue;
    const existing = merged.get(String(item.id));
    const quantity = Math.min(Number(item.quantity) + (existing?.quantity || 0), Number(product.quantity));
    if (quantity > 0) merged.set(String(item.id), { ...product, quantity });
  }
  cart = [...merged.values()];
  localStorage.setItem('shoe_cart', JSON.stringify(cart));
  const sync = await fetch('/api/marketplace/cart', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-marketplace-token': token },
    body: JSON.stringify({ items: cart.map(item => ({ productId: String(item.id), quantity: Number(item.quantity) })) })
  });
  if (!sync.ok) {
    const syncData = await sync.json();
    throw new Error(syncData.message || 'Could not merge your basket.');
  }
}

async function saveToWishlist(productId) {
  const token = localStorage.getItem('marketplaceToken');
  if (!token) {
    window.location.href = '/account.html';
    return;
  }
  try {
    const response = await fetch(`/api/marketplace/wishlist/${encodeURIComponent(productId)}`, {
      method: 'PUT',
      headers: { 'x-marketplace-token': token }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Could not save this piece.');
    showToast('Saved to your account.');
  } catch (error) {
    showToast(error.message);
  }
}

function updateCartCount() {
  const badge = document.getElementById('cart-count');
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  badge.textContent = count;
  badge.style.display = count ? 'inline-flex' : 'none';
}

function orderSingleWhatsApp(productId) {
  const product = allItems.find(item => String(item.id) === String(productId));
  if (!product) return;

  const itemPrice = parseInt(product.price.toString().replace(/[^0-9]/g, ''), 10) || 0;
  const message = `Hello! I would like to buy this item:\n\n` +
    `👟 *Item:* ${product.name}\n` +
    `💵 *Price:* KSh ${itemPrice.toFixed(2)}\n\n` +
    `Please let me know how to proceed with payment and delivery.`;

  const encodedMessage = encodeURIComponent(message);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${sellerPhoneNumber || '254728074301'}&text=${encodedMessage}`;
  window.open(whatsappUrl, '_blank');
}

function sendBasketToWhatsApp() {
  if (cart.length === 0) {
    alert('Your basket is empty!');
    return;
  }

  let message = `Hello! I would like to order the following basket items:\n\n`;
  let grandTotal = 0;

  cart.forEach((item, index) => {
    const itemPrice = parseInt(item.price.toString().replace(/[^0-9]/g, ''), 10) || 0;
    const itemTotal = itemPrice * item.quantity;
    grandTotal += itemTotal;
    message += `${index + 1}. *${item.name}*\n` +
      `   Qty: ${item.quantity} × KSh ${itemPrice.toFixed(2)} = KSh ${itemTotal.toFixed(2)}\n\n`;
  });

  message += `\n💰 *Total Amount:* KSh ${grandTotal.toFixed(2)}\n\n` +
    `Please confirm availability and payment options.`;

  const encodedMessage = encodeURIComponent(message);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=${sellerPhoneNumber || '254728074301'}&text=${encodedMessage}`;
  window.open(whatsappUrl, '_blank');
}

function renderCartModal() {
  const container = document.getElementById('cart-items-container');
  const totalElement = document.getElementById('cart-total-price');
  if (!container || !totalElement) return;
  if (cart.length === 0) {
    container.innerHTML = '<p class="empty-cart-msg">Your basket is currently empty.</p>';
    totalElement.textContent = 'KSh 0.00';
    return;
  }

  let grandTotal = 0;
  let itemsHtml = cart.map(item => {
    const itemPrice = parseInt(item.price.toString().replace(/[^0-9]/g, ''), 10) || 0;
    const itemTotal = itemPrice * item.quantity;
    grandTotal += itemTotal;
    const itemImage = getItemImages(item)[0];
    const product = getCurrentProduct(item.id);
    const stockLimitReached = !isPurchasable(product) || item.quantity >= Number(product.quantity);
    return `
      <div class="cart-item">
        ${itemImage ? `<img src="${itemImage}" alt="${escapeHtml(item.name)}" />` : '<div class="cart-item-image"></div>'}
        <div class="cart-item-details">
          <h4>${escapeHtml(item.name)}</h4>
          <p class="cart-item-price">KSh ${itemPrice.toFixed(2)}</p>
          <div class="quantity-controls">
            <button type="button" data-quantity-id="${item.id}" data-delta="-1" aria-label="Decrease quantity">-</button>
            <span>${item.quantity}</span>
            <button type="button" data-quantity-id="${item.id}" data-delta="1" aria-label="Increase quantity" ${stockLimitReached ? 'disabled' : ''}>+</button>
          </div>
        </div>
        <button class="remove-btn" type="button" data-remove-id="${item.id}" aria-label="Remove item">&times;</button>
      </div>`;
  }).join('');

  itemsHtml += `
    <div class="basket-action-wrapper">
      <button class="btn-whatsapp-cart" id="send-whatsapp-cart" type="button">Send Basket to WhatsApp</button>
      <button class="btn btn-mpesa" id="cart-checkout-mpesa" type="button">Checkout with M-Pesa</button>
    </div>`;

  container.innerHTML = itemsHtml;
  totalElement.textContent = `KSh ${grandTotal.toFixed(2)}`;

  document.getElementById('send-whatsapp-cart').addEventListener('click', sendBasketToWhatsApp);
  document.getElementById('cart-checkout-mpesa').addEventListener('click', checkoutCartWithMpesa);

  container.querySelectorAll('[data-quantity-id]').forEach(button => {
    button.addEventListener('click', () => updateQuantity(button.dataset.quantityId, Number(button.dataset.delta)));
  });
  container.querySelectorAll('[data-remove-id]').forEach(button => {
    button.addEventListener('click', () => removeFromCart(button.dataset.removeId));
  });
}

function setupCartUI() {
  const modal = document.getElementById('cart-modal');
  const cartButton = document.getElementById('cart-btn');
  cartButton.addEventListener('click', () => {
    renderCartModal();
    modal.classList.add('active');
  });
  document.getElementById('close-cart').addEventListener('click', () => modal.classList.remove('active'));
  document.addEventListener('pointerdown', event => {
    if (modal.classList.contains('active') && !modal.contains(event.target) && !cartButton.contains(event.target)) {
      modal.classList.remove('active');
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.getElementById('toast') || document.createElement('div');
  toast.id = 'toast';
  toast.textContent = message;
  if (!toast.parentNode) document.body.appendChild(toast);
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

searchInput.addEventListener('input', event => {
  searchQuery = event.target.value.toLowerCase().trim();
  clearSearch.hidden = !searchQuery;
  render();
});

clearSearch.addEventListener('click', () => {
  searchInput.value = '';
  searchQuery = '';
  clearSearch.hidden = true;
  render();
  searchInput.focus();
});

document.getElementById('close-product-modal').addEventListener('click', closeProductModal);
document.getElementById('gallery-prev').addEventListener('click', () => {
  changeGalleryImage(activeGalleryImages, activeGalleryIndex - 1);
});
document.getElementById('gallery-next').addEventListener('click', () => {
  changeGalleryImage(activeGalleryImages, activeGalleryIndex + 1);
});
let swipeStart = null;
const mainImageWrapper = document.querySelector('.main-image-wrapper');
mainImageWrapper.addEventListener('touchstart', event => {
  if (event.touches.length !== 1) return;
  swipeStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
mainImageWrapper.addEventListener('touchend', event => {
  if (!swipeStart || event.changedTouches.length !== 1 || activeGalleryImages.length < 2) {
    swipeStart = null;
    return;
  }
  const deltaX = event.changedTouches[0].clientX - swipeStart.x;
  const deltaY = event.changedTouches[0].clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(deltaX) < 40 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
  const direction = deltaX < 0 ? 1 : -1;
  changeGalleryImage(activeGalleryImages, activeGalleryIndex + direction);
}, { passive: true });
document.getElementById('product-modal').addEventListener('click', event => {
  if (event.target.id === 'product-modal') closeProductModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('product-modal').hidden) closeProductModal();
});

filterBtns.forEach(button => {
  button.addEventListener('click', () => {
    filterBtns.forEach(filter => filter.classList.remove('active'));
    button.classList.add('active');
    activeFilter = button.dataset.filter;
    render();
  });
});

document.getElementById('sort-order').addEventListener('change', event => {
  sortOrder = event.target.value;
  render();
});

function parsePrice(value) {
  const price = String(value || '').replace(/[\s,]/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
  return price ? Math.round(Number(price[0])) : 0;
}

function formatKsh(amount) {
  return `KSh ${Number(amount || 0).toFixed(2)}`;
}

let currentCheckout = null;
let mpesaPollTimer = null;

function checkoutCartWithMpesa() {
  reconcileCartWithStock();
  if (cart.length === 0) {
    alert('Your basket is empty!');
    return;
  }
  const total = cart.reduce((sum, item) => sum + parsePrice(item.price) * item.quantity, 0);
  const names = cart.map(item => `${item.name} × ${item.quantity}`).join(', ');
  startMpesaCheckout({
    itemName: names,
    amount: total,
    itemId: cart.map(item => item.id).join(','),
    itemLines: cart.map(item => ({
      itemId: String(item.id),
      itemName: item.name,
      quantity: item.quantity
    })),
    image: getItemImages(cart[0])[0] || '',
    clearCartOnSuccess: true
  });
}

function startMpesaCheckout(order) {
  currentCheckout = order;
  const modal = document.getElementById('mpesaCheckoutModal');
  document.getElementById('mpesaOrderTitle').textContent = order.itemName;
  document.getElementById('mpesaOrderPrice').textContent = formatKsh(order.amount);
  const thumb = document.getElementById('mpesaOrderThumb');
  thumb.innerHTML = order.image ? `<img src="${order.image}" alt="" />` : '';
  document.getElementById('mpesaFormError').textContent = '';
  document.getElementById('mpesaPayForm').reset();
  document.getElementById('savedAddressField').hidden = true;
  document.getElementById('newDeliveryAddressFields').hidden = false;
  for (const id of ['mpesaDeliveryState', 'mpesaDeliveryCity', 'mpesaDeliveryStreet']) {
    document.getElementById(id).required = true;
  }
  prepareCheckoutAddresses();
  showMpesaStep('input');
  document.getElementById('cart-modal').classList.remove('active');
  closeProductModal();
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('active'));
}

function closeMpesaModal() {
  const modal = document.getElementById('mpesaCheckoutModal');
  modal.classList.remove('active');
  setTimeout(() => { modal.hidden = true; }, 220);
  if (mpesaPollTimer) {
    clearInterval(mpesaPollTimer);
    mpesaPollTimer = null;
  }
}

function showMpesaStep(step) {
  document.getElementById('mpesaStepInput').style.display = step === 'input' ? 'block' : 'none';
  document.getElementById('mpesaStepProcessing').style.display = step === 'processing' ? 'block' : 'none';
  document.getElementById('mpesaStepSuccess').style.display = step === 'success' ? 'block' : 'none';
}

async function submitMpesaCheckout(event) {
  event.preventDefault();
  const errorEl = document.getElementById('mpesaFormError');
  const submitBtn = document.getElementById('mpesaSubmitBtn');
  errorEl.textContent = '';
  if (!currentCheckout || !currentCheckout.amount) {
    errorEl.textContent = 'This item needs a price before M-Pesa checkout.';
    return;
  }

  const customerName = document.getElementById('mpesaCustomerName').value.trim();
  const phoneNumber = document.getElementById('mpesaPhoneNumber').value.trim();
  const savedAddressId = document.getElementById('mpesaSavedAddress').value;
  const deliveryAddress = {
    recipient: customerName,
    phone: phoneNumber,
    state: document.getElementById('mpesaDeliveryState').value.trim(),
    city: document.getElementById('mpesaDeliveryCity').value.trim(),
    street: document.getElementById('mpesaDeliveryStreet').value.trim(),
    addressLine: document.getElementById('mpesaDeliveryAddressLine').value.trim(),
    country: 'Kenya'
  };
  if (!savedAddressId && (!deliveryAddress.state || !deliveryAddress.city || !deliveryAddress.street)) {
    errorEl.textContent = 'Enter a delivery area, city, and street, or choose a saved address.';
    return;
  }
  currentCheckout.customerName = customerName;
  currentCheckout.phoneNumber = phoneNumber;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending prompt...';
  try {
    const accountToken = localStorage.getItem('marketplaceToken');
    const headers = { 'Content-Type': 'application/json' };
    if (accountToken) headers['x-marketplace-token'] = accountToken;
    const res = await fetch('/api/mpesa/stkpush', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        phoneNumber,
        amount: currentCheckout.amount,
        itemName: currentCheckout.itemName,
        customerName,
        itemId: currentCheckout.itemId,
        itemLines: currentCheckout.itemLines || [],
        ...(savedAddressId ? { addressId: savedAddressId } : { deliveryAddress })
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || 'Failed to send M-Pesa prompt.');
    }
    currentCheckout.checkoutRequestId = data.checkoutRequestId;
    document.getElementById('promptPhone').textContent = phoneNumber;
    document.getElementById('mpesaStatusText').style.color = '#25d366';
    document.getElementById('mpesaStatusText').textContent = data.customerMessage || 'Waiting for M-Pesa confirmation...';
    showMpesaStep('processing');
    startPaymentPolling(data.checkoutRequestId);
  } catch (err) {
    errorEl.textContent = err.message || 'Could not start M-Pesa checkout.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send M-Pesa Prompt';
  }
}

function startPaymentPolling(checkoutRequestId) {
  if (mpesaPollTimer) clearInterval(mpesaPollTimer);
  mpesaPollTimer = setInterval(() => pollPaymentStatus(checkoutRequestId), 3000);
  pollPaymentStatus(checkoutRequestId);
}

async function pollPaymentStatus(checkoutRequestId) {
  try {
    const res = await fetch(`/api/mpesa/status/${encodeURIComponent(checkoutRequestId)}`);
    const data = await res.json();
    if (data.status === 'COMPLETED') {
      clearInterval(mpesaPollTimer);
      mpesaPollTimer = null;
      showPaymentSuccess();
      return;
    }
    if (data.status === 'FAILED') {
      clearInterval(mpesaPollTimer);
      mpesaPollTimer = null;
      document.getElementById('mpesaStatusText').textContent = data.message || 'Payment was cancelled or failed.';
      document.getElementById('mpesaStatusText').style.color = '#ff6b6b';
    }
  } catch {
    document.getElementById('mpesaStatusText').textContent = 'Still waiting for M-Pesa confirmation...';
  }
}

function showPaymentSuccess() {
  showMpesaStep('success');
  document.getElementById('mpesaSuccessMessage').textContent = 'Payment confirmed. Thank you for your order.';
  const pushBtn = document.getElementById('mpesaPushWhatsappBtn');
  if (pushBtn && currentCheckout) {
    const checkoutCopy = { ...currentCheckout };
    pushBtn.onclick = () => {
      const itemName = checkoutCopy.itemName || 'Collection Item';
      const amount = checkoutCopy.amount ? formatKsh(checkoutCopy.amount) : '';
      const phone = checkoutCopy.phoneNumber || '';
      const address = checkoutCopy.address ? `${checkoutCopy.address.street}, ${checkoutCopy.address.city}` : '';
      const msg = [
        'Hello! I just placed and confirmed an order on The Collection:',
        '',
        `• Item: ${itemName}`,
        amount ? `• Amount: ${amount}` : '',
        phone ? `• Customer Phone: ${phone}` : '',
        address ? `• Delivery Destination: ${address}` : '',
        '',
        'Could you please confirm receipt and update me on dispatch? Thank you!'
      ].filter(Boolean).join('\n');
      const url = `https://api.whatsapp.com/send?phone=${sellerPhoneNumber || '254728074301'}&text=${encodeURIComponent(msg)}`;
      window.open(url, '_blank');
    };
  }
  if (currentCheckout?.clearCartOnSuccess) {
    cart = [];
    saveCart();
    updateCartCount();
  }
  loadItems();
}

function setupMpesaUI() {
  document.getElementById('mpesaPayForm').addEventListener('submit', submitMpesaCheckout);
  document.getElementById('closeMpesaModal').addEventListener('click', closeMpesaModal);
  document.getElementById('mpesaCheckoutModal').addEventListener('click', event => {
    if (event.target.id === 'mpesaCheckoutModal') closeMpesaModal();
  });
  document.getElementById('mpesaSavedAddress').addEventListener('change', event => {
    const useSavedAddress = Boolean(event.target.value);
    document.getElementById('newDeliveryAddressFields').hidden = useSavedAddress;
    for (const id of ['mpesaDeliveryState', 'mpesaDeliveryCity', 'mpesaDeliveryStreet']) {
      document.getElementById(id).required = !useSavedAddress;
    }
    const address = marketplaceAddresses.find(item => item.id === event.target.value);
    if (address) {
      document.getElementById('mpesaCustomerName').value = address.recipient;
      document.getElementById('mpesaPhoneNumber').value = address.phone;
    }
  });
}

async function prepareCheckoutAddresses() {
  const token = localStorage.getItem('marketplaceToken');
  const wrapper = document.getElementById('savedAddressField');
  const select = document.getElementById('mpesaSavedAddress');
  wrapper.hidden = !token;
  select.innerHTML = '<option value="">Enter a new delivery address</option>';
  marketplaceAddresses = [];
  if (!token) return;
  try {
    const response = await fetch('/api/marketplace/addresses', { headers: { 'x-marketplace-token': token } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Could not load saved addresses.');
    marketplaceAddresses = data.addresses || [];
    select.innerHTML += marketplaceAddresses.map(address =>
      `<option value="${escapeHtml(address.id)}">${escapeHtml([address.recipient, address.street, address.city, address.state].join(' · '))}</option>`
    ).join('');
  } catch (error) {
    showToast(error.message);
  }
}

setupCartUI();
setupMpesaUI();
updateCartCount();
loadItems();