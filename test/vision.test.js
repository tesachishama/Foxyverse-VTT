import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVision, visibilityPolygon, blockers, pointInPoly, inReveal, distToSeg } from '../public/vision.js';

const room = (extra = {}) => ({ width: 1000, height: 1000, grid: 100, walls: [], ...extra });
const wallAt500 = [500, 0, 500, 1000, 0, 0]; // full-height wall

test('open room: everything is visible', () => {
  const v = computeVision(room(), [{ x: 100, y: 500, vision: 0 }], []);
  assert.ok(v.canSee(900, 900)); assert.ok(v.canSee(10, 10));
});

test('a wall blocks sight; a closed door blocks, an open door does not', () => {
  const scene = room({ walls: [wallAt500] });
  const v = computeVision(scene, [{ x: 100, y: 500, vision: 0 }], []);
  assert.ok(v.canSee(400, 500)); assert.ok(!v.canSee(600, 500));
  const door = room({ walls: [[500, 0, 500, 1000, 1, 0]] });
  assert.ok(!computeVision(door, [{ x: 100, y: 500, vision: 0 }], []).canSee(600, 500));
  const open = room({ walls: [[500, 0, 500, 1000, 1, 1]] });
  assert.ok(computeVision(open, [{ x: 100, y: 500, vision: 0 }], []).canSee(600, 500));
});

test('a doorway gap lets sight through at an angle only', () => {
  const scene = room({ walls: [[500, 0, 500, 400, 0, 0], [500, 600, 500, 1000, 0, 0]] }); // gap at y 400-600
  const v = computeVision(scene, [{ x: 100, y: 500, vision: 0 }], []);
  assert.ok(v.canSee(800, 500)); assert.ok(!v.canSee(800, 100));
});

test('vision radius limits a lit scene', () => {
  const v = computeVision(room(), [{ x: 100, y: 500, vision: 3 }], []);
  assert.ok(v.canSee(350, 500)); assert.ok(!v.canSee(500, 500));
});

test('dark scene: need light, or darkvision', () => {
  const dark = room({ dark: 1 });
  assert.ok(!computeVision(dark, [{ x: 100, y: 500, vision: 0 }], []).canSee(150, 500));       // no light, no darkvision
  assert.ok(computeVision(dark, [{ x: 100, y: 500, vision: 2 }], []).canSee(250, 500));        // darkvision 2 cells
  assert.ok(!computeVision(dark, [{ x: 100, y: 500, vision: 2 }], []).canSee(400, 500));
  const torch = computeVision(dark, [{ x: 100, y: 500, vision: 0 }], [{ x: 300, y: 500, radius: 2 }]);
  assert.ok(torch.canSee(400, 500)); assert.ok(!torch.canSee(700, 500));                        // outside the torch
});

test('light does not pass through walls', () => {
  const scene = room({ dark: 1, walls: [wallAt500] });
  const v = computeVision(scene, [{ x: 100, y: 500, vision: 0 }], [{ x: 600, y: 500, radius: 4 }]);
  assert.ok(!v.canSee(400, 500)); // lit area is behind the wall for the viewer
});

test('helpers', () => {
  assert.equal(blockers(room({ walls: [wallAt500] })).length, 5);
  assert.equal(blockers(room({ walls: [[1, 1, 2, 2, 1, 1]] })).length, 4); // open door ignored
  assert.ok(pointInPoly(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.ok(visibilityPolygon(100, 100, blockers(room())).length >= 4);
  assert.ok(inReveal({ reveal: [[100, 100, 50, 50]] }, 120, 120)); assert.ok(!inReveal({ reveal: [[100, 100, 50, 50]] }, 200, 200));
  assert.equal(distToSeg(5, 5, [0, 0, 10, 0]), 5);
});
