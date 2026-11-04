'use strict';
// Simple visit statistics kept in your own database. No IP addresses are stored. Without the optional visit
// cookie, a visitor is a one-way code made from IP + browser + today's date + a secret. With it, the code
// is made from the cookie's random id instead, which is more accurate and lets us see returning visitors. Counts are saved in batches so tracking never slows the shop down.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EVENTS = ['view', 'product_view', 'add_to_cart', 'checkout_start', 'paid'];
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|curl|wget|python|headless|monitor|uptime/i;
const ID_OK = /^[A-Za-z0-9_-]{1,40}$/;

function dayKey(date = new Date(), offsetHours = 3) {
  return new Date(date.getTime() + offsetHours * 3600000).toISOString().slice(0, 10); // Kenya time (UTC+3)
}

function createAnalytics({ db = null, dataDir = '', collection = 'analytics_daily', FieldValue = null, secret = '', now = () => new Date() } = {}) {
  const salt = secret || crypto.randomBytes(16).toString('hex');
  const pending = new Map(); // day -> { counts: {key: n}, visitors: n }
  const seen = new Map(); // day -> Set of visitor codes
  const localFile = dataDir ? path.join(dataDir, 'analytics.json') : '';

  function bucket(day) {
    if (!pending.has(day)) pending.set(day, { counts: {}, visitors: 0 });
    return pending.get(day);
  }
  function visitorCode(day, ip, agent) {
    return crypto.createHash('sha256').update(`${salt}|${day}|${ip}|${agent}`).digest('hex').slice(0, 24);
  }

  // Returns true when the event was counted.
  // `visitorId` and `firstSeenDay` come from the optional visit cookie, which exists only if the visitor accepted it.
  function record(event, { productId = '', ip = '', userAgent = '', visitorId = '', firstSeenDay = '' } = {}) {
    if (!EVENTS.includes(event)) return false;
    if (BOT.test(userAgent || '')) return false;
    const day = dayKey(now());
    const b = bucket(day);
    b.counts[`e_${event}`] = (b.counts[`e_${event}`] || 0) + 1;
    if (productId && ID_OK.test(String(productId)) && ['product_view', 'add_to_cart', 'checkout_start', 'paid'].includes(event)) {
      const key = `p_${event}_${productId}`;
      b.counts[key] = (b.counts[key] || 0) + 1;
    }
    if (event === 'view') {
      if (!seen.has(day)) { seen.clear(); seen.set(day, new Set()); }
      const code = visitorId && /^[a-f0-9]{16,32}$/.test(visitorId) ? visitorCode(day, visitorId, 'cookie') : visitorCode(day, ip, userAgent);
      if (!seen.get(day).has(code)) {
        seen.get(day).add(code);
        b.visitors += 1;
        if (visitorId) {
          b.counts.cookie_visitors = (b.counts.cookie_visitors || 0) + 1;
          if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeenDay) && firstSeenDay < day) b.counts.returning = (b.counts.returning || 0) + 1;
        }
      }
    }
    return true;
  }

  function readLocal() {
    try { return JSON.parse(fs.readFileSync(localFile, 'utf8')); } catch { return {}; }
  }

  async function flush() {
    if (!pending.size) return 0;
    const batch = Array.from(pending.entries());
    pending.clear();
    let written = 0;
    try {
      if (db && FieldValue) {
        for (const [day, b] of batch) {
          const data = {};
          for (const [k, n] of Object.entries(b.counts)) data[k] = FieldValue.increment(n);
          if (b.visitors) data.visitors = FieldValue.increment(b.visitors);
          await db.collection(collection).doc(day).set(data, { merge: true });
          written++;
        }
      } else if (localFile) {
        const store = readLocal();
        for (const [day, b] of batch) {
          const row = store[day] || {};
          for (const [k, n] of Object.entries(b.counts)) row[k] = (row[k] || 0) + n;
          if (b.visitors) row.visitors = (row.visitors || 0) + b.visitors;
          store[day] = row;
          written++;
        }
        fs.mkdirSync(dataDir, { recursive: true });
        const tmp = `${localFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(store));
        fs.renameSync(tmp, localFile);
      }
    } catch (error) {
      console.error('Analytics save failed:', error.message);
      for (const [day, b] of batch) { // put the counts back so they are retried
        const again = bucket(day);
        for (const [k, n] of Object.entries(b.counts)) again.counts[k] = (again.counts[k] || 0) + n;
        again.visitors += b.visitors;
      }
    }
    return written;
  }

  async function loadDays(days) {
    const keys = [];
    for (let i = 0; i < days; i++) keys.push(dayKey(new Date(now().getTime() - i * 86400000)));
    const rows = {};
    if (db) {
      await Promise.all(keys.map(async key => {
        const snap = await db.collection(collection).doc(key).get();
        if (snap.exists) rows[key] = snap.data();
      }));
    } else {
      const store = readLocal();
      for (const key of keys) if (store[key]) rows[key] = store[key];
    }
    // include what has not been saved yet
    for (const [day, b] of pending) {
      if (!keys.includes(day)) continue;
      const row = rows[day] = { ...(rows[day] || {}) };
      for (const [k, n] of Object.entries(b.counts)) row[k] = (row[k] || 0) + n;
      row.visitors = (row.visitors || 0) + b.visitors;
    }
    return { keys, rows };
  }

  // Totals, a daily list, the shopping funnel and the most viewed products over the last `days` days.
  async function summary(days = 30, productNames = {}) {
    days = Math.max(1, Math.min(90, Number(days) || 30));
    await flush();
    const { keys, rows } = await loadDays(days);
    const totals = { visitors: 0, returning: 0, cookie_visitors: 0, view: 0, product_view: 0, add_to_cart: 0, checkout_start: 0, paid: 0 };
    const daily = [];
    const products = {};
    for (const key of keys) {
      const row = rows[key] || {};
      daily.push({ day: key, visitors: row.visitors || 0, views: row.e_view || 0, paid: row.e_paid || 0 });
      totals.visitors += row.visitors || 0;
      totals.returning += row.returning || 0;
      totals.cookie_visitors += row.cookie_visitors || 0;
      for (const event of EVENTS) totals[event] += row[`e_${event}`] || 0;
      for (const [k, n] of Object.entries(row)) {
        const m = /^p_(product_view|add_to_cart|checkout_start|paid)_(.+)$/.exec(k);
        if (!m) continue;
        const p = products[m[2]] = products[m[2]] || { id: m[2], product_view: 0, add_to_cart: 0, checkout_start: 0, paid: 0 };
        p[m[1]] += n;
      }
    }
    const topProducts = Object.values(products)
      .map(p => ({ ...p, name: productNames[p.id] || p.id }))
      .sort((a, b) => b.product_view - a.product_view || b.add_to_cart - a.add_to_cart)
      .slice(0, 10);
    const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const funnel = [
      { step: 'Product views', count: totals.product_view },
      { step: 'Added to basket', count: totals.add_to_cart, percentOfPrevious: rate(totals.add_to_cart, totals.product_view) },
      { step: 'Started checkout', count: totals.checkout_start, percentOfPrevious: rate(totals.checkout_start, totals.add_to_cart) },
      { step: 'Paid', count: totals.paid, percentOfPrevious: rate(totals.paid, totals.checkout_start) }
    ];
    return { days, totals, daily: daily.reverse(), funnel, topProducts };
  }

  return { record, flush, summary, EVENTS };
}

module.exports = { createAnalytics, dayKey, EVENTS };
