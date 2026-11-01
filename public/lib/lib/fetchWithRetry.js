'use strict';

// fetch with a timeout and optional retries (exponential backoff + jitter).
// Only set retries > 0 for calls that are safe to repeat (reads). Never retry a payment request.
async function fetchWithRetry(url, options = {}, { timeoutMs = 15000, retries = 0, baseDelayMs = 400 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) return response;
      lastError = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    } catch (error) {
      lastError = error.name === 'TimeoutError'
        ? new Error(`Request to ${new URL(url).host} timed out after ${Math.round(timeoutMs / 1000)}s`)
        : error;
      if (attempt === retries) throw lastError;
    }
    const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
    console.warn(`Retrying ${new URL(url).host} in ${Math.round(delay)}ms (attempt ${attempt + 1} of ${retries}): ${lastError.message}`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw lastError;
}

module.exports = { fetchWithRetry };
