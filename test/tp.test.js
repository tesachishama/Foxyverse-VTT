// ROADMAP 2 §5: teleport cells (public/tp.js is pure), ghosts and their vision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cellCenter, tpAt, linkedTps, ghostsOf, ghostStart, tpGroups, newGroup } from '../public/tp.js';
import { computeVision } from '../public/vision.js';

const tps = [{ id: 'a', x: 35, y: 35, group: '1' }, { id: 'b', x: 735, y: 35, group: '1' }, { id: 'c', x: 735, y: 735, group: '1' }, { id: 'd', x: 385, y: 385, group: '2' }];

test('5 TP cells sit on cell centres; a token stands on one when it is in its cell', () => {
  assert.deepEqual(cellCenter({ grid: 70, ox: 0, oy: 0 }, 100, 20), { x: 105, y: 35 });
  assert.equal(tpAt(tps, 70, 40, 30)?.id, 'a'); assert.equal(tpAt(tps, 70, 80, 30), null);
});

test('5 groups link any number of cells; ghosts appear on every linked cell, none for a lone cell', () => {
  assert.deepEqual(linkedTps(tps, tps[0]).map((c) => c.id), ['b', 'c']);
  const tok = { id: 1, x: 35, y: 35 };
  assert.deepEqual(ghostsOf([tok], tps, 70).map((g) => [g.to.id, g.x, g.y]), [['b', 735, 35], ['c', 735, 735]]);
  assert.deepEqual(ghostsOf([{ id: 2, x: 385, y: 385 }], tps, 70), []); // group 2 has one cell
  assert.deepEqual(ghostsOf([{ id: 3, x: 200, y: 200 }], tps, 70), []); // not on a cell
  assert.deepEqual(tpGroups(tps).map(([g, cells]) => [g, cells.length]), [['1', 3], ['2', 1]]);
  assert.equal(newGroup(tps), '3');
});

test('5 a move from a ghost starts on a cell linked to the one the token stands on, nowhere else', () => {
  const tok = { x: 35, y: 35 };
  assert.deepEqual(ghostStart(tps, 70, tok, 'c'), { x: 735, y: 735 });
  assert.equal(ghostStart(tps, 70, tok, 'd'), null); // another group
  assert.equal(ghostStart(tps, 70, tok, 'a'), null); // its own cell
  assert.equal(ghostStart(tps, 70, { x: 300, y: 300 }, 'b'), null); // not on a TP cell
});

test('5 ghosts give the vision seen from their cell', () => {
  const scene = { width: 1000, height: 1000, grid: 70, walls: [[500, 0, 500, 1000, 0, 0]] };
  const tok = { x: 35, y: 35, vision: 100 };
  const eyes = [tok, ...ghostsOf([tok], tps, 70).map((g) => ({ x: g.x, y: g.y, vision: tok.vision }))];
  assert.ok(!computeVision(scene, [tok], []).canSee(800, 400)); // behind the wall from the token...
  assert.ok(computeVision(scene, eyes, []).canSee(800, 400));   // ...but seen from its ghosts on the other side
});
