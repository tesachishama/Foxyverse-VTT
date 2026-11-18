// Tables, player slots (presence, grace, kick), isolation between tables, the map library and the GM door.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const GRACE = 400;
let srv;
before(async () => { srv = await startServer({ SLOT_GRACE_MS: String(GRACE) }); });
after(() => srv.stop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('tables: addresses are validated, reserved words refused, listed / unlisted', async () => {
  const { call } = srv;
  const mk = (b) => call('POST', '/admin/api/tables', b);
  assert.equal((await mk({ name: 'Ma table', slug: 'ma-table' })).body.slug, 'ma-table');
  for (const slug of ['admin', 'api', 'icons', 'uploads', 'assets']) assert.equal((await mk({ slug })).status, 400, slug);
  for (const slug of ['', 'Has Space', '-edge', 'a/b', 'x'.repeat(41)]) assert.equal((await mk({ slug })).status, 400, slug);
  assert.equal((await mk({ slug: 'ma-table' })).status, 400); // taken
  assert.equal((await mk({ name: 'Secret', slug: 'hidden', listed: false })).body.listed, false);
  const listed = (await call('GET', '/api/tables')).body.tables.map((t) => t.slug);
  assert.ok(listed.includes('ma-table')); assert.ok(!listed.includes('hidden'));
  assert.equal((await call('GET', '/api/t/hidden/lobby')).status, 200); // reachable by its link
  assert.equal((await call('GET', '/api/t/nope/lobby')).status, 404);
  const ren = await call('PATCH', '/admin/api/tables/hidden', { name: 'Renamed', slug: 'moved', listed: true });
  assert.equal(ren.body.slug, 'moved'); assert.equal(ren.body.name, 'Renamed');
  assert.equal((await call('PATCH', '/admin/api/tables/moved', { slug: 'ma-table' })).status, 400);
  assert.equal((await call('GET', '/api/t/hidden/lobby')).status, 404);
  for (const page of ['/', '/ma-table', '/admin', '/admin/ma-table']) {
    const r = await fetch(srv.base + page); assert.equal(r.status, 200, page); assert.match(await r.text(), /Foxyverse VTT/);
  }
  assert.ok((await call('GET', '/admin/api/tables')).body.devMode);
  assert.match(srv.logs(), /ADMIN_SECRET is empty/);
});

test('slots: one session per slot, 60 s-style grace after the page closes, switching and leaving free it', async () => {
  const T = await srv.table('presence');
  const a = await T.slot('Aria'), b = await T.slot('Bram');
  const lobby = async (cookie) => (await srv.call('GET', '/api/t/presence/lobby', null, cookie)).body;
  assert.deepEqual((await lobby()).slots.map((s) => [s.name, s.online]), [['Aria', false], ['Bram', false]]);
  const p1 = await T.join(a.id);
  assert.equal((await lobby(p1.cookie)).me, a.id);
  assert.equal((await lobby()).slots[0].online, true);
  assert.equal((await srv.call('POST', '/api/t/presence/join', { slotId: a.id })).status, 409); // somebody else's browser
  const rejoined = await T.join(a.id, p1.cookie); // the same browser picking its own slot again is fine
  assert.equal((await rejoined('GET', '/state')).status, 200);
  // an open page keeps the slot past the grace period
  const sse = await srv.events('/api/t/presence/events', p1.cookie);
  await wait(GRACE + 150);
  assert.equal((await srv.call('POST', '/api/t/presence/join', { slotId: a.id })).status, 409);
  // page closed: still taken during the grace (a reload comes back), then free
  sse.close(); await wait(100);
  assert.equal((await srv.call('POST', '/api/t/presence/join', { slotId: a.id })).status, 409);
  assert.equal((await p1('GET', '/state')).status, 200); // the reload
  await wait(GRACE + 150);
  assert.equal((await lobby()).slots[0].online, false);
  const p2 = await T.join(a.id); // another browser takes the free slot
  assert.equal((await p1('GET', '/state')).status, 401); // the old one has to pick again
  // switching player frees the previous slot; leaving frees the current one
  await T.join(b.id, p2.cookie);
  assert.deepEqual((await lobby()).slots.map((s) => s.online), [false, true]);
  await srv.call('POST', '/api/t/presence/leave', null, p2.cookie);
  assert.deepEqual((await lobby()).slots.map((s) => s.online), [false, false]);
  assert.equal((await p2('GET', '/state')).status, 401);
});

test('kick: the GM frees a slot at once and closes the player\'s page', async () => {
  const T = await srv.table('kicks');
  const s = await T.slot('Ghost');
  const p = await T.join(s.id);
  const sse = await srv.events('/api/t/kicks/events', p.cookie);
  const gone = sse.next((e) => e.type === 'kicked');
  const gmSse = await srv.events('/admin/api/t/kicks/events');
  const offline = gmSse.next((e) => e.type === 'user' && e.data.id === s.id && !e.data.online);
  assert.equal((await T.gm('POST', `/slots/${s.id}/kick`)).body.online, false);
  assert.ok(await gone); assert.ok(await offline); gmSse.close();
  assert.equal((await p('GET', '/state')).status, 401);
  assert.equal((await srv.call('POST', '/api/t/kicks/join', { slotId: s.id })).status, 200); // free straight away
  // deleting a slot also removes its sheet rights
  const hero = await T.gm('POST', '/actors', { name: 'Hero' });
  await T.gm('PUT', `/actors/${hero.body.id}/perms`, { perms: { [s.id]: 'edit' } });
  assert.equal((await T.gm('DELETE', `/slots/${s.id}`)).status, 200);
  assert.deepEqual((await T.gm('GET', '/state')).body.actors[0].perms, {});
  assert.equal((await T.gm('PATCH', `/slots/${s.id}`, { name: 'x' })).status, 404);
});

test('tables are isolated: ids from another table are not found, a player cookie only works at its table', async () => {
  const A = await srv.table('iso-a'), B = await srv.table('iso-b');
  const sa = await A.slot('Ann');
  const pa = await A.join(sa.id);
  const heroA = await A.gm('POST', '/actors', { name: 'A hero' });
  const sceneA = await A.gm('POST', '/scenes', { name: 'A map' });
  await A.gm('POST', '/chat', { text: 'hello A' });
  assert.equal((await B.gm('PATCH', `/actors/${heroA.body.id}`, { name: 'stolen' })).status, 404);
  assert.equal((await B.gm('PATCH', `/scenes/${sceneA.body.id}`, { name: 'stolen' })).status, 404);
  assert.equal((await B.gm('POST', '/tokens', { sceneId: sceneA.body.id })).status, 400);
  const stB = (await B.gm('GET', '/state')).body;
  assert.equal(stB.actors.length, 0); assert.equal(stB.scenes.length, 0); assert.equal(stB.chat.length, 0);
  assert.equal((await srv.call('GET', '/api/t/iso-b/state', null, pa.cookie)).status, 401);
  // each table has its own rules
  const sys = stB.system; sys.derived.find((d) => d.id === 'maxhp').formula = 'con*100';
  await B.gm('PUT', '/system', sys);
  assert.equal((await A.gm('GET', '/state')).body.actors[0].computed.derived.maxhp, 10);
  // a table's realtime channel stays inside it
  const sseB = await srv.events('/admin/api/t/iso-b/events');
  const firstB = sseB.next((e) => e.type === 'chat');
  await A.gm('POST', '/chat', { text: 'only A' });
  await B.gm('POST', '/chat', { text: 'only B' });
  assert.equal((await firstB).data.body.text, 'only B'); sseB.close();
});

test('map library: maps outside any table, copied into tables (and back), tokens not copied', async () => {
  const { call } = srv;
  const lib = await call('POST', '/admin/api/library/scenes', { name: 'Dungeon', width: 900, height: 600, walls: [[0, 0, 100, 0, 0, 0]], lights: [{ x: 5, y: 5, radius: 4 }] });
  assert.equal(lib.status, 200); assert.equal(lib.body.active, false);
  await call('PATCH', `/admin/api/library/scenes/${lib.body.id}`, { grid: 50 });
  assert.deepEqual((await call('GET', '/admin/api/library')).body.scenes.map((s) => [s.name, s.grid]), [['Dungeon', 50]]);
  const T = await srv.table('libcopy');
  const copy = await call('POST', `/admin/api/scenes/${lib.body.id}/copy`, { table: 'libcopy' });
  assert.equal(copy.body.active, true); // first scene of the table
  assert.deepEqual(copy.body.walls, [[0, 0, 100, 0, 0, 0]]); assert.equal(copy.body.grid, 50);
  assert.notEqual(copy.body.id, lib.body.id);
  await T.gm('POST', '/tokens', { sceneId: copy.body.id, name: 'Orc' });
  await T.gm('PATCH', `/scenes/${copy.body.id}`, { name: 'Dungeon (played)' });
  assert.equal((await call('GET', '/admin/api/library')).body.scenes[0].name, 'Dungeon'); // the original is untouched
  const back = await call('POST', `/admin/api/scenes/${copy.body.id}/copy`, { table: null, name: 'Dungeon v2' });
  assert.equal((await call('GET', '/admin/api/library')).body.scenes.length, 2);
  assert.equal(back.body.name, 'Dungeon v2');
  assert.equal((await call('POST', `/admin/api/scenes/${lib.body.id}/copy`, { table: 'nope' })).status, 400);
  assert.equal((await call('PATCH', `/admin/api/library/scenes/${copy.body.id}`, { name: 'x' })).status, 404); // a table scene is not a library map
  assert.equal((await call('DELETE', `/admin/api/library/scenes/${back.body.id}`)).status, 200);
});

test('deleting a table removes everything in it and closes its pages', async () => {
  const T = await srv.table('doomed');
  const s = await T.slot('Last');
  const p = await T.join(s.id);
  await T.gm('POST', '/actors', { name: 'Gone soon' });
  await T.gm('POST', '/scenes', { name: 'Gone map' });
  const sse = await srv.events('/api/t/doomed/events', p.cookie);
  const gone = sse.next((e) => e.type === 'gone');
  assert.equal((await srv.call('DELETE', '/admin/api/tables/doomed')).status, 200);
  assert.ok(await gone);
  assert.equal((await srv.call('GET', '/api/t/doomed/lobby')).status, 404);
  assert.equal((await srv.call('GET', '/admin/api/t/doomed/state')).status, 404);
});

test('ADMIN_SECRET: the GM door only opens with the secret header from the proxy', async () => {
  const locked = await startServer({ ADMIN_SECRET: 'proxy-only-secret' });
  try {
    const { call } = locked;
    assert.equal((await call('GET', '/admin/api/tables')).status, 403);
    assert.equal((await call('GET', '/admin/api/tables', null, null, { 'X-Admin-Secret': 'wrong' })).status, 403);
    assert.equal((await fetch(locked.base + '/admin')).status, 403);
    assert.equal((await fetch(locked.base + '/admin/some-table')).status, 403);
    const ok = { 'X-Admin-Secret': 'proxy-only-secret' };
    assert.equal((await call('POST', '/admin/api/tables', { slug: 'locked' }, null, ok)).status, 200);
    assert.equal((await call('GET', '/admin/api/tables', null, null, ok)).body.devMode, false);
    assert.equal((await fetch(locked.base + '/admin', { headers: ok })).status, 200);
    // the player door does not need it
    assert.equal((await call('GET', '/api/tables')).status, 200);
    assert.equal((await call('GET', '/api/t/locked/lobby')).status, 200);
    assert.doesNotMatch(locked.logs(), /ADMIN_SECRET is empty/);
  } finally { await locked.stop(); }
});
