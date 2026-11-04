'use strict';
// Page tags for search engines, link previews and "add to home screen". Everything here is injected by the
// server, so the HTML files themselves do not need editing.

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const PAGES = {
  '/': { title: 'The Collection', description: 'Shoes and clothing, curated. Browse the collection, save pieces and pay with M-Pesa.', index: true },
  '/index.html': { title: 'The Collection', description: 'Shoes and clothing, curated. Browse the collection, save pieces and pay with M-Pesa.', index: true },
  '/privacy.html': { title: 'Privacy Policy — The Collection', description: 'How The Collection (schngor) collects, uses and protects your personal information.', index: true },
  '/terms.html': { title: 'Terms & Returns — The Collection', description: 'The rules for buying, selling and getting help, including our faulty-item policy.', index: true }
};

function baseTags() {
  return [
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<meta name="theme-color" content="#000000" />',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />'
  ];
}

function shareTags({ title, description, url, image }) {
  return [
    `<meta property="og:site_name" content="The Collection" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`
  ];
}

// The tags to add to the <head> of the page at `pathname`. Pages that already have a description keep theirs.
function headTags({ pathname, baseUrl, html = '', analyticsDomain = '' }) {
  const tags = baseTags();
  const page = PAGES[pathname];
  if (page) {
    if (!/<meta\s+name=["']description["']/i.test(html)) tags.push(`<meta name="description" content="${escapeHtml(page.description)}" />`);
    const canonical = pathname === '/index.html' ? '/' : pathname;
    tags.push(`<link rel="canonical" href="${escapeHtml(baseUrl + canonical)}" />`);
    tags.push(...shareTags({ title: page.title, description: page.description, url: baseUrl + canonical, image: `${baseUrl}/schngor-share.png` }));
  } else {
    tags.push('<meta name="robots" content="noindex, nofollow" />');
  }
  const isAdminPage = /^\/admin/.test(pathname);
  if (analyticsDomain && !isAdminPage) {
    tags.push(`<script defer data-domain="${escapeHtml(analyticsDomain)}" src="https://plausible.io/js/script.js"></script>`);
  }
  return tags.join('\n');
}

function injectHead(html, tags) {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tags}\n</head>`);
  return tags + html;
}

function absoluteUrl(value, baseUrl) {
  const text = String(value || '');
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return baseUrl + text;
  return '';
}

// A small page that gives link previews (WhatsApp, Facebook, Google) the product's name, price and photo,
// then sends real visitors to the collection with that product opened.
function productSharePage(item, baseUrl) {
  const name = String(item.name || 'Piece from The Collection');
  const price = String(item.price || '').trim();
  const caption = String(item.caption || '').trim();
  const description = [price, caption].filter(Boolean).join(' · ').slice(0, 200) || 'See this piece on The Collection.';
  const image = absoluteUrl(item.image || (Array.isArray(item.images) ? item.images[0] : ''), baseUrl) || `${baseUrl}/schngor-share.png`;
  const url = `${baseUrl}/p/${encodeURIComponent(item.id)}`;
  const target = `/?item=${encodeURIComponent(item.id)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)} — The Collection</title>
<meta name="description" content="${escapeHtml(description)}" />
${shareTags({ title: `${name} — The Collection`, description, url, image }).join('\n')}
<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}" />
<link rel="canonical" href="${escapeHtml(url)}" />
</head>
<body style="background:#000;color:#f2f2f0;font-family:sans-serif">
<p><a style="color:#f2f2f0" href="${escapeHtml(target)}">Open ${escapeHtml(name)}</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>`;
}

function robotsTxt(baseUrl) {
  return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /account.html
Disallow: /reset-password.html

Sitemap: ${baseUrl}/sitemap.xml
`;
}

function sitemapXml(baseUrl, items = []) {
  const urls = ['/', '/privacy.html', '/terms.html', ...items.filter(item => item && item.id).slice(0, 2000).map(item => `/p/${encodeURIComponent(item.id)}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url><loc>${escapeHtml(baseUrl + url)}</loc></url>`).join('\n')}
</urlset>
`;
}

module.exports = { headTags, injectHead, productSharePage, robotsTxt, sitemapXml, escapeHtml, PAGES };
