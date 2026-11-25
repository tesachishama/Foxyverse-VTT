// ROADMAP 2 behaviours through the HTTP API (rights are checked by the server, not only hidden in the page).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, T, gm, pip, quill, pipSlot, quillSlot, scene;
before(async () => {
  srv = await startServer();
  T = await srv.table('r2');
  gm = T.gm;
  pipSlot = await T.slot('Pip'); quillSlot = await T.slot('Quill');
  pip = await T.join(pipSlot.id); quill = await T.join(quillSlot.id);
  scene = (await gm('POST', '/scenes', { name: 'Hall', width: 1400, height: 1000, grid: 70 })).body;
});
after(() => srv.stop());

const sheet = async (name, perms = {}) => {
  const a = (await gm('POST', '/actors', { name })).body;
  if (Object.keys(perms).length) await gm('PUT', `/actors/${a.id}/perms`, { perms });
  return a;
};
const hpOf = async (id) => (await gm('GET', '/state')).body.actors.find((a) => a.id === id).data.hp.cur;

test('1.1 armor per roll through the API: the applied entry lists every roll and its reduction', async () => {
  const a = await sheet('Armored');
  const d = a.data; d.stats.constitution.base = 20; d.items = [{ name: 'Plate', type: 'armor', usedSlots: ['torso'], pdef: 4 }];
  await gm('PATCH', `/actors/${a.id}`, { data: d });
  const tok = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: a.id })).body;
  const before = await hpOf(a.id);
  const r = await gm('POST', '/chat', { text: '/pdmg 3 6' }); // three rolls of 6
  const ap = (await gm('POST', `/chat/${r.body.id}/apply`, { tokenIds: [tok.id] })).body.body.applied[0];
  assert.deepEqual(ap.rolls, [{ raw: 6, armor: 4, dealt: 2 }, { raw: 6, armor: 4, dealt: 2 }, { raw: 6, armor: 4, dealt: 2 }]);
  assert.equal(ap.dealt, 6); assert.equal(await hpOf(a.id), before - 6);
  await gm('POST', `/chat/${r.body.id}/undo`, { entryId: ap.id });
  assert.equal(await hpOf(a.id), before);
});

test('1.3 players apply and undo only on tokens of sheets they can edit (403 otherwise, checked server-side)', async () => {
  const mine = await sheet('Mine', { [pipSlot.id]: 'edit', [quillSlot.id]: 'view' });
  const other = await sheet('Other');
  const t1 = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: mine.id })).body;
  const t2 = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: other.id })).body;
  const loose = (await gm('POST', '/tokens', { sceneId: scene.id, name: 'Barrel' })).body;
  const dmg = await pip('POST', '/chat', { text: '/tdmg 3' });
  const apply = (who, ids) => who('POST', `/chat/${dmg.body.id}/apply`, { tokenIds: ids });
  assert.equal((await apply(quill, [t1.id])).status, 403); // view right only
  assert.equal((await apply(pip, [t2.id])).status, 403);   // no right at all
  assert.equal((await apply(pip, [loose.id])).status, 403); // no sheet behind it
  const hp = await hpOf(mine.id);
  assert.equal((await apply(pip, [t1.id, t2.id])).status, 403); // one forbidden target: nothing is applied
  assert.equal(await hpOf(mine.id), hp);
  const ok = await apply(pip, [t1.id]);
  assert.equal(ok.status, 200); assert.equal(await hpOf(mine.id), hp - 3);
  const entry = ok.body.body.applied.at(-1);
  assert.equal((await quill('POST', `/chat/${dmg.body.id}/undo`, { entryId: entry.id })).status, 403);
  assert.equal((await pip('POST', `/chat/${dmg.body.id}/undo`, { entryId: entry.id })).status, 200);
  assert.equal(await hpOf(mine.id), hp);
  // the GM's application on someone else's sheet cannot be undone by the player either
  const g = (await gm('POST', `/chat/${dmg.body.id}/apply`, { tokenIds: [t2.id] })).body.body.applied.at(-1);
  assert.equal((await pip('POST', `/chat/${dmg.body.id}/undo`, { entryId: g.id })).status, 403);
  // a hidden token is not the player's to target, even with the edit right
  await gm('PATCH', `/tokens/${t1.id}`, { hidden: true });
  assert.equal((await apply(pip, [t1.id])).status, 403);
});

