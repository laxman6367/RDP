import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of local-time Dates.
pg.types.setTypeParser(1082, (v: string) => v);
// NUMERIC -> number (amounts are bounded to 14 digits).
pg.types.setTypeParser(1700, (v: string) => Number(v));

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  return withTx(db, async (client) => {
    // Serialize concurrent migrators (e.g. several replicas booting at once).
    await client.query('select pg_advisory_xact_lock(727274)');
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const applied = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(path.join(migrationsDir, file), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      ran.push(file);
    }
    return ran;
  });
}
