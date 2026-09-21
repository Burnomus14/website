const galleryEl = document.getElementById('gallery');
const filterBtns = document.querySelectorAll('.filter-btn');
const searchInput = document.getElementById('search-input');
const clearSearch = document.getElementById('clear-search');
let sellerPhoneNumber = '';

let allItems = [];
let activeFilter = 'all';
let searchQuery = '';
let cart = JSON.parse(localStorage.getItem('shoe_cart') || '[]');
let activeProduct = null;
let lastFocusedElement = null;

async function loadItems() {
  try {
    const [itemsRes, configRes] = await Promise.all([fetch('/api/items'), fetch('/api/config')]);
    allItems = await itemsRes.json();
    ({ sellerPhone: sellerPhoneNumber } = await configRes.json());
    render();
  } catch {
    galleryEl.innerHTML = `<div class="empty-state"><h2>Couldn't load the collection</h2><p>Make sure the server is running, then refresh.</p></div>`;
  }
}

function matchesFilter(item) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'in-stock' || activeFilter === 'sold') return item.status === activeFilter;
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

function render() {
  const items = allItems.filter(item => matchesFilter(item) && matchesSearch(item));
  if (items.length === 0) {
    galleryEl.innerHTML = `<div class="empty-state"><h2>Nothing here yet</h2><p>Add items from the admin panel to start the archive.</p></div>`;
    return;
  }

  galleryEl.innerHTML = items.map((item, i) => {
    const image = getItemImages(item)[0];
    const media = image ? `<img src="${image}" alt="${escapeHtml(item.name)}" loading="lazy" />` : '<span>No image</span>';
    return `
      <article class="card ${item.status === 'sold' ? 'sold' : ''}" style="animation-delay:${Math.min(i * 40, 400)}ms">
        <div class="card-media ${image ? '' : 'placeholder'}" data-product-id="${item.id}" role="button" tabindex="0" aria-label="View ${escapeHtml(item.name)}">${media}</div>
        <div class="card-body">
          <span class="card-tag ${item.status}">${statusLabel(item.status)}</span>
          <h3 class="card-name" data-product-id="${item.id}" tabindex="0">${escapeHtml(item.name)}</h3>
          ${item.caption ? `<p class="card-caption">${escapeHtml(item.caption)}</p>` : ''}
          ${item.price ? `<div class="card-price">${escapeHtml(item.price)}</div>` : ''}
          <div class="card-actions">
            <button class="btn btn-add-cart" type="button" data-cart-id="${item.id}">Add to basket</button>
            <button class="btn btn-whatsapp-direct" type="button" data-whatsapp-id="${item.id}">WhatsApp</button>
          </div>
        </div>
      </article>`;
  }).join('');

  galleryEl.querySelectorAll('[data-cart-id]').forEach(button => {
    button.addEventListener('click', () => addToCart(button.dataset.cartId));
  });
  galleryEl.querySelectorAll('[data-whatsapp-id]').forEach(button => {
    button.addEventListener('click', () => orderSingleWhatsApp(button.dataset.whatsappId));
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
  if (status === 'sold') return 'Sold';
  return 'In the archive';
}

function openProductModal(productId) {
  const product = allItems.find(item => String(item.id) === String(productId));
  const modal = document.getElementById('product-modal');
  if (!product || !modal) return;

  activeProduct = product;
  lastFocusedElement = document.activeElement;
  const images = getItemImages(product);
  const mainImage = document.getElementById('gallery-main-img');
  const thumbnails = document.getElementById('gallery-thumbnails');
  document.getElementById('modal-product-title').textContent = product.name || '';
  document.getElementById('modal-product-price').textContent = product.price || 'Price on request';
  document.getElementById('modal-product-desc').textContent = product.caption || 'No caption available.';

  if (images.length > 0) {
    mainImage.src = images[0];
    mainImage.alt = product.name || 'Product image';
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

  document.getElementById('modal-add-cart').onclick = () => addToCart(product.id);
  document.getElementById('modal-buy-whatsapp').onclick = () => orderSingleWhatsApp(product.id);
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('active'));
  document.getElementById('close-product-modal').focus();
}

function changeGalleryImage(images, index) {
  const mainImage = document.getElementById('gallery-main-img');
  mainImage.src = images[index];
  document.querySelectorAll('.thumb-button').forEach((button, buttonIndex) => {
    button.classList.toggle('active', buttonIndex === index);
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

function addToCart(productId) {
  const product = allItems.find(item => String(item.id) === String(productId));
  if (!product) return;
  const existing = cart.find(item => String(item.id) === String(productId));
  if (existing) existing.quantity += 1;
  else cart.push({ ...product, quantity: 1 });
  saveCart();
  updateCartCount();
  showToast(`${product.name} added to basket`);
}

function updateQuantity(productId, delta) {
  const item = cart.find(entry => String(entry.id) === String(productId));
  if (!item) return;
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

  const message = `Hello! I would like to buy this item:\n\n` +
    `👟 *Item:* ${product.name}\n` +
    `💵 *Price:* KSh ${parseFloat(product.price).toFixed(2)}\n\n` +
    `Please let me know how to proceed with payment and delivery.`;

  const encodedMessage = encodeURIComponent(message);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=254728074301&text=${encodedMessage}`;
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
    const itemPrice = parseFloat(item.price) || 0;
    const itemTotal = itemPrice * item.quantity;
    grandTotal += itemTotal;
    message += `${index + 1}. *${item.name}*\n` +
      `   Qty: ${item.quantity} × KSh ${itemPrice.toFixed(2)} = KSh ${itemTotal.toFixed(2)}\n\n`;
  });

  message += `\n💰 *Total Amount:* KSh ${grandTotal.toFixed(2)}\n\n` +
    `Please confirm availability and payment options.`;

  const encodedMessage = encodeURIComponent(message);
  const whatsappUrl = `https://api.whatsapp.com/send?phone=254728074301&text=${encodedMessage}`;
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
    const itemPrice = parseFloat(item.price) || 0;
    const itemTotal = itemPrice * item.quantity;
    grandTotal += itemTotal;
    const itemImage = getItemImages(item)[0];
    return `
      <div class="cart-item">
        ${itemImage ? `<img src="${itemImage}" alt="${escapeHtml(item.name)}" />` : '<div class="cart-item-image"></div>'}
        <div class="cart-item-details">
          <h4>${escapeHtml(item.name)}</h4>
          <p class="cart-item-price">KSh ${itemPrice.toFixed(2)}</p>
          <div class="quantity-controls">
            <button type="button" data-quantity-id="${item.id}" data-delta="-1" aria-label="Decrease quantity">-</button>
            <span>${item.quantity}</span>
            <button type="button" data-quantity-id="${item.id}" data-delta="1" aria-label="Increase quantity">+</button>
          </div>
        </div>
        <button class="remove-btn" type="button" data-remove-id="${item.id}" aria-label="Remove item">&times;</button>
      </div>`;
  }).join('');

  itemsHtml += `
    <div class="basket-action-wrapper">
      <button class="btn-whatsapp-cart" id="send-whatsapp-cart" type="button">Send Basket to WhatsApp</button>
    </div>`;

  container.innerHTML = itemsHtml;
  totalElement.textContent = `KSh ${grandTotal.toFixed(2)}`;

  document.getElementById('send-whatsapp-cart').addEventListener('click', sendBasketToWhatsApp);

  container.querySelectorAll('[data-quantity-id]').forEach(button => {
    button.addEventListener('click', () => updateQuantity(button.dataset.quantityId, Number(button.dataset.delta)));
  });
  container.querySelectorAll('[data-remove-id]').forEach(button => {
    button.addEventListener('click', () => removeFromCart(button.dataset.removeId));
  });
}

function setupCartUI() {
  const modal = document.getElementById('cart-modal');
  document.getElementById('cart-btn').addEventListener('click', () => {
    renderCartModal();
    modal.classList.add('active');
  });
  document.getElementById('close-cart').addEventListener('click', () => modal.classList.remove('active'));
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

setupCartUI();
updateCartCount();
loadItems();