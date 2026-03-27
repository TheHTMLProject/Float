const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function randomId(size = 16) {
  return crypto.randomBytes(size).toString('hex');
}

function sanitizeFilename(input, fallback = 'item') {
  const raw = String(input || '')
    .normalize('NFKD')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:"*?<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const base = raw || fallback;
  const shortened = base.slice(0, 140).trim();
  return shortened || fallback;
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index === -1) {
        return cookies;
      }
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }

  return parts.join('; ');
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text));
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': body.length
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
}

function createHttpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code || undefined;
  return error;
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(createHttpError(413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        resolve(parsed);
      } catch (error) {
        reject(createHttpError(400, 'Invalid JSON body.'));
      }
    });

    req.on('error', reject);
  });
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString('hex'));
    });
  });
}

async function hashPassword(password) {
  const salt = randomId(16);
  const hash = await scryptHash(password, salt);
  return { salt, hash };
}

async function verifyPassword(password, salt, expectedHash) {
  const actualHash = await scryptHash(password, salt);
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(actualHash, 'hex');
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

async function ensureDir(directoryPath) {
  await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function writeJsonAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2));
  await fs.promises.rename(tempPath, filePath);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const fixed = size >= 10 || index === 0 ? 0 : 1;
  return `${size.toFixed(fixed)} ${units[index]}`;
}

function getRequestProtocol(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.encrypted ? 'https' : 'http';
}

function getRequestHost(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  if (typeof forwardedHost === 'string' && forwardedHost.trim()) {
    return forwardedHost.split(',')[0].trim();
  }
  return req.headers.host || 'localhost';
}

function getRequestOrigin(req) {
  return `${getRequestProtocol(req)}://${getRequestHost(req)}`;
}

function isAllowedOrigin(req, configuredBaseUrl) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  let incomingOrigin;
  try {
    incomingOrigin = new URL(origin);
  } catch (error) {
    return false;
  }

  const allowed = [getRequestOrigin(req)];

  if (configuredBaseUrl) {
    try {
      allowed.push(new URL(configuredBaseUrl).origin);
    } catch (error) {
      return false;
    }
  }

  return allowed.some((candidate) => {
    try {
      const parsedCandidate = new URL(candidate);
      return (
        parsedCandidate.origin === incomingOrigin.origin ||
        parsedCandidate.host === incomingOrigin.host
      );
    } catch (error) {
      return false;
    }
  });
}

function toIsoTimestamp(value) {
  return new Date(value).toISOString();
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon'
  };
  return types[ext] || 'application/octet-stream';
}

function normalizeLifetimeMode(value, fallback = 'manual') {
  return ['manual', 'first-download', 'expiry'].includes(value) ? value : fallback;
}

function normalizeTheme(value, fallback = 'auto') {
  return ['auto', 'light', 'dark'].includes(value) ? value : fallback;
}

module.exports = {
  createHttpError,
  ensureDir,
  formatBytes,
  getMimeType,
  getRequestHost,
  getRequestOrigin,
  getRequestProtocol,
  hashPassword,
  isAllowedOrigin,
  normalizeLifetimeMode,
  normalizeTheme,
  parseCookies,
  randomId,
  readJsonBody,
  sanitizeFilename,
  sendJson,
  sendText,
  serializeCookie,
  setSecurityHeaders,
  toIsoTimestamp,
  verifyPassword,
  writeJsonAtomic
};
