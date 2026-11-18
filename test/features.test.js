import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, gm, pip, pipSlot, T;
const upload = async (prefix, cookie, type, bytes) => {
  const res = await fetch(srv.base + prefix + '/upload', { method: 'POST', headers: { 'Content-Type': type, ...(cookie ? { Cookie: cookie } : {}) }, body: bytes });
  return { status: res.status, body: await res.json() };
};
const gmUpload = (type, bytes) => upload('/admin/api/t/feat', null, type, bytes);
const pipUpload = (type, bytes) => upload('/api/t/feat', pip.cookie, type, bytes);
const PNG = (n = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, n)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 7)]);
const activeScene = async () => (await gm('GET', '/state')).body.scenes.find((s) => s.active);

before(async () => {
  srv = await startServer();
  T = await srv.table('feat');
  gm = T.gm;
  pipSlot = await T.slot('Pip');
  pip = await T.join(pipSlot.id);
});
after(() => srv.stop());

test('scenes: fog, walls, lights, reveal are stored and sanitised; GM sees all scenes\' tokens', async () => {
  const a = await gm('POST', '/scenes', { name: 'A', width: 1000, height: 1000 });
  const b = await gm('POST', '/scenes', { name: 'B', width: 500, height: 500 });
  assert.equal(b.body.active, false);
  const upd = await gm('PATCH', `/scenes/${b.body.id}`, { fog: true, dark: true, walls: [[1.234, 2, 300, 2, 1, 0], 'junk', [0, 0, 'x', 5]], lights: [{ x: 10, y: 10, radius: 999 }], reveal: [[10, 10, -5, 20]] });
  assert.equal(upd.body.fog, true); assert.equal(upd.body.dark, true);
  assert.deepEqual(upd.body.walls[0], [1.2, 2, 300, 2, 1, 0]); assert.equal(upd.body.walls.length, 2);
  assert.equal(upd.body.lights[0].radius, 100); assert.deepEqual(upd.body.reveal[0], [10, 10, 5, 20]);
  const tk = await gm('POST', '/tokens', { sceneId: b.body.id, name: 'Prep', vision: 6, light: 3 });
  assert.equal(tk.body.vision, 6); assert.equal(tk.body.light, 3);
  assert.equal((await gm('GET', '/state')).body.tokens.length, 1);
  assert.equal((await pip('GET', '/state')).body.tokens.length, 0);
  assert.equal((await pip('GET', '/state')).body.scenes.length, 0);
  assert.equal(a.body.active, true);
});

