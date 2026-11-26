// ROADMAP 3: pure client modules (tools, selection, layout helpers...).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { TOOLS, TOOL_BUTTONS } from '../public/tools.js';
import { DICT } from '../public/lib.js';

const icon = (name) => new URL(`../public/icons/${name}.svg`, import.meta.url);
/** Every DICT key used by a list of things exists in French and in English. */
const bothLangs = (keys) => { for (const k of keys) { assert.ok(DICT.fr[k], `missing fr "${k}"`); assert.ok(DICT.en[k], `missing en "${k}"`); } };
const squareSvg = (name) => {
  assert.ok(existsSync(icon(name)), `icon ${name}.svg is missing`);
  const svg = readFileSync(icon(name), 'utf8');
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.ok(m && m[1] === m[2], `${name}.svg is not square`);
  for (const tag of svg.match(/<[a-z][^>]*>/g)) { const attrs = [...tag.matchAll(/\s([a-z-]+)=/g)].map((x) => x[1]); assert.equal(new Set(attrs).size, attrs.length, `${name}.svg: duplicate attribute (invalid SVG)`); }
};

test('1.1 every map tool is an icon (square SVG placeholder) with a tooltip name in FR and EN', () => {
  for (const tl of [...TOOLS, ...TOOL_BUTTONS]) squareSvg(tl.icon);
  bothLangs([...TOOLS, ...TOOL_BUTTONS].map((tl) => tl.label));
  assert.equal(new Set(TOOLS.map((tl) => tl.id)).size, TOOLS.length);
});

export { bothLangs, squareSvg };

// ---------------------------------------------------------------- 1.2 selection
import { pickInArea, rectPoly, pointInPoly, toggleItem, mergeSelection, moveItems, deleteItems, snapDelta, defaultFilter, revealPts, liveItems, SELECT_KINDS } from '../public/select.js';
const scene = () => ({ grid: 50, ox: 0, oy: 0,
  walls: [[0, 0, 100, 0, 0, 0, 0, 0, 1], [10, 10, 40, 10, 1, 0, 0, 1, 1], [0, 0, 900, 900, 0, 0, 0, 0, 1]], // a wall, a door, a long wall
  lights: [{ id: 'l1', x: 30, y: 30, radius: 2 }], tps: [{ id: 't1', x: 75, y: 25, group: '1' }], reveal: [[5, 5, 20, 20], [500, 500, 10, 10]] });
const toks = [{ id: 1, x: 20, y: 20 }, { id: 2, x: 400, y: 400 }];

test('1.2 the selection checkboxes exist in FR and EN, all ticked by default', () => {
  bothLangs(['selectWhat', 'selectedCount', 'groupHint', ...SELECT_KINDS.map((k) => 'sel_' + k)]);
  assert.ok(Object.values(defaultFilter()).every(Boolean));
});
test('1.2 a selection rectangle takes tokens, walls (both ends inside), doors, lights, TP cells and revealed areas inside it', () => {
  const got = pickInArea(scene(), toks, rectPoly(-1, -1, 110, 60));
  assert.deepEqual(got.tokens, [1]);
  assert.deepEqual(got.items, [{ kind: 'wall', index: 0 }, { kind: 'wall', index: 1 }, { kind: 'light', id: 'l1' }, { kind: 'tp', id: 't1' }, { kind: 'reveal', index: 0 }]);
});
test('1.2 unticked kinds are left out (walls apart from doors)', () => {
  const f = { ...defaultFilter(), tokens: false, doors: false, reveal: false };
  const got = pickInArea(scene(), toks, rectPoly(-1, -1, 110, 60), f);
  assert.deepEqual(got.tokens, []);
  assert.deepEqual(got.items.map((i) => i.kind + (i.index ?? i.id)), ['wall0', 'lightl1', 'tpt1']);
});
test('1.2 a lasso (free polygon) selects what is inside its shape', () => {
  const tri = [[0, 0], [60, 0], [0, 60]];
  assert.ok(pointInPoly(10, 10, tri)); assert.ok(!pointInPoly(50, 50, tri));
  assert.deepEqual(pickInArea(scene(), [{ id: 7, x: 10, y: 10 }, { id: 8, x: 50, y: 50 }], tri).tokens, [7]);
});
test('1.2 Shift+click adds or takes out; the lasso adds to the current selection', () => {
  let items = toggleItem([], { kind: 'light', id: 'l1' });
  items = toggleItem(items, { kind: 'wall', index: 2 });
  assert.equal(items.length, 2);
  assert.deepEqual(toggleItem(items, { kind: 'light', id: 'l1' }), [{ kind: 'wall', index: 2 }]);
  const m = mergeSelection({ tokens: [1], items }, { tokens: [1, 2], items: [{ kind: 'wall', index: 2 }, { kind: 'tp', id: 't1' }] });
  assert.deepEqual(m.tokens, [1, 2]); assert.equal(m.items.length, 3);
});
test('1.2 a group move shifts every selected item by the same snapped distance; TP cells stay on cell centres', () => {
  const sc = scene(), d = snapDelta(sc, 62, -8, 'grid');
  assert.deepEqual(d, { dx: 50, dy: 0 });
  assert.deepEqual(snapDelta(sc, 62, -8, 'half'), { dx: 50, dy: 0 });
  assert.deepEqual(snapDelta(sc, 62, -8, 'off'), { dx: 62, dy: -8 });
  const p = moveItems(sc, [{ kind: 'wall', index: 0 }, { kind: 'light', id: 'l1' }, { kind: 'tp', id: 't1' }, { kind: 'reveal', index: 0 }], 13, 0);
  assert.deepEqual(p.walls[0].slice(0, 4), [13, 0, 113, 0]); assert.deepEqual(p.walls[1], sc.walls[1]); // unselected: untouched
  assert.equal(p.lights[0].x, 43); assert.deepEqual([p.tps[0].x, p.tps[0].y], [75, 25]); assert.deepEqual(p.reveal[0], [18, 5, 20, 20]);
});
test('1.2 a group delete removes exactly the selected items, in one patch', () => {
  const sc = scene();
  const p = deleteItems(sc, [{ kind: 'wall', index: 1 }, { kind: 'reveal', index: 1 }, { kind: 'tp', id: 't1' }]);
  assert.equal(p.walls.length, 2); assert.equal(p.walls[1][2], 900);
  assert.deepEqual(p.reveal, [[5, 5, 20, 20]]); assert.deepEqual(p.tps, []); assert.equal(p.lights, undefined);
  assert.deepEqual(liveItems({ ...sc, ...p }, [{ kind: 'wall', index: 2 }, { kind: 'tp', id: 't1' }]), []);
  assert.deepEqual(revealPts({ poly: [[1, 2], [3, 4], [5, 6]] }), [[1, 2], [3, 4], [5, 6]]);
});