test('1.4 aliases: made from the name, unique in the table, GM-only, follow renames until set by hand, mj/gm refused', async () => {
  const a = await sheet('Gwen Doline', { [pipSlot.id]: 'edit' });
  const b = await sheet('Gwen  Doline');
  assert.equal(a.alias, 'GwenDoline'); assert.equal(b.alias, 'GwenDoline2');
  assert.equal((await pip('GET', '/state')).body.actors.find((x) => x.id === a.id).alias, undefined); // players never see it
  assert.equal((await pip('PATCH', `/actors/${a.id}`, { alias: 'Hack' })).status, 403);
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { name: 'Gwen the Second' })).body.alias, 'GwentheSecond'); // follows the name
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: 'Gwen 2' })).body.alias, 'Gwen2');
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { name: 'Renamed' })).body.alias, 'Gwen2'); // set by hand: kept
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: 'gwendoline' })).body.alias, 'gwendoline2'); // taken: a number
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: 'MJ' })).status, 400);
  assert.equal((await gm('PATCH', `/actors/${b.id}`, { alias: '' })).body.alias, 'Renamed'); // empty: back to the name
  const n = await gm('POST', '/chat', { text: '@GwenDoline Hello\n@Renamed Hi' });
  assert.deepEqual(n.body.body.parts.map((p) => [p.actorId, p.name, p.text]), [[a.id, 'Gwen Doline', 'Hello'], [b.id, 'Renamed', 'Hi']]);
});

test('3 walls and lights are sanitised: two wall properties, door lock, light kind, radius in half cells', async () => {
  const sc = (await gm('POST', '/scenes', { name: 'Walls' })).body;
  const r = await gm('PATCH', `/scenes/${sc.id}`, {
    walls: [[0, 0, 100, 0, 0, 0, 0, 1, 0], [0, 0, 0, 100, 1, 0, 'yes', 0, 0], [5, 5, 9, 9]],
    lights: [{ x: 10, y: 10, radius: 2.3 }, { x: 20, y: 20, radius: 4, kind: 'anti', playersWin: 1 }, { x: 1, y: 1, radius: 1, kind: 'evil', playersWin: true }],
  });
  assert.deepEqual(r.body.walls, [[0, 0, 100, 0, 0, 0, 0, 1, 0], [0, 0, 0, 100, 1, 0, 1, 0, 0], [5, 5, 9, 9, 0, 0, 0, 0, 1]]);
  assert.deepEqual(r.body.lights.map((l) => [l.radius, l.kind, l.playersWin]), [[2.5, 'light', false], [4, 'anti', true], [1, 'light', false]]);
});

test('3 doors: players open and close them on the active scene, a locked one only the GM; found by their ends', async () => {
  const p = await sheet('Opener', { [pipSlot.id]: 'edit' });
  const door = [500, 0, 500, 1000];
  await gm('PATCH', `/scenes/${scene.id}`, { walls: [[...door, 1, 0, 0, 1, 1]] });
  const open = await pip('POST', `/scenes/${scene.id}/door`, { at: door, open: true });
  assert.equal(open.status, 200); assert.equal(open.body.walls[0][5], 1);
  assert.equal((await pip('POST', `/scenes/${scene.id}/door`, { at: door })).body.walls[0][5], 0); // toggles
  assert.equal((await pip('POST', `/scenes/${scene.id}/door`, { at: [1, 2, 3, 4] })).status, 400);
  await gm('PATCH', `/scenes/${scene.id}`, { walls: [[...door, 1, 0, 1, 1, 1]] }); // locked
  assert.equal((await pip('POST', `/scenes/${scene.id}/door`, { at: door, open: true })).status, 403);
  assert.equal((await gm('POST', `/scenes/${scene.id}/door`, { at: door, open: true })).body.walls[0][5], 1);
  const other = (await gm('POST', '/scenes', { name: 'Elsewhere' })).body; // not the active scene: players do not reach it
  await gm('PATCH', `/scenes/${other.id}`, { walls: [[...door, 1, 0, 0, 1, 1]] });
  assert.equal((await pip('POST', `/scenes/${other.id}/door`, { at: door })).status, 404);
  void p;
});

