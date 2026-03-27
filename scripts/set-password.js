const fs = require('fs');
const path = require('path');
const { getConfigPath, mergeConfig } = require('../server/config');
const { hashPassword, writeJsonAtomic } = require('../server/utils');

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
  const configPath = args.config
    ? path.resolve(String(args.config))
    : getConfigPath(process.argv);
  const password = String(args.password || process.env.FLOAT_PASSWORD || '');

  if (!password) {
    throw new Error('A password is required. Pass --password or set FLOAT_PASSWORD.');
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  const raw = await fs.promises.readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  const { salt, hash } = await hashPassword(password);
  const config = mergeConfig({
    ...parsed,
    passwordSalt: salt,
    passwordHash: hash
  });

  await writeJsonAtomic(configPath, config);
  process.stdout.write(`Updated password in ${configPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || 'Failed to update password.'}\n`);
  process.exitCode = 1;
});
