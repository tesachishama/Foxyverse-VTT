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
