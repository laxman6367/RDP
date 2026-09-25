import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
try {
  const ran = await migrate(db);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date');
} finally {
  await db.end();
}
