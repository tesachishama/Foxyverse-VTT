// ROADMAP 2 §3: walls (two properties), doors, wall editing, lights and anti-lights. Pure modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normWall, makeWall, blocksSight, blocksMove, moveBlocked, splitWall, nodesAt, moveNodes, mergeOnRelease, radiusStep, W } from '../public/walls.js';
import { computeVision } from '../public/vision.js';

const room = (walls = [], extra = {}) => ({ width: 1000, height: 1000, grid: 100, walls, ...extra });

test('3 a wall has two properties: movement, and sight + light; presets; old walls block sight only', () => {
  assert.deepEqual(normWall([0, 0, 10, 0, 0, 0]), [0, 0, 10, 0, 0, 0, 0, 0, 1]);
  const wall = makeWall(0, 0, 1, 1, 'wall'), tangible = makeWall(0, 0, 1, 1, 'tangible'), both = makeWall(0, 0, 1, 1, 'both');
  assert.deepEqual([blocksSight(wall), blocksMove(wall)], [true, false]);
  assert.deepEqual([blocksSight(tangible), blocksMove(tangible)], [false, true]);
  assert.deepEqual([blocksSight(both), blocksMove(both)], [true, true]);
});

test('3 tangible walls stop movement, not sight; closed doors stop both, open doors nothing', () => {
  const tangible = makeWall(500, 0, 500, 1000, 'tangible');
  assert.ok(moveBlocked([tangible], 100, 500, 900, 500)); assert.ok(!moveBlocked([tangible], 100, 500, 400, 500));
  assert.ok(computeVision(room([tangible]), [{ x: 100, y: 500, vision: 100 }], []).canSee(900, 500)); // sight goes through
  const sightOnly = makeWall(500, 0, 500, 1000, 'wall');
  assert.ok(!moveBlocked([sightOnly], 100, 500, 900, 500));
  const door = makeWall(500, 0, 500, 1000, 'wall', true);
  assert.ok(moveBlocked([door], 100, 500, 900, 500)); assert.ok(!computeVision(room([door]), [{ x: 100, y: 500, vision: 100 }], []).canSee(900, 500));
  door[W.open] = 1;
  assert.ok(!moveBlocked([door], 100, 500, 900, 500)); assert.ok(computeVision(room([door]), [{ x: 100, y: 500, vision: 100 }], []).canSee(900, 500));
  assert.ok(moveBlocked([tangible], 500, 500, 600, 500)); // touching the wall counts
});

test('3 editor: a node added on a segment splits it, both halves keep their properties', () => {
  const walls = [makeWall(0, 0, 100, 0, 'both')];
  const out = splitWall(walls, 0, 40, 0);
  assert.deepEqual(out.map((w) => w.slice(0, 4)), [[0, 0, 40, 0], [40, 0, 100, 0]]);
  assert.ok(out.every((w) => w[W.move] === 1 && w[W.sight] === 1));
});

test('3 editor: nodes merge only on release, never while dragging over another node', () => {
  const walls = [makeWall(0, 0, 100, 0), makeWall(100, 0, 100, 100), makeWall(300, 0, 400, 0)];
  const grabbed = nodesAt(walls, 100, 0); // the corner shared by the first two walls
  assert.equal(grabbed.length, 2);
  const passing = moveNodes(walls, grabbed, 300, 0); // dragged over the third wall's end...
  const later = moveNodes(passing, grabbed, 250, 50); // ...and on: that end did not come along
  assert.deepEqual(later[2].slice(0, 4), [300, 0, 400, 0]);
  const dropped = mergeOnRelease(moveNodes(walls, grabbed, 304, 3), grabbed, 12); // released near it: merged
  assert.deepEqual([dropped[0][2], dropped[0][3], dropped[1][0], dropped[1][1]], [300, 0, 300, 0]);
  assert.deepEqual(mergeOnRelease(later, grabbed, 12)[0].slice(2, 4), [250, 50]); // released far away: unchanged
});

test('3 lights: radius in half-cell steps; an anti-light removes light, except player lights when it says so', () => {
  assert.equal(radiusStep(2.26), 2.5); assert.equal(radiusStep(2.2), 2); assert.equal(radiusStep(-3), 0); assert.equal(radiusStep(999), 100);
  const dark = room([], { dark: 1 }), eye = [{ x: 100, y: 500, vision: 100 }];
  const torch = { x: 300, y: 500, radius: 3 }, pcTorch = { ...torch, player: true };
  const anti = { x: 400, y: 500, radius: 1, anti: true };
  assert.ok(computeVision(dark, eye, [torch]).canSee(400, 500));
  assert.ok(!computeVision(dark, eye, [torch, anti]).canSee(400, 500));   // the anti-light wins
  assert.ok(computeVision(dark, eye, [torch, anti]).canSee(250, 500));    // outside its area the torch still lights
  assert.ok(!computeVision(dark, eye, [pcTorch, anti]).canSee(400, 500)); // a player's light loses too by default
  assert.ok(computeVision(dark, eye, [pcTorch, { ...anti, playersWin: true }]).canSee(400, 500)); // "player lights win"
  assert.ok(!computeVision(dark, eye, [torch, { ...anti, playersWin: true }]).canSee(400, 500)); // GM / NPC lights still lose
});
