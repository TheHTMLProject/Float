const fs = require('fs');
const path = require('path');
const {
  ensureDir,
  normalizeLifetimeMode,
  normalizeTheme,
  randomId,
  sanitizeFilename,
  writeJsonAtomic
} = require('./utils');

function normalizeOnboardingState(input, fallbackCompleted) {
  const completed = Boolean((input && input.completed) || fallbackCompleted);

  return {
    version:
      Number.isInteger(input && input.version) && input.version > 0 ? input.version : 1,
    completed,
    completedAt:
      completed && input && typeof input.completedAt === 'string' && input.completedAt.trim()
        ? input.completedAt
        : null
  };
}

class DataStore {
  constructor(config) {
    this.config = config;
    this.storagePath = config.storagePath;
    this.filesPath = path.join(this.storagePath, 'files');
    this.metadataPath = path.join(this.storagePath, 'room.json');
    this.state = {
      items: [],
      settings: {
        lifetimeMode: normalizeLifetimeMode(config.defaultSettings.lifetimeMode),
        expiryHours: Math.max(1, Number(config.defaultSettings.expiryHours || 24)),
        themeDefault: normalizeTheme(config.defaultSettings.themeDefault)
      },
      onboarding: normalizeOnboardingState(
        null,
        Boolean(config.passwordSalt && config.passwordHash)
      )
    };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await ensureDir(this.storagePath);
    await ensureDir(this.filesPath);
    let needsPersist = false;

    if (fs.existsSync(this.metadataPath)) {
      const raw = await fs.promises.readFile(this.metadataPath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        this.state = {
          items: Array.isArray(parsed.items)
            ? parsed.items.filter((item) => item && typeof item.id === 'string')
            : [],
          settings: {
            lifetimeMode: normalizeLifetimeMode(
              parsed.settings && parsed.settings.lifetimeMode,
              this.config.defaultSettings.lifetimeMode
            ),
            expiryHours: Math.max(
              1,
              Number(
                parsed.settings && parsed.settings.expiryHours
                  ? parsed.settings.expiryHours
                  : this.config.defaultSettings.expiryHours
              )
            ),
            themeDefault: normalizeTheme(
              parsed.settings && parsed.settings.themeDefault,
              this.config.defaultSettings.themeDefault
            )
          },
          onboarding: normalizeOnboardingState(
            parsed.onboarding,
            Boolean(this.config.passwordSalt && this.config.passwordHash)
          )
        };
        needsPersist = !parsed.onboarding;
      }
    } else {
      await this.persist();
    }

    if (needsPersist) {
      await this.persist();
    }

    await this.pruneExpiredItems();
  }

  getSettings() {
    return {
      lifetimeMode: this.state.settings.lifetimeMode,
      expiryHours: this.state.settings.expiryHours,
      themeDefault: this.state.settings.themeDefault
    };
  }

  getOnboarding() {
    return {
      ...this.state.onboarding
    };
  }

  isOnboardingComplete() {
    return Boolean(this.state.onboarding.completed);
  }

  getStorageUsage() {
    return this.state.items.reduce((total, item) => total + Number(item.size || 0), 0);
  }

  getStorageSummary() {
    return {
      usedBytes: this.getStorageUsage(),
      maxBytes: this.config.maxStorageBytes,
      itemCount: this.state.items.length,
      maxUploadBytes: this.config.maxUploadBytes
    };
  }

  getItems() {
    return [...this.state.items].sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  }

  getItemById(itemId) {
    return this.state.items.find((item) => item.id === itemId) || null;
  }

  getFilePath(item) {
    return path.join(this.filesPath, item.storedName);
  }

  async addUploadedFile({ tempPath, displayName, mime, size, type }) {
    const safeName = sanitizeFilename(displayName, type === 'text' ? 'note.txt' : 'item');
    const itemId = randomId(10);
    const extension = path.extname(safeName);
    const storedName = `${itemId}${extension}`;
    const targetPath = path.join(this.filesPath, storedName);

    await fs.promises.rename(tempPath, targetPath);

    const item = this.createItemRecord({
      id: itemId,
      type,
      displayName: safeName,
      mime,
      size,
      storedName
    });

    this.state.items.unshift(item);
    await this.persist();
    return item;
  }

