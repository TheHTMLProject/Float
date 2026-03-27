const path = require('path');
const { mergeConfig } = require('../server/config');
const { ensureDir, writeJsonAtomic } = require('../server/utils');

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
  const hostname = String(args.hostname || '').trim();
  const port = Number(args.port || 3000);

  if (!hostname) {
    throw new Error('A hostname is required. Pass --hostname.');
  }
  const config = mergeConfig({
    bindHost: '0.0.0.0',
    port,
    publicBaseUrl: `http://${hostname}:${port}`,
    passwordSalt: '',
    passwordHash: ''
  });

  await ensureDir(path.dirname(outputPath));
  await writeJsonAtomic(outputPath, config);
  process.stdout.write(`Wrote config to ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || 'Failed to write config.'}\n`);
  process.exitCode = 1;
});
