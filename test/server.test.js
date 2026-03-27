const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createApp } = require('../server/app');
const { mergeConfig } = require('../server/config');
const { hashPassword } = require('../server/utils');

async function createFixture(overrides = {}) {
  const storagePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'float-test-'));
  const credentials = await hashPassword('bubble-pass');
  const config = mergeConfig({
    bindHost: '127.0.0.1',
    port: 0,
    storagePath,
    reauthWindowMs: 25,
    maxUploadBytes: 1024 * 1024,
    maxStorageBytes: 4 * 1024 * 1024,
    passwordSalt: credentials.salt,
    passwordHash: credentials.hash,
    ...overrides
  });

  const app = await createApp(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let cookie = '';

  async function request(pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    if (cookie) {
      headers.set('Cookie', cookie);
    }

    const response = await fetch(`${baseUrl}${pathname}`, {
      redirect: 'manual',
      ...options,
      headers
    });

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
    }

    return response;
  }

  async function login(password = 'bubble-pass') {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password })
    });

    return response;
  }

  async function close() {
    await app.close();
    await fs.promises.rm(storagePath, { recursive: true, force: true });
  }

  return {
    app,
    baseUrl,
    close,
    login,
    request,
    storagePath,
    getCookie: () => cookie
  };
}

function waitForSocketMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 3000);

    const handleMessage = (raw) => {
      const packet = JSON.parse(raw.toString());
      if (packet.type === type) {
        clearTimeout(timer);
        socket.off('message', handleMessage);
        resolve(packet.payload);
      }
    };

    socket.on('message', handleMessage);
  });
}

async function waitFor(assertion) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < 2000) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  throw lastError;
}

test('login protects the room and sets a session cookie', async () => {
  const fixture = await createFixture();

  try {
    let response = await fixture.request('/api/items');
    assert.equal(response.status, 401);

    response = await fixture.login('wrong-pass');
    assert.equal(response.status, 401);

    response = await fixture.login();
    assert.equal(response.status, 200);
    assert.match(fixture.getCookie(), /^float_session=/);

    response = await fixture.request('/api/items');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.items, []);
  } finally {
    await fixture.close();
  }
});

test('text upload broadcasts live updates and increments download counts', async () => {
  const fixture = await createFixture();

  try {
    await fixture.login();

    const socket = new WebSocket(`${fixture.baseUrl.replace('http', 'ws')}/ws`, {
      headers: {
        Cookie: fixture.getCookie()
      }
    });

    await waitForSocketMessage(socket, 'connected');

    const createdPromise = waitForSocketMessage(socket, 'item-created');
    let response = await fixture.request('/api/items/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'note.txt',
        text: 'hello from the bubble'
      })
    });

    assert.equal(response.status, 201);
    const created = await createdPromise;
    assert.equal(created.item.displayName, 'note.txt');

    response = await fixture.request(created.item.downloadPath);
    assert.equal(response.status, 200);
    const downloadedText = await response.text();
    assert.equal(downloadedText, 'hello from the bubble');

    const updated = await waitForSocketMessage(socket, 'item-updated');
    assert.equal(updated.item.downloadCount, 1);
    socket.close();
  } finally {
    await fixture.close();
  }
});

test('settings require reauth and lifetime policies affect stored items', async () => {
  const fixture = await createFixture({
    reauthWindowMs: 60
  });

  try {
    await fixture.login();
    await new Promise((resolve) => setTimeout(resolve, 90));

    let response = await fixture.request('/api/settings');
    assert.equal(response.status, 403);

    response = await fixture.request('/api/auth/reauth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        password: 'bubble-pass'
      })
    });
    assert.equal(response.status, 200);

    response = await fixture.request('/api/settings', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        lifetimeMode: 'first-download',
        expiryHours: 24,
        themeDefault: 'dark'
      })
    });
    assert.equal(response.status, 200);

    const form = new FormData();
    form.append('file', new Blob(['sample file']), 'sample.txt');
    response = await fixture.request('/api/items/file', {
      method: 'POST',
      body: form
    });
    assert.equal(response.status, 201);
    const uploadPayload = await response.json();

    response = await fixture.request(uploadPayload.item.downloadPath);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'sample file');

    await waitFor(async () => {
      const itemsResponse = await fixture.request('/api/items');
      const afterDownload = await itemsResponse.json();
      assert.equal(afterDownload.items.length, 0);
    });

    response = await fixture.request('/api/auth/reauth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        password: 'bubble-pass'
      })
    });
    assert.equal(response.status, 200);

    response = await fixture.request('/api/settings', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        lifetimeMode: 'expiry',
        expiryHours: 1,
        themeDefault: 'auto'
      })
    });
    assert.equal(response.status, 200);

    response = await fixture.request('/api/items/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'expiring.txt',
        text: 'bye'
      })
    });
    assert.equal(response.status, 201);
    const textPayload = await response.json();
    const storedItem = fixture.app.store.getItemById(textPayload.item.id);
    storedItem.expiresAt = new Date(Date.now() - 5000).toISOString();
    await fixture.app.store.persist();

    response = await fixture.request('/api/items');
    const afterExpiry = await response.json();
    assert.equal(afterExpiry.items.length, 0);
  } finally {
    await fixture.close();
  }
});
