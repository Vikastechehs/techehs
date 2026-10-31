// Database access. Uses PostgreSQL when DATABASE_URL is set, otherwise an embedded PostgreSQL (PGlite)
// stored in ./data, so the engine runs on any PC with only Node installed.
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, DEFAULT_SETTINGS } from './config.ts';

export type Row = Record<string, any>;
export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

export async function openDb(opts: { url?: string; dir?: string; memory?: boolean } = {}): Promise<Db> {
  const url = opts.url ?? config.databaseUrl;
  if (url) {
    const pg = (await import('pg')).default;
    // Return numeric and date columns as JS numbers/strings we control
    pg.types.setTypeParser(1082, (v: string) => v);               // date -> 'YYYY-MM-DD'
    const pool = new pg.Pool({ connectionString: url, max: Math.max(10, config.concurrency + 5) });
    return {
      kind: 'postgres',
      async query(sql, params = []) { return (await pool.query(sql, params as any[])).rows; },
      async exec(sql) { await pool.query(sql); },
      async close() { await pool.end(); },
    };
  }
  const { PGlite, types } = await import('@electric-sql/pglite');
  let dataDir: string | undefined;
  if (!opts.memory) { dataDir = opts.dir ?? config.localDbDir; mkdirSync(dataDir, { recursive: true }); }
  const lite = new PGlite(dataDir, {
    parsers: { [types.DATE]: (v: string) => v },
  });
  await lite.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params = []) { return (await lite.query(sql, params as any[])).rows as any[]; },
    async exec(sql) { await lite.exec(sql); },
    async close() { await lite.close(); },
  };
}

export async function migrate(db: Db) {
  await db.exec(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'));
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
}

export async function getSettings(db: Db) {
  const rows = await db.query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const s: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return {
    raw: s,
    num: (k: string) => Number(s[k]),
    bool: (k: string) => s[k] === 'true',
  };
}
export type Settings = Awaited<ReturnType<typeof getSettings>>;
