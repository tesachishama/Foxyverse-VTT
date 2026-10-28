import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), 'foxyverse-f-'));
let proc;
const call = async (method, path, body, cookie, extra = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};
const upload = async (cookie, type, bytes) => {
  const res = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'Content-Type': type, Cookie: cookie }, body: bytes });
  return { status: res.status, body: await res.json() };
};
const PNG = (n = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, n)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 7)]);

before(async () => {
  proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/me'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { proc.kill(); rmSync(dataDir, { recursive: true, force: true }); });

test('scenes: fog, walls, lights, reveal are stored and sanitised; GM sees all scenes\' tokens', async () => {
  const gm = await call('POST', '/api/register', { name: 'GM', password: 'longpassword' });
  const code = (await call('GET', '/api/state', null, gm.cookie)).body.invite.code;
  const pl = await call('POST', '/api/register', { name: 'Pip', password: 'longpassword', invite: code });
  const a = await call('POST', '/api/scenes', { name: 'A', width: 1000, height: 1000 }, gm.cookie);
  const b = await call('POST', '/api/scenes', { name: 'B', width: 500, height: 500 }, gm.cookie);
  assert.equal(b.body.active, false);
  const upd = await call('PATCH', `/api/scenes/${b.body.id}`, { fog: true, dark: true, walls: [[1.234, 2, 300, 2, 1, 0], 'junk', [0, 0, 'x', 5]], lights: [{ x: 10, y: 10, radius: 999 }], reveal: [[10, 10, -5, 20]] }, gm.cookie);
  assert.equal(upd.body.fog, true); assert.equal(upd.body.dark, true);
  assert.deepEqual(upd.body.walls[0], [1.2, 2, 300, 2, 1, 0]); assert.equal(upd.body.walls.length, 2);
  assert.equal(upd.body.lights[0].radius, 100); assert.deepEqual(upd.body.reveal[0], [10, 10, 5, 20]);
  const tk = await call('POST', '/api/tokens', { sceneId: b.body.id, name: 'Prep', vision: 6, light: 3 }, gm.cookie);
  assert.equal(tk.body.vision, 6); assert.equal(tk.body.light, 3);
  assert.equal((await call('GET', '/api/state', null, gm.cookie)).body.tokens.length, 1);
  assert.equal((await call('GET', '/api/state', null, pl.cookie)).body.tokens.length, 0);
  assert.equal((await call('GET', '/api/state', null, pl.cookie)).body.scenes.length, 0);
  assert.equal(a.body.active, true);
});

test('uploads: sniffing, player limits, audio is GM only, ranges work', async () => {
  const gm = await call('POST', '/api/login', { name: 'GM', password: 'longpassword' });
  const pl = await call('POST', '/api/login', { name: 'Pip', password: 'longpassword' });
  assert.equal((await upload(gm.cookie, 'image/png', Buffer.from('not a png at all'))).status, 400);
  const png = await upload(pl.cookie, 'image/png', PNG());
  assert.equal(png.status, 200); assert.equal(png.body.kind, 'image');
  assert.equal((await upload(pl.cookie, 'audio/mpeg', MP3)).status, 403);
  assert.equal((await upload(pl.cookie, 'image/png', Buffer.concat([PNG(), Buffer.alloc(6 * 1024 * 1024)]))).status, 413);
  const mp3 = await upload(gm.cookie, 'audio/mpeg', MP3);
  assert.equal(mp3.body.kind, 'audio');
  const full = await fetch(BASE + mp3.body.url);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const part = await fetch(BASE + mp3.body.url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${MP3.length}`);
  assert.equal((await fetch(BASE + mp3.body.url, { headers: { Range: 'bytes=99999-' } })).status, 416);
});

test('player portrait propagates to linked tokens; owner may set own token image', async () => {
  const gm = await call('POST', '/api/login', { name: 'GM', password: 'longpassword' });
  const pl = await call('POST', '/api/login', { name: 'Pip', password: 'longpassword' });
  const png = await upload(pl.cookie, 'image/png', PNG(3));
  const hero = await call('POST', '/api/actors', { name: 'Hero' }, pl.cookie);
  const scene = (await call('GET', '/api/state', null, gm.cookie)).body.scenes.find((s) => s.active);
  const tok = await call('POST', '/api/tokens', { sceneId: scene.id, actorId: hero.body.id }, gm.cookie);
  assert.equal(tok.body.image, null);
  const d = hero.body.data; d.portrait = png.body.url;
  await call('PATCH', `/api/actors/${hero.body.id}`, { data: d }, pl.cookie);
  const after = (await call('GET', '/api/state', null, pl.cookie)).body.tokens.find((t) => t.id === tok.body.id);
  assert.equal(after.image, png.body.url);
  const own = await call('PATCH', `/api/tokens/${tok.body.id}`, { image: null, name: 'hacked', vision: 99 }, pl.cookie);
  assert.equal(own.body.image, null); assert.equal(own.body.name, 'Hero'); assert.equal(own.body.vision, 0); // only x, y, image are player-editable
});

test('audio: GM plays/stops, players cannot, state exposes what is playing', async () => {
  const gm = await call('POST', '/api/login', { name: 'GM', password: 'longpassword' });
  const pl = await call('POST', '/api/login', { name: 'Pip', password: 'longpassword' });
  const mp3 = await upload(gm.cookie, 'audio/mpeg', MP3);
  const snd = await call('POST', '/api/sounds', { name: 'Tavern', url: mp3.body.url, loop: true, volume: 0.5 }, gm.cookie);
  assert.equal(snd.body.loop, true);
  assert.equal((await call('POST', '/api/sounds', { name: 'x', url: '/uploads/evil.mp3' }, gm.cookie)).status, 400);
  assert.equal((await call('POST', `/api/sounds/${snd.body.id}/play`, null, pl.cookie)).status, 403);
  const sse = await fetch(BASE + '/api/events', { headers: { Cookie: pl.cookie } });
  const reader = sse.body.getReader(); const dec = new TextDecoder();
  const heard = (async () => { let buf = ''; for (;;) { const { value } = await reader.read(); buf += dec.decode(value); const m = /data: (.*"type":"audio".*)\n/.exec(buf); if (m) return JSON.parse(m[1]); } })();
  await call('POST', `/api/sounds/${snd.body.id}/play`, null, gm.cookie);
  const ev = await heard; reader.cancel();
  assert.equal(ev.op, 'play'); assert.equal(ev.id, snd.body.id);
  const st = (await call('GET', '/api/state', null, pl.cookie)).body;
  assert.equal(st.playing.length, 1); assert.equal(st.sounds.length, 1); assert.ok(Math.abs(st.serverTime - Date.now()) < 5000);
  await call('POST', '/api/audio/stop', null, gm.cookie);
  assert.equal((await call('GET', '/api/state', null, pl.cookie)).body.playing.length, 0);
});

test('journal visibility: gm / all / specific players; show pushes to viewers', async () => {
  const gm = await call('POST', '/api/login', { name: 'GM', password: 'longpassword' });
  const pl = await call('POST', '/api/login', { name: 'Pip', password: 'longpassword' });
  const st = (await call('GET', '/api/state', null, gm.cookie)).body;
  const pip = st.users.find((u) => u.name === 'Pip');
  const secret = await call('POST', '/api/journals', { title: 'Secret', body: 'gm only' }, gm.cookie);
  const mine = await call('POST', '/api/journals', { title: 'For Pip', body: '[int +0|check]', visibility: [pip.id] }, gm.cookie);
  assert.deepEqual((await call('GET', '/api/state', null, pl.cookie)).body.journals.map((j) => j.title), ['For Pip']);
  assert.equal((await call('POST', '/api/journals', { title: 'x' }, pl.cookie)).status, 403);
  await call('POST', `/api/journals/${secret.body.id}/show`, null, gm.cookie); // show makes a GM-only entry public
  assert.equal((await call('GET', '/api/state', null, pl.cookie)).body.journals.length, 2);
  await call('PATCH', `/api/journals/${mine.body.id}`, { visibility: 'gm' }, gm.cookie);
  assert.equal((await call('GET', '/api/state', null, pl.cookie)).body.journals.length, 1);
});

test('compendium: players see items/spells/talents but not NPC templates; templates instantiate with a token', async () => {
  const gm = await call('POST', '/api/login', { name: 'GM', password: 'longpassword' });
  const pl = await call('POST', '/api/login', { name: 'Pip', password: 'longpassword' });
  await call('POST', '/api/compendium', { kind: 'item', name: 'Round shield', data: { name: 'Round shield', type: 'armor', pdef: 2, bonuses: { strength: 1, bogus: 5 } } }, gm.cookie);
  await call('POST', '/api/compendium', { kind: 'spell', name: 'Spark', data: { name: 'Spark', cost: 2, costType: 'mp' } }, gm.cookie);
  const npc = await call('POST', '/api/compendium', { kind: 'actor', name: 'Goblin', data: { bio: { level: 2 }, stats: { constitution: { base: 8 } } } }, gm.cookie);
  const view = (await call('GET', '/api/state', null, pl.cookie)).body.compendium;
  assert.deepEqual(view.map((c) => c.kind).sort(), ['item', 'spell']);
  assert.deepEqual(view.find((c) => c.kind === 'item').data.bonuses, { strength: 1 }); // unknown stat dropped
  assert.equal((await call('POST', '/api/compendium', { kind: 'item', name: 'x', data: {} }, pl.cookie)).status, 403);
  const scene = (await call('GET', '/api/state', null, gm.cookie)).body.scenes.find((s) => s.active);
  const made = await call('POST', `/api/compendium/${npc.body.id}/instantiate`, { sceneId: scene.id, name: 'Gob 1' }, gm.cookie);
  assert.equal(made.body.name, 'Gob 1'); assert.equal(made.body.computed.derived.maxhp, 24); // con 8 * (lvl 2 + 1)
  assert.ok((await call('GET', '/api/state', null, gm.cookie)).body.tokens.some((t) => t.actorId === made.body.id));
});

test('invite code: GM can set a custom one, players need it, bad codes are refused', async () => {
  const gm = await call('POST', '/api/login', { name: 'GM', password: 'longpassword' });
  const pl = await call('POST', '/api/login', { name: 'Pip', password: 'longpassword' });
  assert.equal((await call('POST', '/api/invite', { code: 'abcd' }, pl.cookie)).status, 403);
  assert.equal((await call('POST', '/api/invite', { code: 'no spaces!' }, gm.cookie)).status, 400);
  assert.equal((await call('POST', '/api/invite', { code: 'ab' }, gm.cookie)).status, 400);
  assert.equal((await call('POST', '/api/invite', { code: 'Foxy-Table_2026' }, gm.cookie)).body.code, 'Foxy-Table_2026');
  assert.equal((await call('POST', '/api/register', { name: 'Late', password: 'longpassword', invite: 'wrong' })).status, 403);
  assert.equal((await call('POST', '/api/register', { name: 'Late', password: 'longpassword', invite: 'Foxy-Table_2026' })).status, 200);
  assert.equal((await call('GET', '/api/state', null, gm.cookie)).body.invite.code, 'Foxy-Table_2026');
});

test('equipment slots through the API: slots are validated, deduplicated and drive stats', async () => {
  const gm = await call('POST', '/api/login', { name: 'GM', password: 'longpassword' });
  const hero = await call('POST', '/api/actors', { name: 'Knight' }, gm.cookie);
  const d = hero.body.data;
  d.items = [
    { name: 'Sword', type: 'weapon', usedSlots: ['weapon1'], bonuses: { strength: 2 } },
    { name: 'Second sword', type: 'weapon', usedSlots: ['Arme 1', 'weapon2'] },       // weapon1 already taken, weapon2 free
    { name: 'Helm', type: 'armor', equipExpr: '[head]', usedSlots: ['hat'], pdef: 3 },
    { name: 'Junk', type: 'other', usedSlots: ['not-a-slot'] },
  ];
  const r = await call('PATCH', `/api/actors/${hero.body.id}`, { data: d }, gm.cookie);
  assert.deepEqual(r.body.data.items.map((i) => i.usedSlots), [['weapon1'], ['weapon2'], ['hat'], []]);
  assert.equal(r.body.data.items[0].equipExpr, '[weapons]');
  assert.equal(r.body.computed.stats.strength.item, 2); assert.equal(r.body.computed.pdef, 3);
  const scene = (await call('GET', '/api/state', null, gm.cookie)).body.scenes.find((s) => s.active);
  const tok = await call('POST', '/api/tokens', { sceneId: scene.id, actorId: hero.body.id, sight: true }, gm.cookie);
  assert.equal(tok.body.sight, true);
  assert.equal((await call('PATCH', `/api/tokens/${tok.body.id}`, { sight: false }, gm.cookie)).body.sight, false);
});