  async createTextItem({ text, displayName }) {
    const safeName = sanitizeFilename(displayName || 'pasted-text.txt', 'pasted-text.txt').replace(
      /\.[^.]+$/,
      ''
    );
    const finalName = safeName.toLowerCase().endsWith('.txt') ? safeName : `${safeName}.txt`;
    const itemId = randomId(10);
    const storedName = `${itemId}.txt`;
    const filePath = path.join(this.filesPath, storedName);
    const buffer = Buffer.from(String(text || ''), 'utf8');

    await fs.promises.writeFile(filePath, buffer);

    const item = this.createItemRecord({
      id: itemId,
      type: 'text',
      displayName: finalName,
      mime: 'text/plain; charset=utf-8',
      size: buffer.length,
      storedName
    });

    this.state.items.unshift(item);
    await this.persist();
    return item;
  }

  async recordDownload(itemId) {
    const item = this.getItemById(itemId);
    if (!item) {
      return null;
    }
    item.downloadCount = Number(item.downloadCount || 0) + 1;
    item.lastDownloadedAt = new Date().toISOString();
    await this.persist();
    return item;
  }

  async deleteItem(itemId) {
    const index = this.state.items.findIndex((item) => item.id === itemId);
    if (index === -1) {
      return null;
    }

    const [item] = this.state.items.splice(index, 1);
    const filePath = path.join(this.filesPath, item.storedName);

    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await this.persist();
    return item;
  }

  async deleteAllItems() {
    const items = [...this.state.items];
    this.state.items = [];

    for (const item of items) {
      const filePath = path.join(this.filesPath, item.storedName);
      await fs.promises.unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }

    await this.persist();
  }

  async updateSettings(partial) {
    this.state.settings = {
      lifetimeMode: normalizeLifetimeMode(
        partial.lifetimeMode,
        this.state.settings.lifetimeMode
      ),
      expiryHours: Math.max(
        1,
        Number(
          partial.expiryHours !== undefined
            ? partial.expiryHours
            : this.state.settings.expiryHours
        )
      ),
      themeDefault: normalizeTheme(
        partial.themeDefault,
        this.state.settings.themeDefault
      )
    };
    this.applySettingsToItems();
    await this.persist();
    return this.getSettings();
  }

  async completeOnboarding(referenceTime = Date.now()) {
    this.state.onboarding = {
      version: 1,
      completed: true,
      completedAt: new Date(referenceTime).toISOString()
    };
    await this.persist();
    return this.getOnboarding();
  }

  async pruneExpiredItems(referenceTime = Date.now()) {
    const expiredIds = this.state.items
      .filter((item) => item.expiresAt && new Date(item.expiresAt).getTime() <= referenceTime)
      .map((item) => item.id);

    if (!expiredIds.length) {
      return [];
    }

    const deleted = [];
    for (const itemId of expiredIds) {
      const item = await this.deleteItem(itemId);
      if (item) {
        deleted.push(item);
      }
    }
    return deleted;
  }

  createItemRecord({ id, type, displayName, mime, size, storedName }) {
    const settings = this.getSettings();
    const createdAt = new Date().toISOString();
    const expiresAt =
      settings.lifetimeMode === 'expiry'
        ? new Date(Date.now() + settings.expiryHours * 60 * 60 * 1000).toISOString()
        : null;

    return {
      id,
      type,
      displayName,
      mime,
      size,
      storedName,
      createdAt,
      expiresAt,
      downloadCount: 0,
      deletionPolicy: settings.lifetimeMode
    };
  }

  applySettingsToItems(referenceTime = Date.now()) {
    const settings = this.getSettings();
    const expiresAt =
      settings.lifetimeMode === 'expiry'
        ? new Date(referenceTime + settings.expiryHours * 60 * 60 * 1000).toISOString()
        : null;

    for (const item of this.state.items) {
      item.deletionPolicy = settings.lifetimeMode;
      item.expiresAt = expiresAt;
    }
  }

  persist() {
    this.writeChain = this.writeChain.then(() => writeJsonAtomic(this.metadataPath, this.state));
    return this.writeChain;
  }
}

module.exports = {
  DataStore
};
