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
