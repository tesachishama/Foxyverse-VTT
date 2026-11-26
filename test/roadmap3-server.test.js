// ROADMAP 3: server behaviours (rights are checked on the server, not only hidden buttons).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, T, gm, pip, pipSlot, scene;
before(async () => {
  srv = await startServer();
  T = await srv.table('r3');
  gm = T.gm;
  pipSlot = await T.slot('Pip');
  pip = await T.join(pipSlot.id);
  scene = (await gm('POST', '/scenes', { name: 'S', width: 1000, height: 1000, grid: 50 })).body;
});
after(() => srv.stop());

test('1.2 a deleted token comes back on undo with its look (life is accepted on creation); players cannot delete tokens or edit the map', async () => {
  const tk = (await gm('POST', '/tokens', { sceneId: scene.id, name: 'Back', x: 10, y: 10, life: 'dead', hidden: true })).body;
  assert.equal(tk.life, 'dead'); assert.equal(tk.hidden, true);
  assert.equal((await gm('POST', '/tokens', { sceneId: scene.id, life: 'zombie' })).body.life, 'auto');
  assert.equal((await pip('DELETE', `/tokens/${tk.id}`)).status, 404); // no such route on the player door
  assert.equal((await pip('PATCH', `/scenes/${scene.id}`, { walls: [] })).status, 404);
  assert.equal((await gm('DELETE', `/tokens/${tk.id}`)).status, 200);
});

export { srv, T, gm, pip, pipSlot, scene };

test('1.3 revealed areas: rectangles and polygons are stored, junk and polygons under 3 points are dropped', async () => {
  const r = await gm('PATCH', `/scenes/${scene.id}`, { reveal: [[1, 2, -3, 4], { poly: [[0, 0], [10.04, 0], [0, 'x'], [5, 5]] }, { poly: [[0, 0], [1, 1]] }, 'junk', { poly: 7 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.reveal, [[1, 2, 3, 4], { poly: [[0, 0], [10, 0], [0, 0], [5, 5]] }]);
  await gm('PATCH', `/scenes/${scene.id}`, { reveal: [] });
});

test('1.6 a click on a TP ghost: the player\'s token jumps to the ghost (linked cell), and a ghost stays on the cell it left', async () => {
  const sc = (await gm('POST', '/scenes', { name: 'TP', width: 1000, height: 1000, grid: 50,
    tps: [{ id: 'a', x: 75, y: 75, group: 'g' }, { id: 'b', x: 775, y: 775, group: 'g' }], walls: [[400, 0, 400, 1000, 0, 0, 0, 1, 1]] })).body;
  await gm('POST', `/scenes/${sc.id}/activate`);
  const hero = (await gm('POST', '/actors', { name: 'Jumper' })).body;
  await gm('PUT', `/actors/${hero.id}/perms`, { perms: { [pipSlot.id]: 'edit' } });
  const tk = (await gm('POST', '/tokens', { sceneId: sc.id, actorId: hero.id, x: 75, y: 75 })).body;
  // the click sends the ghost's own position, "via" the cell it stands on (a tangible wall between the cells does not matter)
  const r = await pip('PATCH', `/tokens/${tk.id}`, { x: 775, y: 775, via: 'b' });
  assert.equal(r.status, 200); assert.deepEqual([r.body.x, r.body.y], [775, 775]);
  const { ghostsOf } = await import('../public/tp.js');
  const ghosts = ghostsOf([r.body], (await gm('GET', '/state')).body.scenes.find((s) => s.id === sc.id).tps, 50);
  assert.deepEqual(ghosts.map((g) => [g.x, g.y]), [[75, 75]]); // the old cell now shows the ghost
  assert.equal((await pip('PATCH', `/tokens/${tk.id}`, { x: 75, y: 75, via: 'zzz' })).status, 409); // not a linked cell
});
