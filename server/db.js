import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSystem } from './rules.js';

export const DATA_DIR = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  accessSync(DATA_DIR, constants.W_OK);
} catch (e) {
  console.error(`\nFoxyverse VTT cannot write to its data folder ${DATA_DIR} (${e.code}).\n` +
    `If this is a Docker bind mount, give it to the container user (uid 1000, "node"):\n  sudo chown -R 1000:1000 <your data folder>\n` +
    `or use a named volume instead (the default in docker-compose.yml).\n`);
  process.exit(1);
}

export const db = new DatabaseSync(join(DATA_DIR, 'foxy.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player', color TEXT NOT NULL DEFAULT '#eba5ff', created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, image TEXT, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
  grid INTEGER NOT NULL DEFAULT 70, ox INTEGER NOT NULL DEFAULT 0, oy INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY, scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, name TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, size REAL NOT NULL DEFAULT 1, image TEXT, color TEXT NOT NULL DEFAULT '#eba5ff',
  actor_id INTEGER REFERENCES actors(id) ON DELETE SET NULL, hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT NOT NULL, actor_id INTEGER, whisper TEXT,
  body TEXT NOT NULL, ts INTEGER NOT NULL);
`);

// Additive migrations so databases created by earlier versions keep working.
function addColumn(table, name, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
addColumn('scenes', 'fog', 'INTEGER NOT NULL DEFAULT 0');
addColumn('scenes', 'dark', 'INTEGER NOT NULL DEFAULT 0');
addColumn('scenes', 'walls', "TEXT NOT NULL DEFAULT '[]'");
addColumn('scenes', 'lights', "TEXT NOT NULL DEFAULT '[]'");
addColumn('scenes', 'reveal', "TEXT NOT NULL DEFAULT '[]'");
addColumn('tokens', 'vision', 'REAL NOT NULL DEFAULT 0');
addColumn('tokens', 'light', 'REAL NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS sounds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, loop INTEGER NOT NULL DEFAULT 0, volume REAL NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS journals (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', image TEXT, visibility TEXT NOT NULL DEFAULT '"gm"', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS compendium (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
`);

const DEFAULT_SYSTEM_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'system', 'foxyverse.json');
export const loadDefaultSystem = () => validateSystem(JSON.parse(readFileSync(DEFAULT_SYSTEM_PATH, 'utf8')));

export function getSystem() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('system');
  if (row) return JSON.parse(row.value);
  const sys = loadDefaultSystem();
  setSystem(sys);
  return sys;
}
export function setSystem(sys) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('system', JSON.stringify(sys));
}
