const { createApp } = require('./app');
const { getConfigPath, loadConfig } = require('./config');

async function start() {
  const configPath = getConfigPath(process.argv);
  const { config } = await loadConfig(configPath);
  const { server } = await createApp(config);

  server.listen(config.port, config.bindHost, () => {
    const displayHost = config.bindHost === '0.0.0.0' ? 'localhost' : config.bindHost;
    const publicUrl = config.publicBaseUrl || `http://${displayHost}:${config.port}`;
    process.stdout.write(`Float listening on ${publicUrl}\n`);
  });
}

start().catch((error) => {
  process.stderr.write(`${error.message || 'Failed to start server.'}\n`);
  process.exitCode = 1;
});