test('uploads: sniffing, player limits, audio is GM only, ranges work', async () => {
  assert.equal((await gmUpload('image/png', Buffer.from('not a png at all'))).status, 400);
  const png = await pipUpload('image/png', PNG());
  assert.equal(png.status, 200); assert.equal(png.body.kind, 'image');
  assert.equal((await pipUpload('audio/mpeg', MP3)).status, 403);
  assert.equal((await pipUpload('image/png', Buffer.concat([PNG(), Buffer.alloc(6 * 1024 * 1024)]))).status, 413);
  const mp3 = await gmUpload('audio/mpeg', MP3);
  assert.equal(mp3.body.kind, 'audio');
  const full = await fetch(srv.base + mp3.body.url);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const part = await fetch(srv.base + mp3.body.url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${MP3.length}`);
  assert.equal((await fetch(srv.base + mp3.body.url, { headers: { Range: 'bytes=99999-' } })).status, 416);
  assert.equal((await upload('/api/t/feat', null, 'image/png', PNG())).status, 401); // no player picked
});

test('player portrait propagates to linked tokens; a player with the edit right may set its token image', async () => {
  const png = await pipUpload('image/png', PNG(3));
  const hero = await gm('POST', '/actors', { name: 'Hero' });
  await gm('PUT', `/actors/${hero.body.id}/perms`, { perms: { [pipSlot.id]: 'edit' } });
  const scene = await activeScene();
  const tok = await gm('POST', '/tokens', { sceneId: scene.id, actorId: hero.body.id });
  assert.equal(tok.body.image, null);
  const d = hero.body.data; d.portrait = png.body.url;
  await pip('PATCH', `/actors/${hero.body.id}`, { data: d });
  const after = (await pip('GET', '/state')).body.tokens.find((t) => t.id === tok.body.id);
  assert.equal(after.image, png.body.url);
  const own = await pip('PATCH', `/tokens/${tok.body.id}`, { image: null, name: 'hacked', vision: 99 });
  assert.equal(own.body.image, null); assert.equal(own.body.name, 'Hero'); assert.equal(own.body.vision, 0); // only x, y, image are player-editable
});

test('audio: GM plays/stops, players cannot, state exposes what is playing', async () => {
  const mp3 = await gmUpload('audio/mpeg', MP3);
  const snd = await gm('POST', '/sounds', { name: 'Tavern', url: mp3.body.url, loop: true, volume: 0.5 });
  assert.equal(snd.body.loop, true);
  assert.equal((await gm('POST', '/sounds', { name: 'x', url: '/uploads/evil.mp3' })).status, 400);
  assert.equal((await pip('POST', `/sounds/${snd.body.id}/play`)).status, 404); // not on the player door
  const sse = await srv.events('/api/t/feat/events', pip.cookie);
  const heard = sse.next((e) => e.type === 'audio');
  await gm('POST', `/sounds/${snd.body.id}/play`);
  const ev = await heard; sse.close();
  assert.equal(ev.op, 'play'); assert.equal(ev.id, snd.body.id);
  const st = (await pip('GET', '/state')).body;
  assert.equal(st.playing.length, 1); assert.equal(st.sounds.length, 1); assert.ok(Math.abs(st.serverTime - Date.now()) < 5000);
  await gm('POST', '/audio/stop');
  assert.equal((await pip('GET', '/state')).body.playing.length, 0);
});

test('journal visibility: gm / all / specific players; show pushes to viewers', async () => {
  const secret = await gm('POST', '/journals', { title: 'Secret', body: 'gm only' });
  const mine = await gm('POST', '/journals', { title: 'For Pip', body: '[int +0|check]', visibility: [pipSlot.id] });
  assert.deepEqual((await pip('GET', '/state')).body.journals.map((j) => j.title), ['For Pip']);
  assert.equal((await pip('POST', '/journals', { title: 'x' })).status, 404);
  await gm('POST', `/journals/${secret.body.id}/show`); // show makes a GM-only entry public
  assert.equal((await pip('GET', '/state')).body.journals.length, 2);
  await gm('PATCH', `/journals/${mine.body.id}`, { visibility: 'gm' });
  assert.equal((await pip('GET', '/state')).body.journals.length, 1);
});

test('equipment slots through the API: slots are validated, deduplicated and drive stats', async () => {
  const hero = await gm('POST', '/actors', { name: 'Knight' });
  const d = hero.body.data;
  d.items = [
    { name: 'Sword', type: 'weapon', usedSlots: ['weapon1'], bonuses: { strength: 2 } },
    { name: 'Second sword', type: 'weapon', usedSlots: ['Arme 1', 'weapon2'] },       // weapon1 already taken, weapon2 free
    { name: 'Helm', type: 'armor', equipExpr: '[head]', usedSlots: ['hat'], pdef: 3 },
    { name: 'Junk', type: 'other', usedSlots: ['not-a-slot'] },
  ];
  const r = await gm('PATCH', `/actors/${hero.body.id}`, { data: d });
  assert.deepEqual(r.body.data.items.map((i) => i.usedSlots), [['weapon1'], ['weapon2'], ['hat'], []]);
  assert.equal(r.body.data.items[0].equipExpr, '[weapons]');
  assert.equal(r.body.computed.stats.strength.item, 2); assert.equal(r.body.computed.pdef, 3);
  const scene = await activeScene();
  const tok = await gm('POST', '/tokens', { sceneId: scene.id, actorId: hero.body.id, sight: true });
  assert.equal(tok.body.sight, true);
  assert.equal((await gm('PATCH', `/tokens/${tok.body.id}`, { sight: false })).body.sight, false);
});

test('favor reroll: the GM pays a favor from the rolling character too', async () => {
  const npc = await gm('POST', '/actors', { name: 'Favored' });
  assert.equal(npc.body.data.fav.cur, 1);
  const roll = await gm('POST', '/chat', { text: '/con', actorId: npc.body.id });
  assert.equal((await gm('POST', `/chat/${roll.body.id}/reroll`)).status, 200);
  const after = (await gm('GET', '/state')).body.actors.find((a) => a.id === npc.body.id);
  assert.equal(after.data.fav.cur, 0);
  const again = await gm('POST', `/chat/${roll.body.id}/reroll`);
  assert.equal(again.status, 400); assert.match(again.body.error, /favor/i);
});

test('current HP/mana/favors follow their max: sheet edits, system edits, creation', async () => {
  const made = await gm('POST', '/actors', { name: 'Grower', data: { bio: { level: 2 }, hp: { cur: 0 } } });
  assert.equal(made.body.data.hp.cur, 15); // created full whatever data was sent (con 5 * (2+1))
  const d = made.body.data; d.hp.cur = 5; d.bio.level = 3;
  const up = await gm('PATCH', `/actors/${made.body.id}`, { data: d });
  assert.equal(up.body.data.hp.cur, 10); // max 15 -> 20: +5
  d.hp.cur = 10; d.bio.level = 1;
  assert.equal((await gm('PATCH', `/actors/${made.body.id}`, { data: d })).body.data.hp.cur, 10); // max 20 -> 10: capped (already 10)
  d.stats.constitution.base = 4;
  const down = await gm('PATCH', `/actors/${made.body.id}`, { data: d });
  assert.equal(down.body.data.hp.cur, 8);
  const plain = await gm('PATCH', `/actors/${made.body.id}`, { name: 'Grown' }); // no data: nothing moves
  assert.equal(plain.body.data.hp.cur, 8);
  // a system formula change moves every character by its own delta
  const sys = (await gm('GET', '/system')).body;
  const hpF = sys.derived.find((x) => x.id === 'maxhp');
  const old = hpF.formula; hpF.formula = `${old} + 10`;
  assert.equal((await gm('PUT', '/system', sys)).status, 200);
  const st = (await gm('GET', '/state')).body.actors.find((a) => a.id === made.body.id);
  assert.equal(st.computed.derived.maxhp, 18); assert.equal(st.data.hp.cur, 18);
  hpF.formula = old; await gm('PUT', '/system', sys);
  assert.equal((await gm('GET', '/state')).body.actors.find((a) => a.id === made.body.id).data.hp.cur, 8);
});

test('scenes: many GMs creating scenes at once, in several tables, all succeed; one scene stays active per table', async () => {
  const other = await srv.table('rush');
  const made = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? gm : other.gm)('POST', '/scenes', { name: `Rush ${i}`, width: 800, height: 600 })));
  assert.deepEqual(made.map((r) => r.status), made.map(() => 200));
  assert.equal(new Set(made.map((r) => r.body.id)).size, 24);
  for (const g of [gm, other.gm]) assert.equal((await g('GET', '/state')).body.scenes.filter((s) => s.active).length, 1);
  assert.equal((await other.gm('GET', '/state')).body.scenes.length, 12);
});

test('a malformed URL gets a 400 and the server keeps running', async () => {
  assert.equal((await fetch(srv.base + '/%E0')).status, 400);
  assert.equal((await fetch(srv.base + '/api/%E0%A4')).status, 400);
  assert.equal((await fetch(srv.base + '/api/tables')).status, 200);
});
