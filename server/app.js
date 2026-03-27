const fs = require('fs');
const path = require('path');
const http = require('http');
const Busboy = require('busboy');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { pipeline } = require('stream/promises');
const { DataStore } = require('./store');
const { mergeConfig } = require('./config');
const {
  createHttpError,
  formatBytes,
  getMimeType,
  getRequestOrigin,
  isAllowedOrigin,
  hashPassword,
  parseCookies,
  randomId,
  readJsonBody,
  sanitizeFilename,
  sendJson,
  serializeCookie,
  setSecurityHeaders,
  verifyPassword,
  writeJsonAtomic
} = require('./utils');

function getClientKey(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function matchItemPath(pathname, suffix) {
  const pattern = new RegExp(`^/api/items/([a-f0-9]+)/${suffix}$`);
  return pathname.match(pattern);
}

function matchDeleteItemPath(pathname) {
  return pathname.match(/^\/api\/items\/([a-f0-9]+)$/);
}

function mapItem(item) {
  const isText = item.type === 'text';
  return {
    id: item.id,
    type: item.type,
    displayName: item.displayName,
    mime: item.mime,
    size: item.size,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    downloadCount: Number(item.downloadCount || 0),
    deletionPolicy: item.deletionPolicy,
    downloadPath: `/api/items/${item.id}/download`,
    contentPath: isText ? `/api/items/${item.id}/content` : null,
    consumePath: isText ? `/api/items/${item.id}/consume` : null
  };
}

async function createApp(config, options = {}) {
  const configPath = options.configPath || '';
  const store = new DataStore(config);
  await store.init();

  const publicDir = path.resolve(__dirname, '..', 'public');
  const sessions = new Map();
  const authLimiter = new Map();
  const apiLimiter = new Map();
  const sockets = new Set();
  let activeUploadBytes = 0;

  function cleanupLimiter(map, key, settings) {
    const now = Date.now();
    const entry = map.get(key);
    if (!entry) {
      return null;
    }
    if (entry.blockUntil && entry.blockUntil <= now) {
      entry.blockUntil = 0;
      entry.count = 0;
      entry.windowStartedAt = now;
    }
    if (entry.windowStartedAt + settings.windowMs <= now) {
      entry.count = 0;
      entry.windowStartedAt = now;
    }
    return entry;
  }

  function checkApiLimit(req) {
    const key = getClientKey(req);
    const settings = config.apiRateLimit;
    let entry = cleanupLimiter(apiLimiter, key, settings);

    if (!entry) {
      entry = { count: 0, windowStartedAt: Date.now() };
      apiLimiter.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > settings.maxRequests) {
      throw createHttpError(429, 'Too many requests. Please slow down.');
    }
  }

  function registerAuthAttempt(req, success) {
    const key = getClientKey(req);
    const settings = config.authRateLimit;
    let entry = cleanupLimiter(authLimiter, key, settings);

    if (!entry) {
      entry = { count: 0, windowStartedAt: Date.now(), blockUntil: 0 };
      authLimiter.set(key, entry);
    }

    const now = Date.now();
    if (entry.blockUntil && entry.blockUntil > now) {
      throw createHttpError(429, 'Too many failed password attempts. Please wait.');
    }

    if (success) {
      authLimiter.delete(key);
      return;
    }

    entry.count += 1;
    if (entry.count >= settings.maxAttempts) {
      entry.blockUntil = now + settings.blockMs;
      throw createHttpError(429, 'Too many failed password attempts. Please wait.');
    }
  }

  function ensureAuthAllowed(req) {
    const key = getClientKey(req);
    const entry = cleanupLimiter(authLimiter, key, config.authRateLimit);
    if (entry && entry.blockUntil && entry.blockUntil > Date.now()) {
      throw createHttpError(429, 'Too many failed password attempts. Please wait.');
    }
  }

  function touchSession(session) {
    session.expiresAt = Date.now() + config.sessionTtlMs;
    return session;
  }

  function createSessionRecord() {
    const sessionId = randomId(24);
    const session = {
      id: sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + config.sessionTtlMs,
      reauthUntil: Date.now() + config.reauthWindowMs
    };

    sessions.set(sessionId, session);
    return session;
  }

  function setSessionCookie(res, sessionId) {
    res.setHeader(
      'Set-Cookie',
      serializeCookie('float_session', sessionId, {
        path: '/',
        maxAge: config.sessionTtlMs / 1000,
        httpOnly: true,
        sameSite: 'Lax',
        secure: config.secureCookies
      })
    );
  }

  function startAuthenticatedSession(res) {
    const session = createSessionRecord();
    setSessionCookie(res, session.id);
    return session;
  }

  function getSessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies.float_session;
    if (!sessionId) {
      return null;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return null;
    }

    if (session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return null;
    }

    return touchSession(session);
  }

  function requireAuth(req) {
    const session = getSessionFromRequest(req);
    if (!session) {
      throw createHttpError(401, 'Authentication required.');
    }
    return session;
  }

  function requireReauth(session) {
    if (!session || Number(session.reauthUntil || 0) < Date.now()) {
      throw createHttpError(403, 'Settings access requires password confirmation.', 'reauth_required');
    }
  }

  function isSetupComplete() {
    return store.isOnboardingComplete();
  }

  function buildShareUrl(req) {
    const base = config.publicBaseUrl || getRequestOrigin(req);
    return base.endsWith('/') ? base : `${base}/`;
  }

  async function getSettingsPayload(req) {
    const shareUrl = buildShareUrl(req);
    const storageSummary = store.getStorageSummary();
    const shareQrSvg = await QRCode.toString(shareUrl, {
      type: 'svg',
      margin: 1,
      color: {
        dark: '#2a844a',
        light: '#0000'
      }
    });

    return {
      settings: store.getSettings(),
      storage: {
        ...storageSummary,
        usedLabel: formatBytes(storageSummary.usedBytes),
        maxLabel: formatBytes(storageSummary.maxBytes),
        perUploadLabel: formatBytes(storageSummary.maxUploadBytes)
      },
      shareUrl,
      shareQrSvg
    };
  }

  async function handleBootstrapStatus(req, res) {
    sendJson(res, 200, {
      requiresOnboarding: !isSetupComplete(),
      onboarding: store.getOnboarding()
    });
  }

  async function handleBootstrapComplete(req, res) {
    checkApiLimit(req);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }
    if (isSetupComplete()) {
      throw createHttpError(409, 'This Float room is already configured.');
    }
    if (!configPath) {
      throw createHttpError(500, 'Setup could not persist the new password.');
    }

    const body = await readJsonBody(req, 4096);
    const password = String(body.password || '');

    if (!password) {
      throw createHttpError(400, 'Password is required.');
    }

    const credentials = await hashPassword(password);
    const rawConfig = await fs.promises.readFile(configPath, 'utf8');
    const parsedConfig = rawConfig.trim() ? JSON.parse(rawConfig) : {};
    const nextConfig = mergeConfig({
      ...parsedConfig,
      passwordSalt: credentials.salt,
      passwordHash: credentials.hash
    });

    await writeJsonAtomic(configPath, nextConfig);
    config.passwordSalt = nextConfig.passwordSalt;
    config.passwordHash = nextConfig.passwordHash;

    const onboarding = await store.completeOnboarding();
    startAuthenticatedSession(res);

    sendJson(res, 200, {
      authenticated: true,
      requiresOnboarding: false,
      onboarding
    });
  }

  function broadcast(type, payload) {
    const message = JSON.stringify({ type, payload });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }

  async function pruneExpiredAndBroadcast() {
    const deleted = await store.pruneExpiredItems();
    if (!deleted.length) {
      return;
    }
    for (const item of deleted) {
      broadcast('item-deleted', { id: item.id, reason: 'expired' });
    }
  }

  async function serveStaticFile(req, res, pathname) {
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolvedPath = path.resolve(publicDir, relativePath);

    if (!resolvedPath.startsWith(publicDir)) {
      throw createHttpError(403, 'Forbidden.');
    }

    const stats = await fs.promises.stat(resolvedPath).catch(() => null);
    if (!stats || !stats.isFile()) {
      throw createHttpError(404, 'Not found.');
    }

    res.writeHead(200, {
      'Content-Type': getMimeType(resolvedPath),
      'Content-Length': stats.size,
      'Cache-Control': pathname === '/' ? 'no-store' : 'public, max-age=300'
    });

    await pipeline(fs.createReadStream(resolvedPath), res);
  }

  async function handleLogin(req, res) {
    checkApiLimit(req);
    ensureAuthAllowed(req);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }

    const body = await readJsonBody(req, 4096);
    const password = String(body.password || '');

    if (!password) {
      throw createHttpError(400, 'Password is required.');
    }

    const verified = await verifyPassword(password, config.passwordSalt, config.passwordHash);
    registerAuthAttempt(req, verified);

    if (!verified) {
      throw createHttpError(401, 'Incorrect password.');
    }

    startAuthenticatedSession(res);
    sendJson(res, 200, { authenticated: true });
  }

  async function handleReauth(req, res, session) {
    checkApiLimit(req);
    ensureAuthAllowed(req);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }

    const body = await readJsonBody(req, 4096);
    const password = String(body.password || '');

    if (!password) {
      throw createHttpError(400, 'Password is required.');
    }

    const verified = await verifyPassword(password, config.passwordSalt, config.passwordHash);
    registerAuthAttempt(req, verified);

    if (!verified) {
      throw createHttpError(401, 'Incorrect password.');
    }

    session.reauthUntil = Date.now() + config.reauthWindowMs;
    sendJson(res, 200, {
      reauthenticated: true,
      reauthUntil: session.reauthUntil
    });
  }

  async function handleListItems(req, res) {
    requireAuth(req);
    await pruneExpiredAndBroadcast();
    sendJson(res, 200, {
      items: store.getItems().map(mapItem),
      storage: store.getStorageSummary(),
      themeDefault: store.getSettings().themeDefault
    });
  }

  async function handleSettingsGet(req, res, session) {
    requireReauth(session);
    await pruneExpiredAndBroadcast();
    sendJson(res, 200, await getSettingsPayload(req));
  }

  async function handleSettingsPatch(req, res, session) {
    checkApiLimit(req);
    requireReauth(session);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }

    const body = await readJsonBody(req, 65536);
    const previousItems = store.getItems();

    await store.updateSettings({
      lifetimeMode: body.lifetimeMode,
      expiryHours: body.expiryHours,
      themeDefault: body.themeDefault
    });

    if (body.clearAllItems) {
      await store.deleteAllItems();
      for (const item of previousItems) {
        broadcast('item-deleted', { id: item.id, reason: 'cleared' });
      }
    } else {
      const currentItems = store.getItems();
      for (const item of currentItems) {
        broadcast('item-updated', { item: mapItem(item) });
      }
    }

    broadcast('settings-updated', {
      settings: store.getSettings()
    });

    sendJson(res, 200, await getSettingsPayload(req));
  }

  async function handleTextUpload(req, res) {
    checkApiLimit(req);
    requireAuth(req);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }

    const body = await readJsonBody(req, config.maxUploadBytes + 4096);
    const text = String(body.text || '');
    const displayName = sanitizeFilename(body.name || 'pasted-text.txt', 'pasted-text.txt');
    const size = Buffer.byteLength(text, 'utf8');

    if (!text.trim()) {
      throw createHttpError(400, 'Text is required.');
    }

    if (size > config.maxUploadBytes) {
      throw createHttpError(413, 'Text exceeds the maximum upload size.');
    }

    if (store.getStorageUsage() + size > config.maxStorageBytes) {
      throw createHttpError(413, 'Room storage limit reached.');
    }

    const item = await store.createTextItem({ text, displayName });
    broadcast('item-created', { item: mapItem(item) });
    sendJson(res, 201, { item: mapItem(item) });
  }

  async function handleFileUpload(req, res) {
    checkApiLimit(req);
    requireAuth(req);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      throw createHttpError(400, 'Expected multipart form upload.');
    }

    const item = await new Promise((resolve, reject) => {
      let settled = false;
      let fileSeen = false;
      let tempPath = '';
      let streamFinished = Promise.resolve();
      let tempStream = null;
      let bytes = 0;
      let reservedBytes = 0;
      let displayName = 'upload.bin';
      let mime = 'application/octet-stream';

      const releaseReserved = () => {
        if (reservedBytes > 0) {
          activeUploadBytes = Math.max(0, activeUploadBytes - reservedBytes);
          reservedBytes = 0;
        }
      };

      const cleanupTemp = async () => {
        if (!tempPath) {
          return;
        }
        await fs.promises.unlink(tempPath).catch(() => undefined);
      };

      const busboy = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fileSize: config.maxUploadBytes,
          fields: 4
        }
      });

      const fail = async (error) => {
        if (settled) {
          return;
        }
        settled = true;
        releaseReserved();
        if (tempStream) {
          tempStream.destroy();
        }
        await cleanupTemp();
        reject(error);
      };

      busboy.on('file', (fieldName, file, info) => {
        fileSeen = true;
        displayName = info.filename || 'upload.bin';
        mime = info.mimeType || 'application/octet-stream';
        tempPath = path.join(store.filesPath, `${randomId(12)}.part`);
        tempStream = fs.createWriteStream(tempPath, { flags: 'wx' });
        streamFinished = new Promise((resolveStream, rejectStream) => {
          tempStream.on('finish', resolveStream);
          tempStream.on('error', rejectStream);
        });

        file.on('data', (chunk) => {
          bytes += chunk.length;
          activeUploadBytes += chunk.length;
          reservedBytes += chunk.length;

          if (store.getStorageUsage() + activeUploadBytes > config.maxStorageBytes) {
            file.unpipe(tempStream);
            file.resume();
            busboy.destroy(createHttpError(413, 'Room storage limit reached.'));
          }
        });

        file.on('limit', () => {
          file.unpipe(tempStream);
          file.resume();
          busboy.destroy(createHttpError(413, 'File exceeds the maximum upload size.'));
        });

        file.on('error', (error) => {
          busboy.destroy(error);
        });

        tempStream.on('error', (error) => {
          busboy.destroy(error);
        });

        file.pipe(tempStream);
      });

      busboy.on('close', async () => {
        if (settled) {
          return;
        }
        if (!fileSeen) {
          await fail(createHttpError(400, 'No file was uploaded.'));
          return;
        }

        try {
          await streamFinished;
          releaseReserved();
          const item = await store.addUploadedFile({
            tempPath,
            displayName,
            mime,
            size: bytes,
            type: 'file'
          });
          settled = true;
          resolve(item);
        } catch (error) {
          await fail(error);
        }
      });

      busboy.on('error', (error) => {
        fail(error);
      });

      req.on('aborted', () => {
        busboy.destroy(createHttpError(499, 'Upload cancelled.'));
      });

      req.pipe(busboy);
    });

    broadcast('item-created', { item: mapItem(item) });
    sendJson(res, 201, { item: mapItem(item) });
  }

  async function handleDownload(req, res, itemId) {
    const session = requireAuth(req);
    if (!session) {
      throw createHttpError(401, 'Authentication required.');
    }

    await pruneExpiredAndBroadcast();
    const item = store.getItemById(itemId);
    if (!item) {
      throw createHttpError(404, 'Item not found.');
    }

    const filePath = store.getFilePath(item);
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (!stats || !stats.isFile()) {
      throw createHttpError(404, 'Item file is missing.');
    }

    const encodedName = encodeURIComponent(item.displayName).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    res.writeHead(200, {
      'Content-Type': item.mime || 'application/octet-stream',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store'
    });

    await pipeline(fs.createReadStream(filePath), res);

    await store.recordDownload(item.id);
    if (item.deletionPolicy === 'first-download') {
      await store.deleteItem(item.id);
      broadcast('item-deleted', { id: item.id, reason: 'first-download' });
      return;
    }

    const updated = store.getItemById(item.id);
    if (updated) {
      broadcast('item-updated', { item: mapItem(updated) });
    }
  }

  async function handleTextContent(req, res, itemId) {
    requireAuth(req);
    await pruneExpiredAndBroadcast();

    const item = store.getItemById(itemId);
    if (!item) {
      throw createHttpError(404, 'Item not found.');
    }
    if (item.type !== 'text') {
      throw createHttpError(400, 'Only text items can be copied.');
    }

    const filePath = store.getFilePath(item);
    let text;
    try {
      text = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw createHttpError(404, 'Text item is missing.');
      }
      throw error;
    }

    sendJson(res, 200, {
      text,
      displayName: item.displayName
    });
  }

  async function handleTextConsume(req, res, itemId) {
    checkApiLimit(req);
    requireAuth(req);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }

    await pruneExpiredAndBroadcast();
    const item = store.getItemById(itemId);
    if (!item) {
      throw createHttpError(404, 'Item not found.');
    }
    if (item.type !== 'text') {
      throw createHttpError(400, 'Only text items can be consumed this way.');
    }

    const updated = await store.recordDownload(item.id);
    if (item.deletionPolicy === 'first-download') {
      await store.deleteItem(item.id);
      broadcast('item-deleted', { id: item.id, reason: 'first-download' });
      sendJson(res, 200, {
        consumed: true,
        deleted: true
      });
      return;
    }

    broadcast('item-updated', { item: mapItem(updated) });
    sendJson(res, 200, {
      consumed: true,
      deleted: false,
      item: mapItem(updated)
    });
  }

  async function handleDeleteItem(req, res, itemId) {
    checkApiLimit(req);
    requireAuth(req);
    if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
      throw createHttpError(403, 'Origin not allowed.');
    }

    const item = await store.deleteItem(itemId);
    if (!item) {
      throw createHttpError(404, 'Item not found.');
    }

    broadcast('item-deleted', { id: item.id, reason: 'deleted' });
    sendJson(res, 200, { deleted: true });
  }

  async function routeRequest(req, res) {
    setSecurityHeaders(res);
    const requestUrl = new URL(req.url, getRequestOrigin(req));
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname === '/api/bootstrap/status') {
      await handleBootstrapStatus(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/bootstrap/complete') {
      await handleBootstrapComplete(req, res);
      return;
    }

    if (pathname.startsWith('/api/') && !isSetupComplete()) {
      throw createHttpError(
        409,
        'Finish onboarding before using this Float room.',
        'setup_required'
      );
    }

    if (req.method === 'GET' && pathname === '/') {
      await serveStaticFile(req, res, '/');
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/')) {
      if (pathname === '/api/items') {
        await handleListItems(req, res);
        return;
      }

      if (pathname === '/api/settings') {
        const session = requireAuth(req);
        await handleSettingsGet(req, res, session);
        return;
      }

      const contentMatch = matchItemPath(pathname, 'content');
      if (contentMatch) {
        await handleTextContent(req, res, contentMatch[1]);
        return;
      }

      const downloadMatch = matchItemPath(pathname, 'download');
      if (downloadMatch) {
        await handleDownload(req, res, downloadMatch[1]);
        return;
      }
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      await handleLogin(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/reauth') {
      const session = requireAuth(req);
      await handleReauth(req, res, session);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/items/file') {
      await handleFileUpload(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/items/text') {
      await handleTextUpload(req, res);
      return;
    }

    const consumeMatch = req.method === 'POST' ? matchItemPath(pathname, 'consume') : null;
    if (consumeMatch) {
      await handleTextConsume(req, res, consumeMatch[1]);
      return;
    }

    if (req.method === 'PATCH' && pathname === '/api/settings') {
      const session = requireAuth(req);
      await handleSettingsPatch(req, res, session);
      return;
    }

    if (req.method === 'DELETE') {
      const deleteMatch = matchDeleteItemPath(pathname);
      if (deleteMatch) {
        await handleDeleteItem(req, res, deleteMatch[1]);
        return;
      }
    }

    if (!pathname.startsWith('/api/')) {
      await serveStaticFile(req, res, pathname);
      return;
    }

    throw createHttpError(404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch((error) => {
      const statusCode = Number(error.statusCode || 500);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, statusCode, {
        error: error.message || 'Internal server error.',
        code: error.code || undefined
      });
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }

    if (!isSetupComplete()) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      if (!isAllowedOrigin(req, config.publicBaseUrl, config.strictOriginCheck)) {
        throw createHttpError(403, 'Origin not allowed.');
      }
      const session = requireAuth(req);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.sessionId = session.id;
        sockets.add(ws);
        ws.on('close', () => {
          sockets.delete(ws);
        });
        ws.send(
          JSON.stringify({
            type: 'connected',
            payload: {
              now: Date.now(),
              themeDefault: store.getSettings().themeDefault
            }
          })
        );
      });
    } catch (error) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  const maintenanceTimer = setInterval(async () => {
    const now = Date.now();

    for (const [sessionId, session] of sessions.entries()) {
      if (session.expiresAt <= now) {
        sessions.delete(sessionId);
      }
    }

    for (const [key, entry] of authLimiter.entries()) {
      if ((entry.blockUntil && entry.blockUntil <= now) || entry.windowStartedAt + config.authRateLimit.windowMs <= now) {
        authLimiter.delete(key);
      }
    }

    for (const [key, entry] of apiLimiter.entries()) {
      if (entry.windowStartedAt + config.apiRateLimit.windowMs <= now) {
        apiLimiter.delete(key);
      }
    }

    await pruneExpiredAndBroadcast();
  }, 30 * 1000);

  async function close() {
    clearInterval(maintenanceTimer);
    for (const socket of sockets) {
      socket.close();
    }
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    server,
    store,
    close
  };
}

module.exports = {
  createApp
};
