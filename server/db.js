import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSystem } from './rules.js';
import { uniqueAlias } from './narration.js';

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
-- users / sessions are v1 accounts, unused since v2 (kept so old foreign keys stay valid).
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

// Additive migrations so databases created by earlier versions keep working. Returns true when the column was just added.
function addColumn(table, name, ddl) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  return true;
}
addColumn('scenes', 'fog', 'INTEGER NOT NULL DEFAULT 0');
addColumn('scenes', 'dark', 'INTEGER NOT NULL DEFAULT 0');
addColumn('scenes', 'walls', "TEXT NOT NULL DEFAULT '[]'");
addColumn('scenes', 'lights', "TEXT NOT NULL DEFAULT '[]'");
addColumn('scenes', 'reveal', "TEXT NOT NULL DEFAULT '[]'");
addColumn('tokens', 'vision', 'REAL NOT NULL DEFAULT 100'); // cells; 0 = no vision (see the "vision100" migration below)
addColumn('tokens', 'light', 'REAL NOT NULL DEFAULT 0');
addColumn('tokens', 'sight', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tokens', 'life', "TEXT NOT NULL DEFAULT 'auto'"); // auto (from the sheet's HP) | dead | alive: the GM can force the look
db.exec(`
CREATE TABLE IF NOT EXISTS sounds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, loop INTEGER NOT NULL DEFAULT 0, volume REAL NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS journals (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', image TEXT, visibility TEXT NOT NULL DEFAULT '"gm"', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS compendium (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
`);

const DEFAULT_SYSTEM_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'system', 'foxyverse.json');
export const loadDefaultSystem = () => validateSystem(JSON.parse(readFileSync(DEFAULT_SYSTEM_PATH, 'utf8')));

// ---- tables (v2): a table is one game "save": its own scenes, sheets, chat, journals, sounds, compendium, rules and players.
// Scenes with no table_id are the GM's map library (outside any table).
db.exec(`
CREATE TABLE IF NOT EXISTS game_tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, listed INTEGER NOT NULL DEFAULT 1,
  system TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL REFERENCES game_tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#eba5ff', session TEXT, seen INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS actor_perms (
  actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE, slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  level TEXT NOT NULL, PRIMARY KEY (actor_id, slot_id));
`);
const OWNED = ['scenes', 'actors', 'chat', 'journals', 'sounds', 'compendium'];
const added = OWNED.map((t) => addColumn(t, 'table_id', 'INTEGER REFERENCES game_tables(id) ON DELETE CASCADE')).some(Boolean);
for (const t of OWNED) db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_table ON ${t}(table_id)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_slots_table ON slots(table_id)');

// v1 -> v2: everything was global. It all moves into a first table "test"; v1 accounts are not kept (no GM accounts any more,
// players pick a slot the GM creates).
if (added && OWNED.some((t) => db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())) {
  const legacy = db.prepare('SELECT value FROM settings WHERE key = ?').get('system');
  let sys; try { sys = legacy ? validateSystem(JSON.parse(legacy.value)) : loadDefaultSystem(); } catch { sys = loadDefaultSystem(); }
  db.exec('BEGIN');
  const id = Number(db.prepare('INSERT INTO game_tables (slug, name, listed, system, created) VALUES (?,?,?,?,?)').run('test', 'test', 1, JSON.stringify(sys), Date.now()).lastInsertRowid);
  for (const t of OWNED) db.prepare(`UPDATE ${t} SET table_id = ? WHERE table_id IS NULL`).run(id);
  db.exec('UPDATE actors SET owner_id = NULL; DELETE FROM sessions; DELETE FROM users;');
  db.exec('COMMIT');
  console.log('Migrated v1 data into the table "test".');
}

// ---- v2 Phase B: campaigns (reference tags across tables), a library of saved systems, a richer compendium.
db.exec(`
CREATE TABLE IF NOT EXISTS systems (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL, created INTEGER NOT NULL);
`);
const CAMPAIGN = 'INTEGER REFERENCES campaigns(id) ON DELETE SET NULL';
addColumn('game_tables', 'campaign_id', CAMPAIGN);
addColumn('actors', 'campaign_id', CAMPAIGN);
addColumn('actors', 'shown', 'INTEGER NOT NULL DEFAULT 0');        // listed to players in the compendium's NPC list (name + picture only)
addColumn('compendium', 'campaign_id', CAMPAIGN);
const richer = addColumn('compendium', 'visible', 'INTEGER NOT NULL DEFAULT 0'); // the GM's "show" toggle
addColumn('compendium', 'auto', 'INTEGER NOT NULL DEFAULT 0');      // created from a sheet and not touched by the GM since
addColumn('compendium', 'updated', 'INTEGER NOT NULL DEFAULT 0');
addColumn('compendium', 'source_id', 'INTEGER');                     // copied from this entry (no foreign key: the original may go)
addColumn('compendium', 'source_updated', 'INTEGER');                // ...as it was at that time
if (richer) {
  // NPCs are sheets now and talents stay on sheets: their old compendium entries go.
  db.exec("DELETE FROM compendium WHERE kind NOT IN ('item', 'spell'); UPDATE compendium SET updated = created;");
}

// ---- ROADMAP 2: "@" aliases (no spaces, unique per table, GM-only). alias_auto: still follows the sheet's name.
addColumn('actors', 'alias', 'TEXT');
addColumn('actors', 'alias_auto', 'INTEGER NOT NULL DEFAULT 1');
for (const a of db.prepare('SELECT id, table_id, name FROM actors WHERE alias IS NULL ORDER BY id').all()) {
  const taken = db.prepare('SELECT alias FROM actors WHERE table_id IS ? AND alias IS NOT NULL').all(a.table_id).map((r) => r.alias);
  db.prepare('UPDATE actors SET alias = ? WHERE id = ?').run(uniqueAlias(a.name, taken), a.id);
}

// ---- ROADMAP 2 §4: vision. Scene options "shared vision" and exploration memory; what each player slot has explored per scene.
addColumn('scenes', 'shared', 'INTEGER NOT NULL DEFAULT 0');
addColumn('scenes', 'explore', 'INTEGER NOT NULL DEFAULT 1');
db.exec(`CREATE TABLE IF NOT EXISTS explored (
  scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  cols INTEGER NOT NULL, rows INTEGER NOT NULL, bits BLOB NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (scene_id, slot_id))`);
// A token vision of 0 used to mean "unlimited"; now 0 is "no vision". Existing tokens at 0 become 100 cells (once).
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'vision100'").get()) {
  db.exec("UPDATE tokens SET vision = 100 WHERE vision = 0; INSERT INTO settings (key, value) VALUES ('vision100', '1');");
}

const systems = new Map(); // table id -> parsed system (cache)
export function getSystem(tableId) {
  if (!systems.has(tableId)) {
    const row = db.prepare('SELECT system FROM game_tables WHERE id = ?').get(tableId);
    systems.set(tableId, row ? JSON.parse(row.system) : loadDefaultSystem());
  }
  return systems.get(tableId);
}
export function setSystem(tableId, sys) {
  db.prepare('UPDATE game_tables SET system = ? WHERE id = ?').run(JSON.stringify(sys), tableId);
  systems.set(tableId, sys);
}
export const forgetSystem = (tableId) => systems.delete(tableId);
