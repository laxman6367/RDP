import { loadConfig } from './config.js';
import { migrate } from './db.js';
import { buildApp } from './http/app.js';

const cfg = loadConfig();
const { app, services, jobs } = await buildApp(cfg);

const ran = await migrate(services.db);
if (ran.length) app.log.info({ migrations: ran }, 'applied migrations');
if (cfg.JOBS_ENABLED) jobs.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}

await app.listen({ host: cfg.HOST, port: cfg.PORT });