// ---------------------------------------------------------------- 1.3 reveal: rectangle, lasso, polygon
import { REVEAL_MODES } from '../public/tools.js';
import { inReveal } from '../public/vision.js';
test('1.3 the reveal tool has three sub-tools (icons, FR/EN names): rectangle, lasso, polygon', () => {
  assert.deepEqual(REVEAL_MODES.map((m) => m.id), ['rect', 'lasso', 'poly']);
  for (const m of REVEAL_MODES) squareSvg(m.icon);
  bothLangs(REVEAL_MODES.map((m) => m.label));
});
test('1.3 a polygon (lasso or clicked corners) reveals what is inside its shape, a rectangle still works', () => {
  const sc = { reveal: [[0, 0, 10, 10], { poly: [[100, 100], [200, 100], [100, 200]] }] };
  assert.ok(inReveal(sc, 5, 5)); assert.ok(inReveal(sc, 120, 120));
  assert.ok(!inReveal(sc, 190, 190)); // outside the triangle, inside its bounding box
  assert.ok(!inReveal({ reveal: [{ poly: 'junk' }] }, 1, 1));
});

// ---------------------------------------------------------------- 1.4 one wall tool
import { WALL_SHAPES, WALL_FLAGS, wallToolFlags } from '../public/tools.js';
import { makeWall, blocksMove, blocksSight, normWall } from '../public/walls.js';
test('1.4 a single wall tool: its sub-menu has the four shapes and three boxes (icons, FR/EN names)', () => {
  assert.ok(TOOLS.some((tl) => tl.id === 'wall'));
  for (const gone of ['twall', 'rect', 'circle', 'curve', 'door']) assert.ok(!TOOLS.some((tl) => tl.id === gone), gone);
  assert.deepEqual(WALL_SHAPES.map((s) => s.id), ['line', 'curve', 'rect', 'circle']);
  assert.deepEqual(WALL_FLAGS.map((s) => s.id), ['move', 'sight', 'door']);
  for (const x of [...WALL_SHAPES, ...WALL_FLAGS]) squareSvg(x.icon);
  bothLangs([...WALL_SHAPES, ...WALL_FLAGS].map((x) => x.label));
  bothLangs(['wallTangibleHint', 'wallOpaqueHint', 'toolDoorHint', 'doorLineOnly']);
});
test('1.4 the boxes make walls in the same format as before: tangible = blocks movement, opaque = blocks sight and light', () => {
  const mk = (shape, flags) => { const f = wallToolFlags(shape, flags); return makeWall(0, 0, 10, 0, f, f.door); };
  const tangible = mk('line', { move: true, sight: false }), opaque = mk('rect', { move: false, sight: true }), both = mk('circle', { move: true, sight: true });
  assert.deepEqual(tangible, normWall(tangible)); assert.equal(tangible.length, 9);
  assert.ok(blocksMove(tangible) && !blocksSight(tangible));
  assert.ok(!blocksMove(opaque) && blocksSight(opaque));
  assert.ok(blocksMove(both) && blocksSight(both));
  assert.deepEqual(makeWall(0, 0, 1, 1, 'tangible'), makeWall(0, 0, 1, 1, { move: true, sight: false })); // the old presets still mean the same
});
test('1.4 the door box: a closed door blocks everything; only a line can be a door', () => {
  const door = wallToolFlags('line', { door: true, move: false, sight: false });
  assert.deepEqual(door, { door: true, move: true, sight: true });
  const w = makeWall(0, 0, 10, 0, door, door.door);
  assert.equal(w[4], 1); assert.ok(blocksMove(w) && blocksSight(w));
  assert.equal(wallToolFlags('curve', { door: true }).door, false);
});

// ---------------------------------------------------------------- 1.5 Delete and Ctrl+Z
import { mapShortcut } from '../public/layout.js';
test('1.5 Delete (or Backspace) deletes the selection, Ctrl/Cmd+Z undoes; other keys and combinations do nothing', () => {
  assert.equal(mapShortcut({ key: 'Delete' }), 'delete');
  assert.equal(mapShortcut({ key: 'Backspace' }), 'delete');
  assert.equal(mapShortcut({ key: 'z', ctrlKey: true }), 'undo');
  assert.equal(mapShortcut({ key: 'Z', metaKey: true }), 'undo');
  assert.equal(mapShortcut({ key: 'z', ctrlKey: true, shiftKey: true }), null); // Ctrl+Shift+Z is not undo
  assert.equal(mapShortcut({ key: 'Delete', ctrlKey: true }), null);
  assert.equal(mapShortcut({ key: 'z' }), null);
});
test('1.7 the free reroll button has its FR/EN name', () => bothLangs(['freeReroll', 'freeRerollHint']));
