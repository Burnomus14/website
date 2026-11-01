'use strict';

// Small in-memory per-IP rate limiter (no extra dependency). Good enough for a single instance.
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const recent = times.filter(t => t > cutoff);
      if (recent.length) hits.set(key, recent); else hits.delete(key);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ success: false, message: message || 'Too many requests. Try again later.' });
    }
    hits.set(key, [...recent, now]);
    return next();
  };
}

module.exports = { createRateLimiter };
