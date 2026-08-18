'use strict';
/**
 * Database layer.
 * Prefers Node's built-in sqlite (node:sqlite, Node >= 22.13 / Electron >= 35)
 * so packaged desktop builds need NO native compilation. Falls back to
 * better-sqlite3 on older Node runtimes. Both expose the same surface we use:
 * prepare().run/get/all, exec, pragma.
 */
const fs = require('fs');
const path = require('path');

function makeDb(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.pragma = (s) => { try { db.exec('PRAGMA ' + s); } catch { /* ignore */ } };
    return db;
  } catch {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  }
}

function openDb(dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'techsol.db')) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = makeDb(dbPath);
  try { db.pragma('journal_mode = WAL'); }
  catch { db.pragma('journal_mode = DELETE'); }
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  const schema2 = fs.readFileSync(path.join(__dirname, 'schema2.sql'), 'utf8');
  db.exec(schema2);
  return db;
}

module.exports = { openDb };
