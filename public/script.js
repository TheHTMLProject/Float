(function () {
  const state = {
    authenticated: false,
    items: new Map(),
    socket: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    themeDefault: 'auto',
    motion: new Map(),
    animationFrame: 0,
    reducedMotionQuery: window.matchMedia('(prefers-reduced-motion: reduce)')
  };

  const elements = {
    addChip: document.getElementById('add-chip'),
    bubbleCopy: document.getElementById('bubble-copy'),
    bubbleEmpty: document.getElementById('bubble-empty'),
    bubbleHint: document.getElementById('bubble-hint'),
    bubbleItems: document.getElementById('bubble-items'),
    bubbleStage: document.getElementById('bubble-stage'),
    clearBubble: document.getElementById('clear-bubble'),
    dropHalo: document.getElementById('drop-halo'),
    fileInput: document.getElementById('file-input'),
    lifetimeMode: document.getElementById('lifetime-mode'),
    lockOverlay: document.getElementById('lock-overlay'),
    loginForm: document.getElementById('login-form'),
    loginPassword: document.getElementById('login-password'),
    loginStatus: document.getElementById('login-status'),
    loginSubmit: document.getElementById('login-submit'),
    mobilePasteText: document.getElementById('mobile-paste-text'),
    mobileSheet: document.getElementById('mobile-sheet'),
    mobileUploadFile: document.getElementById('mobile-upload-file'),
    pasteForm: document.getElementById('paste-form'),
    pasteName: document.getElementById('paste-name'),
    pasteSheet: document.getElementById('paste-sheet'),
    pasteStatus: document.getElementById('paste-status'),
    pasteSubmit: document.getElementById('paste-submit'),
    pasteText: document.getElementById('paste-text'),
    reauthForm: document.getElementById('reauth-form'),
    reauthPassword: document.getElementById('reauth-password'),
    reauthStatus: document.getElementById('reauth-status'),
    reauthSubmit: document.getElementById('reauth-submit'),
    refreshSettings: document.getElementById('refresh-settings'),
    roomNote: document.getElementById('room-note'),
    saveSettings: document.getElementById('save-settings'),
    settingsChip: document.getElementById('settings-chip'),
    settingsClose: document.getElementById('settings-close'),
    settingsContent: document.getElementById('settings-content'),
    settingsForm: document.getElementById('settings-form'),
    settingsLock: document.getElementById('settings-lock'),
    settingsModal: document.getElementById('settings-modal'),
    settingsStatus: document.getElementById('settings-status'),
    shareQr: document.getElementById('share-qr'),
    shareUrl: document.getElementById('share-url'),
    storageDetail: document.getElementById('storage-detail'),
    storageSummary: document.getElementById('storage-summary'),
    themeDefault: document.getElementById('theme-default'),
    toastStack: document.getElementById('toast-stack'),
    uploadLimit: document.getElementById('upload-limit'),
    expiryHours: document.getElementById('expiry-hours')
  };

  function isMobileSurface() {
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 820;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function hashUnit(value) {
    return hashString(value) / 4294967295;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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

  function formatWhen(isoValue) {
    if (!isoValue) {
      return 'Now';
    }
    const delta = Date.now() - new Date(isoValue).getTime();
    const minutes = Math.round(Math.abs(delta) / 60000);
    if (minutes < 1) {
      return 'Now';
    }
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    const days = Math.round(hours / 24);
    return `${days}d`;
  }

  function formatInteractionCount(item) {
    const count = Number(item.downloadCount || 0);
    if (item.type === 'text') {
      return `${count} ${count === 1 ? 'copy' : 'copies'}`;
    }
    return `${count} ${count === 1 ? 'download' : 'downloads'}`;
  }

  function createTextFilename() {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0')
    ].join('-');
    return `pasted-${stamp}.txt`;
  }

  function setInlineStatus(element, message, tone) {
    element.textContent = message || '';
    element.classList.remove('is-error', 'is-success');
    if (tone) {
      element.classList.add(tone === 'error' ? 'is-error' : 'is-success');
    }
  }

  function showToast(message, tone) {
    const toast = document.createElement('div');
    toast.className = `toast${tone === 'error' ? ' is-error' : ''}`;
    toast.textContent = message;
    elements.toastStack.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 3200);
  }

  function setTheme(mode) {
    state.themeDefault = ['light', 'dark', 'auto'].includes(mode) ? mode : 'auto';
    document.documentElement.setAttribute('data-theme', state.themeDefault);
  }

  function setRoomNote(message) {
    elements.roomNote.textContent = message;
  }

  function setRoomOpenNote() {
    setRoomNote('Bubble open. Uploads, copies, and downloads stay live across devices.');
  }

  async function apiRequest(url, options) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const error = new Error(payload.error || 'Request failed.');
      error.status = response.status;
      error.code = payload.code;
      throw error;
    }

    return payload;
  }

  function openSettingsModal() {
    if (!state.authenticated) {
      elements.loginPassword.focus();
      return;
    }

    closeSheet(elements.mobileSheet);
    closeSheet(elements.pasteSheet);
    elements.settingsModal.classList.remove('hidden');
    elements.settingsModal.setAttribute('aria-hidden', 'false');
    elements.settingsLock.classList.remove('hidden');
    elements.settingsContent.classList.add('hidden');
    elements.reauthPassword.value = '';
    setInlineStatus(elements.reauthStatus, '');
    setInlineStatus(elements.settingsStatus, '');
    window.setTimeout(() => {
      elements.reauthPassword.focus();
    }, 60);
  }

  function closeSettingsModal() {
    elements.settingsModal.classList.add('hidden');
    elements.settingsModal.setAttribute('aria-hidden', 'true');
  }

  function openSheet(sheet) {
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeSheet(sheet) {
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }

  function updateBubbleCopy() {
    const count = state.items.size;
    if (!state.authenticated) {
      elements.bubbleHint.textContent = 'Enter the room password to upload, paste, copy, and download.';
      return;
    }
    if (!count) {
      elements.bubbleHint.textContent = isMobileSurface()
        ? 'Tap the bubble to upload a file or paste copied text.'
        : 'Drag files into the bubble, paste copied text, or use Add.';
      return;
    }
    const noun = count === 1 ? 'item is' : 'items are';
    elements.bubbleHint.textContent = `${count} ${noun} drifting inside the room.`;
  }

  function createHomePosition(index, total, seedA, seedB, seedC, seedD) {
    const goldenAngle = 2.399963229728653;
    const copyBias = isMobileSurface() ? 0 : clamp(0.22 - total * 0.017, 0, 0.14);

    if (total <= 1) {
      return {
        x: isMobileSurface() ? 0.04 : 0.24,
        y: 0.06
      };
    }

    const radius = Math.sqrt((index + 0.65) / (total + 0.35)) * 0.84;
    const angle = goldenAngle * (index + 1) + seedA * 0.9;
    const x =
      Math.cos(angle) * radius * (0.76 + seedB * 0.12) +
      (seedC - 0.5) * 0.11 +
      copyBias;
    const y =
      Math.sin(angle) * radius * (0.58 + seedD * 0.14) +
      (seedA - 0.5) * 0.12 +
      0.04;

    return {
      x: clamp(x, -0.72, 0.78),
      y: clamp(y, -0.64, 0.72)
    };
  }

  function clampToBubble(x, y, insetX, insetY) {
    const limitX = Math.max(0.12, 1 - insetX);
    const limitY = Math.max(0.14, 1 - insetY);
    let nextX = clamp(x, -limitX, limitX);
    let nextY = clamp(y, -limitY, limitY);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scaledX = nextX / limitX;
      const scaledY = nextY / limitY;
      const topPinch = scaledY < -0.14 ? Math.abs(scaledY + 0.14) * 0.34 : 0;
      const lowerBulge = scaledY > 0.12 ? scaledY * 0.1 : 0;
      const skewX = scaledX * (0.92 - lowerBulge) + scaledY * 0.08;
      const skewY = scaledY * (1.05 + topPinch) - scaledX * 0.04;
      const score = skewX * skewX + skewY * skewY;

      if (score <= 1) {
        break;
      }

      const scale = 0.985 / Math.sqrt(score);
      nextX *= scale;
      nextY *= scale;
    }

    return {
      x: nextX,
      y: nextY
    };
  }

  function createMotionProfile(item, index, total) {
    const seedA = hashUnit(`${item.id}:a`);
    const seedB = hashUnit(`${item.id}:b`);
    const seedC = hashUnit(`${item.id}:c`);
    const seedD = hashUnit(`${item.id}:d`);
    const seedE = hashUnit(`${item.id}:e`);
    const seedF = hashUnit(`${item.id}:f`);
    const mobileScale = isMobileSurface() ? 0.82 : 1;
    const crowdScale = total > 6 ? Math.max(0.5, 1 - (total - 6) * 0.048) : 1;
    const size = Math.round(
      (90 + Math.min(46, Math.log2((item.size || 1) + 2) * 6) + seedA * 16) *
        mobileScale *
        crowdScale
    );
    const home = createHomePosition(index, total, seedA, seedB, seedC, seedD);

    return {
      size,
      width: size,
      height: Math.round(size * (0.56 + seedB * 0.08)),
      homeX: home.x,
      homeY: home.y,
      driftXAmplitude: 0.016 + seedC * 0.022,
      driftYAmplitude: 0.012 + seedD * 0.02,
      driftXSpeed: 0.00008 + seedE * 0.00005,
      driftYSpeed: 0.00006 + seedA * 0.00005,
      driftXPhase: seedB * Math.PI * 2,
      driftYPhase: seedC * Math.PI * 2,
      bobAmplitude: 0.012 + seedF * 0.02,
      bobSpeed: 0.00014 + seedD * 0.00008,
      bobPhase: seedA * Math.PI * 2,
      tiltAmplitude: 0.8 + seedB * 1.4,
      tiltSpeed: 0.0001 + seedC * 0.00008,
      tiltPhase: seedD * Math.PI * 2
    };
  }

  function createItemElement(item, total, index) {
    const motion = createMotionProfile(item, index, total);
    state.motion.set(item.id, motion);

    const article = document.createElement('article');
    article.className = `bubble-item${item.type === 'text' ? ' kind-text' : ''}`;
    article.dataset.itemId = item.id;
    article.style.setProperty('--orb-size', `${motion.size}px`);

    const mainButton = document.createElement('button');
    mainButton.className = 'bubble-item-main';
    mainButton.type = 'button';
    mainButton.dataset.action = 'download';
    mainButton.dataset.itemId = item.id;
    mainButton.title = item.type === 'text' ? 'Copy to clipboard' : 'Download';
    mainButton.setAttribute(
      'aria-label',
      item.type === 'text'
        ? `Copy ${item.displayName} to the clipboard`
        : `Download ${item.displayName}`
    );

    const type = document.createElement('span');
    type.className = 'bubble-item-type';
    type.textContent = item.type === 'text' ? 'Text' : 'File';

    const name = document.createElement('strong');
    name.className = 'bubble-item-name';
    name.textContent = item.displayName;

    const meta = document.createElement('div');
    meta.className = 'bubble-item-meta';
    meta.innerHTML = [
      `<span>${item.type === 'text' ? 'Tap to copy' : 'Tap to download'}</span>`,
      `<span>${formatBytes(item.size)}</span>`,
      `<span>${formatInteractionCount(item)}</span>`,
      `<span>${formatWhen(item.createdAt)}</span>`
    ].join('');

    mainButton.append(type, name, meta);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'bubble-item-delete';
    deleteButton.type = 'button';
    deleteButton.dataset.action = 'delete';
    deleteButton.dataset.itemId = item.id;
    deleteButton.setAttribute('aria-label', `Delete ${item.displayName}`);

    article.append(mainButton, deleteButton);
    return article;
  }

  function renderItems() {
    const items = Array.from(state.items.values()).sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

    state.motion.clear();
    elements.bubbleItems.replaceChildren(...items.map((item, index) => createItemElement(item, items.length, index)));
    elements.bubbleEmpty.classList.toggle('hidden-empty', items.length > 0);
    updateBubbleCopy();

    window.requestAnimationFrame(() => {
      for (const node of elements.bubbleItems.children) {
        const itemId = node.dataset.itemId;
        const motion = state.motion.get(itemId);
        if (motion) {
          motion.width = node.offsetWidth || motion.width;
          motion.height = node.offsetHeight || motion.height;
        }
      }
    });
  }

  function positionItems(timestamp) {
    const rect = elements.bubbleStage.getBoundingClientRect();
    const centerX = rect.width * (isMobileSurface() ? 0.5 : 0.52);
    const centerY = rect.height * 0.53;
    const spanX = rect.width * 0.35;
    const spanY = rect.height * 0.37;
    const reducedMotion = state.reducedMotionQuery.matches;

    for (const node of elements.bubbleItems.children) {
      const motion = state.motion.get(node.dataset.itemId);
      if (!motion) {
        continue;
      }

      const driftX = reducedMotion
        ? 0
        : Math.sin(timestamp * motion.driftXSpeed + motion.driftXPhase) * motion.driftXAmplitude;
      const driftY = reducedMotion
        ? 0
        : Math.cos(timestamp * motion.driftYSpeed + motion.driftYPhase) * motion.driftYAmplitude;
      const bob = reducedMotion
        ? 0
        : Math.sin(timestamp * motion.bobSpeed + motion.bobPhase) * motion.bobAmplitude;
      const tilt = reducedMotion
        ? 0
        : Math.sin(timestamp * motion.tiltSpeed + motion.tiltPhase) * motion.tiltAmplitude;
      const insetX = clamp((motion.width / 2 + 18) / spanX, 0.12, 0.42);
      const insetY = clamp((motion.height / 2 + 16) / spanY, 0.14, 0.46);
      const clamped = clampToBubble(
        motion.homeX + driftX,
        motion.homeY + driftY + bob,
        insetX,
        insetY
      );
      const x = centerX + clamped.x * spanX - motion.width / 2;
      const y = centerY + clamped.y * spanY - motion.height / 2;

      node.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${tilt}deg)`;
    }

    state.animationFrame = window.requestAnimationFrame(positionItems);
  }

  function ensureAnimationLoop() {
    if (state.animationFrame) {
      window.cancelAnimationFrame(state.animationFrame);
    }
    state.animationFrame = window.requestAnimationFrame(positionItems);
  }

  function setAuthenticated(authenticated) {
    state.authenticated = authenticated;
    elements.lockOverlay.classList.toggle('hidden', authenticated);
    elements.addChip.disabled = !authenticated;
    elements.settingsChip.disabled = !authenticated;

    if (!authenticated) {
      state.items.clear();
      renderItems();
      setRoomNote('Bubble locked. Enter the room password to begin.');
    } else {
      setRoomOpenNote();
    }

    updateBubbleCopy();
  }

  function mergeItem(item) {
    state.items.set(item.id, item);
    renderItems();
  }

  function removeItem(itemId) {
    state.items.delete(itemId);
    renderItems();
  }

  async function refreshRoom() {
    const payload = await apiRequest('/api/items');
    state.items = new Map(payload.items.map((item) => [item.id, item]));
    setTheme(payload.themeDefault || state.themeDefault || 'auto');
    renderItems();
    setAuthenticated(true);
  }

  function lockRoom(message) {
    setAuthenticated(false);
    closeSettingsModal();
    closeSheet(elements.mobileSheet);
    closeSheet(elements.pasteSheet);
    if (state.socket) {
      state.socket.close();
      state.socket = null;
    }
    if (message) {
      setInlineStatus(elements.loginStatus, message, 'error');
    }
  }

  function connectSocket() {
    if (!state.authenticated) {
      return;
    }

    if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    state.socket = socket;

    socket.addEventListener('open', async () => {
      state.reconnectDelay = 1000;
      try {
        await refreshRoom();
      } catch (error) {
        if (error.status === 401) {
          lockRoom('Session expired. Enter the room password again.');
        }
      }
    });

    socket.addEventListener('message', (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.type === 'item-created' && packet.payload && packet.payload.item) {
          mergeItem(packet.payload.item);
          return;
        }
        if (packet.type === 'item-updated' && packet.payload && packet.payload.item) {
          mergeItem(packet.payload.item);
          return;
        }
        if (packet.type === 'item-deleted' && packet.payload && packet.payload.id) {
          removeItem(packet.payload.id);
          return;
        }
        if (packet.type === 'settings-updated' && packet.payload && packet.payload.settings) {
          setTheme(packet.payload.settings.themeDefault || 'auto');
          if (!elements.settingsModal.classList.contains('hidden') && !elements.settingsContent.classList.contains('hidden')) {
            loadSettings();
          }
        }
      } catch (error) {
        showToast('A live update could not be parsed.', 'error');
      }
    });

    socket.addEventListener('close', () => {
      if (!state.authenticated) {
        return;
      }
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = window.setTimeout(() => {
        connectSocket();
      }, state.reconnectDelay);
      state.reconnectDelay = Math.min(state.reconnectDelay * 1.8, 10000);
    });
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    setInlineStatus(elements.loginStatus, '');
    elements.loginSubmit.disabled = true;

    try {
      await apiRequest('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          password: elements.loginPassword.value
        })
      });

      elements.loginPassword.value = '';
      await refreshRoom();
      connectSocket();
      showToast('Bubble unlocked.');
    } catch (error) {
      setAuthenticated(false);
      setInlineStatus(elements.loginStatus, error.message, 'error');
    } finally {
      elements.loginSubmit.disabled = false;
    }
  }

  async function uploadFiles(files) {
    if (!state.authenticated || !files.length) {
      return;
    }

    setRoomNote(files.length === 1 ? 'Uploading 1 item...' : `Uploading ${files.length} items...`);
    let successCount = 0;

    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file, file.name);

      try {
        const payload = await apiRequest('/api/items/file', {
          method: 'POST',
          body: formData
        });
        mergeItem(payload.item);
        successCount += 1;
      } catch (error) {
        showToast(error.message || `Could not upload ${file.name}.`, 'error');
      }
    }

    setRoomOpenNote();
    if (successCount) {
      showToast(successCount === 1 ? '1 item is now floating.' : `${successCount} items are now floating.`);
    }
  }

  async function uploadText(text, name) {
    if (!state.authenticated) {
      return;
    }

    setRoomNote('Floating text into the room...');
    try {
      const payload = await apiRequest('/api/items/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          name
        })
      });
      mergeItem(payload.item);
      showToast('Text is now floating.');
      setRoomOpenNote();
      return payload.item;
    } catch (error) {
      setRoomOpenNote();
      showToast(error.message || 'Text could not be uploaded.', 'error');
      throw error;
    }
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
      }
    }

    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', 'true');
    helper.style.position = 'fixed';
    helper.style.top = '0';
    helper.style.left = '-9999px';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.focus();
    helper.select();
    helper.setSelectionRange(0, helper.value.length);

    let copied = false;
    try {
      copied = Boolean(document.execCommand && document.execCommand('copy'));
    } finally {
      helper.remove();
    }

    if (!copied) {
      throw new Error('Clipboard access is unavailable on this device.');
    }
  }

  async function copyTextItem(item) {
    setRoomNote('Copying text...');

    try {
      const payload = await apiRequest(item.contentPath || `/api/items/${item.id}/content`);
      await copyTextToClipboard(payload.text || '');

      let consumeError = null;
      try {
        const consumePayload = await apiRequest(item.consumePath || `/api/items/${item.id}/consume`, {
          method: 'POST'
        });
        if (consumePayload.deleted) {
          removeItem(item.id);
        } else if (consumePayload.item) {
          mergeItem(consumePayload.item);
        }
      } catch (error) {
        consumeError = error;
        if (error.status === 401) {
          lockRoom('Session expired. Enter the room password again.');
        } else if (error.status === 404) {
          removeItem(item.id);
        }
      }

      showToast(`${payload.displayName || item.displayName} copied to the clipboard.`);
      if (consumeError) {
        showToast('Clipboard copy worked, but the room could not confirm it.', 'error');
      }
    } catch (error) {
      if (error.status === 401) {
        lockRoom('Session expired. Enter the room password again.');
      } else {
        showToast(error.message || 'Text could not be copied.', 'error');
      }
    } finally {
      if (state.authenticated) {
        setRoomOpenNote();
      }
    }
  }

  async function handlePasteEvent(event) {
    if (!state.authenticated) {
      return;
    }

    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) {
      return;
    }

    const clipboard = event.clipboardData;
    if (!clipboard) {
      return;
    }

    const fileItems = Array.from(clipboard.items || []).filter((item) => item.kind === 'file');
    if (fileItems.length) {
      event.preventDefault();
      await uploadFiles(
        fileItems
          .map((item) => item.getAsFile())
          .filter(Boolean)
      );
      return;
    }

    const text = clipboard.getData('text/plain');
    if (text && text.trim()) {
      event.preventDefault();
      await uploadText(text, createTextFilename());
    }
  }

  async function handleBubbleAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button) {
      return;
    }

    const itemId = button.dataset.itemId;
    const action = button.dataset.action;
    const item = state.items.get(itemId);
    if (!item) {
      return;
    }

    event.stopPropagation();

    if (action === 'download') {
      if (item.type === 'text') {
        button.disabled = true;
        try {
          await copyTextItem(item);
        } finally {
          button.disabled = false;
        }
        return;
      }

      window.location.href = item.downloadPath;
      return;
    }

    if (action === 'delete') {
      button.disabled = true;
      try {
        await apiRequest(`/api/items/${itemId}`, {
          method: 'DELETE'
        });
        removeItem(itemId);
        showToast(`${item.displayName} removed.`);
      } catch (error) {
        showToast(error.message || 'Item could not be removed.', 'error');
      } finally {
        button.disabled = false;
      }
    }
  }

  async function loadSettings() {
    try {
      const payload = await apiRequest('/api/settings');
      elements.settingsLock.classList.add('hidden');
      elements.settingsContent.classList.remove('hidden');
      elements.lifetimeMode.value = payload.settings.lifetimeMode;
      elements.expiryHours.value = payload.settings.expiryHours;
      elements.themeDefault.value = payload.settings.themeDefault;
      elements.storageSummary.textContent = `${payload.storage.usedLabel} of ${payload.storage.maxLabel}`;
      elements.storageDetail.textContent = `${payload.storage.itemCount} floating items`;
      elements.uploadLimit.textContent = payload.storage.perUploadLabel;
      elements.shareUrl.href = payload.shareUrl;
      elements.shareUrl.textContent = payload.shareUrl;
      elements.shareQr.innerHTML = payload.shareQrSvg;
      setTheme(payload.settings.themeDefault || 'auto');
      setInlineStatus(elements.settingsStatus, '');
      return payload;
    } catch (error) {
      if (error.code === 'reauth_required' || error.status === 403) {
        elements.settingsLock.classList.remove('hidden');
        elements.settingsContent.classList.add('hidden');
        setInlineStatus(elements.reauthStatus, 'Password confirmation expired. Enter it again.', 'error');
        return null;
      }
      throw error;
    }
  }

  async function handleReauthSubmit(event) {
    event.preventDefault();
    elements.reauthSubmit.disabled = true;
    setInlineStatus(elements.reauthStatus, '');

    try {
      await apiRequest('/api/auth/reauth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          password: elements.reauthPassword.value
        })
      });

      elements.reauthPassword.value = '';
      await loadSettings();
      showToast('Settings unlocked.');
    } catch (error) {
      setInlineStatus(elements.reauthStatus, error.message, 'error');
    } finally {
      elements.reauthSubmit.disabled = false;
    }
  }

  async function handleSettingsSave(event) {
    event.preventDefault();
    elements.saveSettings.disabled = true;
    setInlineStatus(elements.settingsStatus, '');

    try {
      const payload = await apiRequest('/api/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          lifetimeMode: elements.lifetimeMode.value,
          expiryHours: Number(elements.expiryHours.value || 24),
          themeDefault: elements.themeDefault.value
        })
      });
      setTheme(payload.settings.themeDefault || 'auto');
      setInlineStatus(elements.settingsStatus, 'Room settings saved.', 'success');
      await refreshRoom();
      await loadSettings();
      showToast('Bubble behavior updated.');
    } catch (error) {
      if (error.code === 'reauth_required') {
        elements.settingsLock.classList.remove('hidden');
        elements.settingsContent.classList.add('hidden');
        setInlineStatus(elements.reauthStatus, 'Password confirmation expired. Enter it again.', 'error');
      } else {
        setInlineStatus(elements.settingsStatus, error.message, 'error');
      }
    } finally {
      elements.saveSettings.disabled = false;
    }
  }

  async function clearBubble() {
    if (!state.items.size) {
      showToast('The bubble is already empty.');
      return;
    }

    if (!window.confirm('Clear every floating item from this room?')) {
      return;
    }

    elements.clearBubble.disabled = true;
    setInlineStatus(elements.settingsStatus, '');

    try {
      await apiRequest('/api/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          lifetimeMode: elements.lifetimeMode.value,
          expiryHours: Number(elements.expiryHours.value || 24),
          themeDefault: elements.themeDefault.value,
          clearAllItems: true
        })
      });
      state.items.clear();
      renderItems();
      await loadSettings();
      setInlineStatus(elements.settingsStatus, 'Bubble cleared.', 'success');
      showToast('Bubble cleared.');
    } catch (error) {
      setInlineStatus(elements.settingsStatus, error.message, 'error');
    } finally {
      elements.clearBubble.disabled = false;
    }
  }

  async function openPasteSheet(prefillText) {
    closeSheet(elements.mobileSheet);
    elements.pasteStatus.textContent = '';
    elements.pasteName.value = createTextFilename();
    elements.pasteText.value = prefillText || '';
    openSheet(elements.pasteSheet);
    window.setTimeout(() => {
      if (prefillText) {
        elements.pasteName.focus();
      } else {
        elements.pasteText.focus();
      }
    }, 40);
  }

  async function handlePasteShortcut() {
    let clipboardText = '';

    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch (error) {
        clipboardText = '';
      }
    }

    await openPasteSheet(clipboardText);
  }

  function handleStageClick(event) {
    if (!state.authenticated) {
      elements.loginPassword.focus();
      return;
    }

    if (event.target.closest('.bubble-item')) {
      return;
    }

    if (isMobileSurface()) {
      openSheet(elements.mobileSheet);
    }
  }

  function bindEvents() {
    elements.loginForm.addEventListener('submit', handleLoginSubmit);
    elements.reauthForm.addEventListener('submit', handleReauthSubmit);
    elements.settingsForm.addEventListener('submit', handleSettingsSave);
    elements.clearBubble.addEventListener('click', clearBubble);
    elements.settingsChip.addEventListener('click', openSettingsModal);
    elements.settingsClose.addEventListener('click', closeSettingsModal);
    elements.refreshSettings.addEventListener('click', loadSettings);
    elements.addChip.addEventListener('click', () => {
      if (!state.authenticated) {
        elements.loginPassword.focus();
        return;
      }
      openSheet(elements.mobileSheet);
    });
    elements.mobileUploadFile.addEventListener('click', () => {
      closeSheet(elements.mobileSheet);
      elements.fileInput.click();
    });
    elements.mobilePasteText.addEventListener('click', handlePasteShortcut);
    elements.pasteForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      elements.pasteSubmit.disabled = true;
      setInlineStatus(elements.pasteStatus, '');

      try {
        await uploadText(elements.pasteText.value, elements.pasteName.value || createTextFilename());
        closeSheet(elements.pasteSheet);
        elements.pasteForm.reset();
        elements.pasteName.value = createTextFilename();
      } catch (error) {
        setInlineStatus(elements.pasteStatus, error.message, 'error');
      } finally {
        elements.pasteSubmit.disabled = false;
      }
    });
    elements.fileInput.addEventListener('change', async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      await uploadFiles(files);
    });
    elements.bubbleItems.addEventListener('click', handleBubbleAction);
    elements.bubbleStage.addEventListener('click', handleStageClick);
    elements.bubbleStage.addEventListener('dragenter', (event) => {
      if (!state.authenticated) {
        return;
      }
      event.preventDefault();
      elements.bubbleStage.classList.add('is-dropping');
    });
    elements.bubbleStage.addEventListener('dragover', (event) => {
      if (!state.authenticated) {
        return;
      }
      event.preventDefault();
      elements.bubbleStage.classList.add('is-dropping');
    });
    elements.bubbleStage.addEventListener('dragleave', (event) => {
      if (!state.authenticated) {
        return;
      }
      if (event.target === elements.bubbleStage) {
        elements.bubbleStage.classList.remove('is-dropping');
      }
    });
    elements.bubbleStage.addEventListener('drop', async (event) => {
      if (!state.authenticated) {
        return;
      }
      event.preventDefault();
      elements.bubbleStage.classList.remove('is-dropping');
      await uploadFiles(Array.from(event.dataTransfer.files || []));
    });

    document.addEventListener('paste', (event) => {
      handlePasteEvent(event).catch((error) => {
        showToast(error.message || 'Paste failed.', 'error');
      });
    });

    document.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement && event.target.dataset.closeModal) {
        closeSettingsModal();
      }
      if (event.target instanceof HTMLElement && event.target.dataset.closeSheet) {
        closeSheet(elements.mobileSheet);
      }
      if (event.target instanceof HTMLElement && event.target.dataset.closePaste) {
        closeSheet(elements.pasteSheet);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') {
        return;
      }
      closeSettingsModal();
      closeSheet(elements.mobileSheet);
      closeSheet(elements.pasteSheet);
    });

    window.addEventListener('resize', renderItems);
    state.reducedMotionQuery.addEventListener('change', ensureAnimationLoop);
  }

  async function bootstrap() {
    bindEvents();
    setTheme('auto');
    setAuthenticated(false);
    renderItems();
    ensureAnimationLoop();

    try {
      await refreshRoom();
      connectSocket();
    } catch (error) {
      if (error.status !== 401) {
        showToast('Bubble is not reachable yet.', 'error');
      }
    }
  }

  bootstrap();
})();
