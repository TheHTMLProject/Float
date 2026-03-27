const fs = require('fs');
const path = require('path');
const { createHttpError, normalizeLifetimeMode, normalizeTheme } = require('./utils');

const DEFAULT_CONFIG = {
  bindHost: '0.0.0.0',
  port: 3000,
  publicBaseUrl: '',
  strictOriginCheck: false,
  storagePath: path.resolve(process.cwd(), 'storage'),
  secureCookies: false,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  reauthWindowMs: 5 * 60 * 1000,
  authRateLimit: {
    windowMs: 10 * 60 * 1000,
    maxAttempts: 8,
    blockMs: 15 * 60 * 1000
  },
  apiRateLimit: {
    windowMs: 60 * 1000,
    maxRequests: 600
  },
  maxUploadBytes: 100 * 1024 * 1024,
  maxStorageBytes: 2 * 1024 * 1024 * 1024,
  defaultSettings: {
    lifetimeMode: 'manual',
    expiryHours: 24,
    themeDefault: 'auto'
  }
};

function getConfigPath(argv = process.argv) {
  const configIndex = argv.indexOf('--config');
  if (configIndex !== -1 && argv[configIndex + 1]) {
    return path.resolve(argv[configIndex + 1]);
  }
  if (process.env.FLOAT_CONFIG) {
    return path.resolve(process.env.FLOAT_CONFIG);
  }
  return path.resolve(process.cwd(), 'config', 'runtime.json');
}

function mergeConfig(input = {}) {
  const defaultSettings = input.defaultSettings || {};
  const authRateLimit = input.authRateLimit || {};
  const apiRateLimit = input.apiRateLimit || {};
  const publicBaseUrl = String(input.publicBaseUrl || '').trim();

  return {
    ...DEFAULT_CONFIG,
    ...input,
    bindHost: String(input.bindHost || DEFAULT_CONFIG.bindHost),
    port: Number(input.port || DEFAULT_CONFIG.port),
    publicBaseUrl,
    strictOriginCheck: Boolean(input.strictOriginCheck),
    storagePath: path.resolve(String(input.storagePath || DEFAULT_CONFIG.storagePath)),
    secureCookies: Boolean(
      input.secureCookies !== undefined
        ? input.secureCookies
        : publicBaseUrl.startsWith('https://')
    ),
    sessionTtlMs: Number(input.sessionTtlMs || DEFAULT_CONFIG.sessionTtlMs),
    reauthWindowMs: Number(input.reauthWindowMs || DEFAULT_CONFIG.reauthWindowMs),
    authRateLimit: {
      windowMs: Number(authRateLimit.windowMs || DEFAULT_CONFIG.authRateLimit.windowMs),
      maxAttempts: Number(authRateLimit.maxAttempts || DEFAULT_CONFIG.authRateLimit.maxAttempts),
      blockMs: Number(authRateLimit.blockMs || DEFAULT_CONFIG.authRateLimit.blockMs)
    },
    apiRateLimit: {
      windowMs: Number(apiRateLimit.windowMs || DEFAULT_CONFIG.apiRateLimit.windowMs),
      maxRequests: Number(apiRateLimit.maxRequests || DEFAULT_CONFIG.apiRateLimit.maxRequests)
    },
    maxUploadBytes: Number(input.maxUploadBytes || DEFAULT_CONFIG.maxUploadBytes),
    maxStorageBytes: Number(input.maxStorageBytes || DEFAULT_CONFIG.maxStorageBytes),
    defaultSettings: {
      lifetimeMode: normalizeLifetimeMode(
        defaultSettings.lifetimeMode,
        DEFAULT_CONFIG.defaultSettings.lifetimeMode
      ),
      expiryHours: Math.max(
        1,
        Number(defaultSettings.expiryHours || DEFAULT_CONFIG.defaultSettings.expiryHours)
      ),
      themeDefault: normalizeTheme(
        defaultSettings.themeDefault,
        DEFAULT_CONFIG.defaultSettings.themeDefault
      )
    },
    passwordSalt: String(input.passwordSalt || ''),
    passwordHash: String(input.passwordHash || '')
  };
}

async function loadConfig(configPath) {
  const resolvedPath = configPath || getConfigPath();

  if (!fs.existsSync(resolvedPath)) {
    throw createHttpError(
      500,
      `Config file not found at ${resolvedPath}. Run install.sh or npm run init-config first.`
    );
  }

  const raw = await fs.promises.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  const config = mergeConfig(parsed);

  if (!config.passwordSalt || !config.passwordHash) {
    throw createHttpError(500, 'Config is missing password credentials.');
  }

  return {
    configPath: resolvedPath,
    config
  };
}

module.exports = {
  DEFAULT_CONFIG,
  getConfigPath,
  loadConfig,
  mergeConfig
};
