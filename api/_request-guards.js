const WINDOW_BUCKETS = new Map();

function getClientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown');
}

function getOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();
  if (origin) return origin;
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return '';
    }
  }
  return '';
}

function isAllowedBrowserOrigin(req) {
  const origin = getOrigin(req);
  if (!origin) return false;

  const envBase = String(process.env.APP_BASE_URL || '').trim();
  const allowed = new Set();

  if (envBase) {
    try {
      allowed.add(new URL(envBase).origin);
    } catch {
      // ignore malformed env
    }
  }

  const host = String(req.headers.host || '').trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').trim();
  if (host) allowed.add(`${proto}://${host}`);

  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    allowed.add(`http://${host}`);
  }

  return allowed.has(origin);
}

function hasSaneUserAgent(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || ua.length < 8 || ua.length > 512) return false;
  return true;
}

function enforceContentLength(req, maxBytes) {
  const n = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(n) || n <= 0) return { ok: true };
  if (n > maxBytes) return { ok: false, error: `Payload too large (max ${maxBytes} bytes)` };
  return { ok: true };
}

function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const entry = WINDOW_BUCKETS.get(key) || [];
  const kept = entry.filter((t) => now - t < windowMs);
  if (kept.length >= limit) {
    WINDOW_BUCKETS.set(key, kept);
    return { allowed: false, retryAfterMs: windowMs - (now - kept[0]) };
  }
  kept.push(now);
  WINDOW_BUCKETS.set(key, kept);
  return { allowed: true, retryAfterMs: 0 };
}

module.exports = {
  getClientIp,
  isAllowedBrowserOrigin,
  hasSaneUserAgent,
  enforceContentLength,
  rateLimit,
};
