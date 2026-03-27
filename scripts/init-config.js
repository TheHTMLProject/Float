const path = require('path');
const { mergeConfig } = require('../server/config');
const { ensureDir, hashPassword, writeJsonAtomic } = require('../server/utils');

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) {
      continue;
    }
    const key = part.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outputPath = path.resolve(String(args.output || path.join('config', 'runtime.json')));
  const password = String(args.password || process.env.FLOAT_PASSWORD || '');

  if (!password) {
    throw new Error('A password is required. Pass --password or set FLOAT_PASSWORD.');
  }

  const { salt, hash } = await hashPassword(password);
  const config = mergeConfig({
    bindHost: args['bind-host'],
    port: args.port,
    publicBaseUrl: args['public-base-url'],
    storagePath: args['storage-path'],
    maxUploadBytes: args['max-upload-bytes'],
    maxStorageBytes: args['max-storage-bytes'],
    secureCookies: args['secure-cookies'] === 'true',
    defaultSettings: {
      lifetimeMode: args['lifetime-mode'],
      expiryHours: args['expiry-hours'],
      themeDefault: args['theme-default']
    },
    passwordSalt: salt,
    passwordHash: hash
  });

  await ensureDir(path.dirname(outputPath));
  await writeJsonAtomic(outputPath, config);
  process.stdout.write(`Wrote config to ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || 'Failed to write config.'}\n`);
  process.exitCode = 1;
});
