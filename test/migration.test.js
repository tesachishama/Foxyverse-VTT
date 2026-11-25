// A database written by v1 (everything global, accounts with passwords) opens as a first table "test".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers.js';

// The schema exactly as v1 left it (server/db.js at commit 7ba55b3).
const V1_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player', color TEXT NOT NULL DEFAULT '#eba5ff', created INTEGER NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE scenes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, image TEXT, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0,
  grid INTEGER NOT NULL DEFAULT 70, ox INTEGER NOT NULL DEFAULT 0, oy INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
  fog INTEGER NOT NULL DEFAULT 0, dark INTEGER NOT NULL DEFAULT 0, walls TEXT NOT NULL DEFAULT '[]', lights TEXT NOT NULL DEFAULT '[]', reveal TEXT NOT NULL DEFAULT '[]');
CREATE TABLE actors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE tokens (id INTEGER PRIMARY KEY, scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, name TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, size REAL NOT NULL DEFAULT 1, image TEXT, color TEXT NOT NULL DEFAULT '#eba5ff',
  actor_id INTEGER REFERENCES actors(id) ON DELETE SET NULL, hidden INTEGER NOT NULL DEFAULT 0,
  vision REAL NOT NULL DEFAULT 0, light REAL NOT NULL DEFAULT 0, sight INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chat (id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT NOT NULL, actor_id INTEGER, whisper TEXT, body TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE sounds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, loop INTEGER NOT NULL DEFAULT 0, volume REAL NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE journals (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', image TEXT, visibility TEXT NOT NULL DEFAULT '"gm"', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE compendium (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
`;

test('v1 data moves into the table "test" with its rules; v1 accounts are dropped', async () => {
  const sys = JSON.parse(readFileSync(new URL('../system/foxyverse.json', import.meta.url), 'utf8'));
  sys.derived.find((d) => d.id === 'maxhp').formula = 'con*3'; // a GM-edited v1 system must survive
  const srv = await startServer({}, (dir) => {
    const db = new DatabaseSync(join(dir, 'foxy.db'));
    db.exec(V1_SCHEMA);
    db.exec(`INSERT INTO users VALUES (1, 'Mistress', 's', 'h', 'gm', '#ffffff', 1), (2, 'Pip', 's', 'h', 'player', '#00ff00', 1);
      INSERT INTO sessions VALUES ('t', 2, 9999999999999);
      INSERT INTO scenes (id, name, width, height, active, created, walls) VALUES (1, 'Old map', 800, 600, 1, 1, '[[0,0,10,0,0,0]]');
      INSERT INTO actors VALUES (1, 'Old hero', 2, '{"stats":{"constitution":{"base":7}}}', 1, 1), (2, 'Old hero', NULL, '{}', 1, 1);
      INSERT INTO tokens (scene_id, name, x, y, actor_id) VALUES (1, 'Old hero', 5, 5, 1);
      INSERT INTO chat (user_id, user_name, body, ts) VALUES (2, 'Pip', '{"t":"text","text":"hello from v1"}', 1);
      INSERT INTO journals (title, visibility, created, updated) VALUES ('Lore', '"all"', 1, 1);
      INSERT INTO sounds (name, url, created) VALUES ('Rain', '/uploads/${'a'.repeat(64)}.mp3', 1);
      INSERT INTO compendium (kind, name, data, created) VALUES ('spell', 'Spark', '{"name":"Spark"}', 1), ('talent', 'Old talent', '{}', 1), ('actor', 'Old goblin', '{}', 1);`);
    db.prepare('INSERT INTO settings VALUES (?, ?)').run('system', JSON.stringify(sys));
    db.close();
  });
  try {
    const tables = (await srv.call('GET', '/admin/api/tables')).body.tables;
    assert.deepEqual(tables.map((t) => [t.slug, t.players]), [['test', 0]]); // no slots: the GM creates them again
    const st = (await srv.call('GET', '/admin/api/t/test/state')).body;
    assert.equal(st.scene.name, 'Old map'); assert.deepEqual(st.scene.walls, [[0, 0, 10, 0, 0, 0, 0, 0, 1]]); // old walls: block sight and light, not movement
    assert.equal(st.tokens.length, 1); assert.equal(st.tokens[0].actorId, 1);
    const old = st.actors.find((a) => a.id === 1);
    assert.equal(old.name, 'Old hero'); assert.deepEqual(old.perms, {});
    assert.equal(old.computed.derived.maxhp, 21); // con 7 * 3: the table kept the edited v1 rules
    assert.deepEqual(st.actors.map((a) => a.alias).sort(), ['Oldhero', 'Oldhero2']); // existing sheets get unique "@" aliases
    assert.equal(st.chat[0].body.text, 'hello from v1');
    assert.equal(st.journals.length, 1); assert.equal(st.sounds.length, 1);
    assert.deepEqual(st.compendium.map((c) => c.name), ['Spark']); // v1 NPC templates and talent entries are gone
    assert.equal((await srv.call('GET', '/admin/api/library')).body.scenes.length, 0); // nothing left outside a table
    assert.match(srv.logs(), /Migrated v1 data into the table "test"/);
    // a fresh table next to it gets the default rules
    await srv.call('POST', '/admin/api/tables', { slug: 'fresh' });
    const hero = await srv.call('POST', '/admin/api/t/fresh/actors', { name: 'New' });
    assert.equal(hero.body.computed.derived.maxhp, 10);
  } finally { await srv.stop(); }
});

test('a brand new database starts with no table at all', async () => {
  const srv = await startServer();
  try {
    assert.deepEqual((await srv.call('GET', '/admin/api/tables')).body.tables, []);
    assert.doesNotMatch(srv.logs(), /Migrated/);
  } finally { await srv.stop(); }
});