test('3 tangible walls and closed doors stop players\' tokens (server-side); the GM always passes', async () => {
  const p = await sheet('Walker', { [pipSlot.id]: 'edit' });
  const tok = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: p.id, x: 105, y: 105 })).body;
  const move = (who, x, y) => who('PATCH', `/tokens/${tok.id}`, { x, y });
  await gm('PATCH', `/scenes/${scene.id}`, { walls: [[300, 0, 300, 1000, 0, 0, 0, 1, 0], [600, 0, 600, 1000, 0, 0, 0, 0, 1], [800, 0, 800, 1000, 1, 0, 0, 1, 1]] });
  assert.equal((await move(pip, 250, 105)).status, 200);
  assert.equal((await move(pip, 350, 105)).status, 409);  // tangible wall at x 300
  assert.equal((await gm('GET', '/state')).body.tokens.find((t) => t.id === tok.id).x, 250); // not moved
  assert.equal((await move(gm, 350, 105)).status, 200);   // the GM goes through
  assert.equal((await move(pip, 700, 105)).status, 200);  // a sight-only wall does not stop movement
  assert.equal((await move(pip, 850, 105)).status, 409);  // closed door
  await pip('POST', `/scenes/${scene.id}/door`, { at: [800, 0, 800, 1000], open: true });
  assert.equal((await move(pip, 850, 105)).status, 200);  // open door
});

test('3 tokens say whether they are a player\'s (their light can beat an anti-light)', async () => {
  const npc = await sheet('Npc');
  const tok = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: npc.id, light: 3 })).body;
  assert.equal(tok.pc, false);
  await gm('PUT', `/actors/${npc.id}/perms`, { perms: { [quillSlot.id]: 'edit' } });
  assert.equal((await gm('GET', '/state')).body.tokens.find((t) => t.id === tok.id).pc, true);
});

test('4 vision: new tokens see 100 cells, 0 means none; darkvision comes from the sheet; scene options shared vision and memory', async () => {
  const a = await sheet('Seer', { [pipSlot.id]: 'edit' });
  const tok = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: a.id })).body;
  assert.equal(tok.vision, 100); assert.equal(tok.darkvision, false);
  assert.equal((await gm('PATCH', `/tokens/${tok.id}`, { vision: 0 })).body.vision, 0);
  const d = a.data; d.darkvision = true;
  assert.equal((await pip('PATCH', `/actors/${a.id}`, { data: d })).body.data.darkvision, true);
  assert.equal((await pip('GET', '/state')).body.tokens.find((t) => t.id === tok.id).darkvision, true);
  d.darkvision = 'yes';
  assert.equal((await pip('PATCH', `/actors/${a.id}`, { data: d })).body.data.darkvision, false); // only a real true
  const sc = (await gm('POST', '/scenes', { name: 'Options' })).body;
  assert.equal(sc.sharedVision, false); assert.equal(sc.explore, true);
  const up = (await gm('PATCH', `/scenes/${sc.id}`, { sharedVision: 1, explore: false })).body;
  assert.equal(up.sharedVision, true); assert.equal(up.explore, false);
});

test('4 exploration memory: per player slot and scene, ORed by the server, reset by the GM per player or for all', async () => {
  await gm('PATCH', `/scenes/${scene.id}`, { fog: true, explore: true });
  const sc = (await gm('GET', '/state')).body.scene;
  const empty = (await pip('GET', `/scenes/${sc.id}/explored`)).body;
  const size = Math.ceil((empty.cols * empty.rows) / 8);
  assert.equal(empty.cell, sc.grid / 2); assert.equal(empty.bits, '');
  const bits = (fill) => Buffer.alloc(size, fill).toString('base64');
  const send = (who, b) => who('POST', `/scenes/${sc.id}/explored`, { cols: empty.cols, rows: empty.rows, bits: b });
  await send(pip, bits(0b0001));
  const merged = (await send(pip, bits(0b0100))).body; // OR: nothing seen is lost
  assert.equal(Buffer.from(merged.bits, 'base64')[0], 0b0101);
  assert.equal((await pip('GET', `/scenes/${sc.id}/explored`)).body.bits, merged.bits); // back after a reload, from any device
  assert.equal((await quill('GET', `/scenes/${sc.id}/explored`)).body.bits, ''); // each player their own
  await send(quill, bits(0b1000));
  assert.equal((await gm('GET', `/scenes/${sc.id}/explored?slot=${pipSlot.id}`)).body.bits, merged.bits); // the GM can look as a player
  assert.equal((await send(pip, 'AAAA')).status, 400); // wrong size
  assert.equal((await pip('POST', `/scenes/${sc.id}/explored`, { cols: 1, rows: 1, bits: 'AA==' })).status, 409); // map changed
  assert.equal((await pip('DELETE', `/scenes/${sc.id}/explored`)).status, 404); // GM only
  await gm('DELETE', `/scenes/${sc.id}/explored?slot=${pipSlot.id}`);
  assert.equal((await pip('GET', `/scenes/${sc.id}/explored`)).body.bits, '');
  assert.notEqual((await quill('GET', `/scenes/${sc.id}/explored`)).body.bits, '');
  await gm('DELETE', `/scenes/${sc.id}/explored`);
  assert.equal((await quill('GET', `/scenes/${sc.id}/explored`)).body.bits, '');
  await gm('PATCH', `/scenes/${sc.id}`, { explore: false }); // memory off: nothing kept
  assert.equal((await send(pip, bits(0xff))).body.bits, '');
  await gm('PATCH', `/scenes/${sc.id}`, { fog: false, explore: true });
});

