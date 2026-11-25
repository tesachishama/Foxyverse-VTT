import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVision, visibilityPolygon, blockers, pointInPoly, inReveal, distToSeg, pickViewers, exploreDims, emptyBits, markSeen, getBit, orBits, bitsToBase64, bitsFromBase64 } from '../public/vision.js';

const room = (extra = {}) => ({ width: 1000, height: 1000, grid: 100, walls: [], ...extra });
const wallAt500 = [500, 0, 500, 1000, 0, 0]; // full-height wall (old format: blocks sight)
const eye = (vision = 100, darkvision = false) => [{ x: 100, y: 500, vision, darkvision }];

test('lit scene: you see your whole vision zone (V); 0 cells = no vision at all', () => {
  const v = computeVision(room(), eye(), []);
  assert.ok(v.canSee(900, 900)); assert.ok(v.canSee(10, 10));
  assert.ok(!computeVision(room(), eye(0), []).canSee(150, 500)); // 0 is no longer "unlimited"
});

test('a wall blocks sight; a closed door blocks, an open door does not', () => {
  const v = computeVision(room({ walls: [wallAt500] }), eye(), []);
  assert.ok(v.canSee(400, 500)); assert.ok(!v.canSee(600, 500));
  assert.ok(!computeVision(room({ walls: [[500, 0, 500, 1000, 1, 0]] }), eye(), []).canSee(600, 500));
  assert.ok(computeVision(room({ walls: [[500, 0, 500, 1000, 1, 1]] }), eye(), []).canSee(600, 500));
});

test('a doorway gap lets sight through at an angle only', () => {
  const v = computeVision(room({ walls: [[500, 0, 500, 400, 0, 0], [500, 600, 500, 1000, 0, 0]] }), eye(), []);
  assert.ok(v.canSee(800, 500)); assert.ok(!v.canSee(800, 100));
});

test('the vision radius limits what you see, lit scene or not', () => {
  const v = computeVision(room(), eye(3), []);
  assert.ok(v.canSee(350, 500)); assert.ok(!v.canSee(500, 500));
});

test('4 dark scene: you see V ∩ L; lights only add light, vision only adds vision', () => {
  const dark = room({ dark: 1 });
  assert.ok(!computeVision(dark, eye(), []).canSee(150, 500)); // no light: nothing, even next to you
  const torch = computeVision(dark, eye(), [{ x: 300, y: 500, radius: 2 }]);
  assert.ok(torch.canSee(400, 500)); assert.ok(!torch.canSee(700, 500)); // outside the light
  const short = computeVision(dark, eye(1), [{ x: 600, y: 500, radius: 2 }]);
  assert.ok(!short.canSee(600, 500)); // lit, but outside this token's vision radius: a light does not extend vision
});

test('4 darkvision: the whole V without light, limited by the radius; what is outside L is black and white', () => {
  const dark = room({ dark: 1 });
  const dv = computeVision(dark, eye(3, true), [{ x: 300, y: 500, radius: 1 }]);
  assert.ok(dv.canSee(150, 500)); assert.ok(!dv.canSee(500, 500)); // limited by its vision radius (3 cells)
  assert.ok(dv.grey(150, 500)); assert.ok(!dv.grey(300, 500)); // unlit: grey; lit: in colour
  assert.ok(!computeVision(room(), eye(3, true), []).grey(150, 500)); // a lit scene is never grey
});

test('light does not pass through walls', () => {
  const v = computeVision(room({ dark: 1, walls: [wallAt500] }), eye(), [{ x: 600, y: 500, radius: 4 }]);
  assert.ok(!v.canSee(400, 500)); // the lit area is behind the wall for the viewer
});

test('4 whose eyes: tokens in edit always; view-only ones with shared vision or when no living own token; "shares its sight" for all; dead see nothing', () => {
  const mine = { id: 1 }, deadMine = { id: 2 }, friend = { id: 3 }, ally = { id: 4, sight: true }, stranger = { id: 5 };
  const perms = { 1: 'edit', 2: 'edit', 3: 'view' }, perm = (t) => perms[t.id] ?? 'none', dead = (t) => t.id === 2;
  const ids = (r) => r.eyes.map((t) => t.id);
  const all = [mine, deadMine, friend, ally, stranger];
  assert.deepEqual(ids(pickViewers(all, perm, dead, false)), [1, 4]);
  assert.deepEqual(pickViewers(all, perm, dead, false).own.map((t) => t.id), [1, 2]); // own tokens are always drawn, dead included
  assert.deepEqual(ids(pickViewers(all, perm, dead, true)), [1, 3, 4]); // scene option "shared vision"
  assert.deepEqual(ids(pickViewers([deadMine, friend, stranger], perm, dead, false)), [3]); // no living own token: shared by itself
  assert.equal(pickViewers([deadMine, friend], perm, dead, false).shared, true);
});

test('4 exploration memory: half-cell bitmap, marks what is seen, ORs, survives base64', () => {
  const d = exploreDims({ width: 1000, height: 500, grid: 100 });
  assert.deepEqual(d, { cell: 50, cols: 20, rows: 10 });
  const bits = emptyBits(d);
  assert.equal(markSeen(bits, d, (x) => x < 200), true); // the four left columns
  assert.equal(getBit(bits, 0), 1); assert.equal(getBit(bits, 3), 1); assert.equal(getBit(bits, 4), 0);
  assert.equal(markSeen(bits, d, (x) => x < 200), false); // nothing new
  const other = emptyBits(d); markSeen(other, d, (x) => x > 950);
  orBits(bits, other); assert.equal(getBit(bits, 19), 1); assert.equal(getBit(bits, 0), 1);
  assert.deepEqual(bitsFromBase64(bitsToBase64(bits), d), bits);
  assert.deepEqual(bitsFromBase64('%%%', d), emptyBits(d)); // junk: nothing explored
});

test('helpers', () => {
  assert.equal(blockers(room({ walls: [wallAt500] })).length, 5);
  assert.equal(blockers(room({ walls: [[1, 1, 2, 2, 1, 1]] })).length, 4); // open door ignored
  assert.ok(pointInPoly(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.ok(visibilityPolygon(100, 100, blockers(room())).length >= 4);
  assert.ok(inReveal({ reveal: [[100, 100, 50, 50]] }, 120, 120)); assert.ok(!inReveal({ reveal: [[100, 100, 50, 50]] }, 200, 200));
  assert.equal(distToSeg(5, 5, [0, 0, 10, 0]), 5);
});
