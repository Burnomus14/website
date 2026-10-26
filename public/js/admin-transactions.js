const transactionMessage = document.getElementById('transactionMessage');
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { auth } from './firebase.js';

const transactionsTableWrap = document.getElementById('transactionsTableWrap');
const transactionsTableBody = document.getElementById('transactionsTableBody');
const token = localStorage.getItem('adminToken');

function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = value ?? '';
  return element.innerHTML;
}

function formatDate(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '—';
}

function renderItems(transaction) {
  if (!Array.isArray(transaction.itemLines) || transaction.itemLines.length === 0) {
    const oldItemLabel = escapeHtml(transaction.itemName || 'Item');
    return `${oldItemLabel}<span class="transaction-legacy-note">Quantity unavailable for this older transaction</span>`;
  }

  return `<ul class="transaction-items">${transaction.itemLines.map(line =>
    `<li>${escapeHtml(line.itemName || 'Item')} × ${Math.max(1, Number(line.quantity) || 1)}</li>`
  ).join('')}</ul>`;
}

function renderTransactions(transactions) {
  transactionsTableBody.innerHTML = transactions.map(transaction => `
    <tr>
      <td>${escapeHtml(transaction.customerName || '—')}</td>
      <td>${escapeHtml(transaction.phoneNumber || '—')}</td>
      <td>KSh ${Number(transaction.amount || 0).toFixed(2)}</td>
      <td>${renderItems(transaction)}</td>
      <td>${escapeHtml(formatDate(transaction.completedAt || transaction.createdAt))}</td>
    </tr>
  `).join('');
  transactionsTableWrap.hidden = false;
  transactionMessage.hidden = true;
}

async function loadTransactions() {
  if (!token) {
    window.location.href = '/admin-login.html';
    return;
  }

  transactionMessage.hidden = false;
  transactionMessage.textContent = 'Loading transactions...';
  transactionsTableWrap.hidden = true;

  try {
    const response = await fetch('/api/admin/transactions', {
      headers: { 'x-admin-token': token }
    });
    if (response.status === 401) {
      localStorage.removeItem('adminToken');
      window.location.href = '/admin-login.html';
      return;
    }

    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Could not load transactions.');
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    if (transactions.length === 0) {
      transactionMessage.textContent = 'No paid transactions yet.';
      return;
    }
    renderTransactions(transactions);
  } catch (error) {
    transactionMessage.textContent = error.message || 'Could not load transactions.';
  }
}

document.getElementById('refreshTransactions').addEventListener('click', loadTransactions);
document.getElementById('signOut').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', headers: { 'x-admin-token': token || '' } });
  } catch (error) {
    console.error('Admin sign-out failed:', error);
  }
  localStorage.removeItem('adminToken');
  await signOut(auth);
  window.location.href = '/admin-login.html';
});

loadTransactions();