test('4 exploration memory remembers what was seen only through darkvision (it stays black and white)', async () => {
  const sc = (await gm('POST', '/scenes', { name: 'Grey' })).body;
  await gm('POST', `/scenes/${sc.id}/activate`);
  try {
    await gm('PATCH', `/scenes/${sc.id}`, { fog: true, explore: true });
    const e = (await pip('GET', `/scenes/${sc.id}/explored`)).body, size = Math.ceil((e.cols * e.rows) / 8);
    const b = (v) => Buffer.alloc(size, v).toString('base64');
    const send = (bits, color) => pip('POST', `/scenes/${sc.id}/explored`, { cols: e.cols, rows: e.rows, bits, color });
    const r1 = (await send(b(0b0011), b(0b0001))).body; // cell 0 in colour, cell 1 only through darkvision
    assert.equal(Buffer.from(r1.bits, 'base64')[0], 0b0011); assert.equal(Buffer.from(r1.color, 'base64')[0], 0b0001);
    const r2 = (await send(b(0b0010), b(0b0010))).body; // later seen in colour: it gets its colours back
    assert.equal(Buffer.from(r2.color, 'base64')[0], 0b0011);
    assert.equal((await send(b(0), 'AA')).status, 400); // wrong colour size
  } finally { await gm('POST', `/scenes/${scene.id}/activate`); }
});

test('5 TP cells are stored and sanitised; a player moves on from a ghost only from a linked cell, walls checked from there', async () => {
  const p = await sheet('Jumper', { [pipSlot.id]: 'edit' });
  const r = await gm('PATCH', `/scenes/${scene.id}`, {
    walls: [[560, 0, 560, 1000, 0, 0, 0, 1, 0]], // a tangible wall between the two cells
    tps: [{ id: 'a', x: 105, y: 105, group: 'x' }, { id: 'b', x: 805, y: 105, group: 'x' }, { id: 'c', x: 805, y: 805, group: 'y' }, { x: 'bad', y: 1 }],
  });
  assert.deepEqual(r.body.tps.slice(0, 3).map((c) => [c.id, c.x, c.y, c.group]), [['a', 105, 105, 'x'], ['b', 805, 105, 'x'], ['c', 805, 805, 'y']]);
  assert.equal(r.body.tps[3].x, 0); assert.equal(r.body.tps[3].group, '1');
  const tok = (await gm('POST', '/tokens', { sceneId: scene.id, actorId: p.id, x: 105, y: 105 })).body;
  const move = (body) => pip('PATCH', `/tokens/${tok.id}`, body);
  assert.equal((await move({ x: 875, y: 105 })).status, 409);            // walking: the wall is in the way
  assert.equal((await move({ x: 875, y: 105, via: 'c' })).status, 409);  // not linked to the cell it stands on
  const jump = await move({ x: 875, y: 105, via: 'b' });                  // from the ghost on b: teleports, then one cell further
  assert.equal(jump.status, 200); assert.equal(jump.body.x, 875);
  assert.equal((await move({ x: 875, y: 175, via: 'a' })).status, 409);  // no longer on a TP cell
  await move({ x: 805, y: 105 });                                          // back on b
  assert.equal((await move({ x: 105, y: 175, via: 'a' })).status, 200);  // links go both ways
  await gm('PATCH', `/scenes/${scene.id}`, { walls: [], tps: [] });
});
