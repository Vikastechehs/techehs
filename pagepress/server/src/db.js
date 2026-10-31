const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS checkouts (
      purchase_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'year',
      email TEXT NOT NULL,
      currency TEXT NOT NULL,
      claim_hash TEXT NOT NULL,
      rejected INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS licenses (
      key TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'year',
      email TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'disabled')),
      expires_at INTEGER,
      renewal_cancelled INTEGER NOT NULL DEFAULT 0,
      activation_limit INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS licenses_email ON licenses (email);
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      license_key TEXT NOT NULL REFERENCES licenses (key),
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS instances_license ON instances (license_key);
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL
    );
  `);
  return db;
}
module.exports = { openDatabase };
