// The GM's selection on the map (ROADMAP 3 §1.2). Pure functions (no DOM): shared by the map, the page and the tests.
//
// A selection is a set of token ids plus a list of map items:
//   { kind: 'wall', index }   a wall or a door (index in scene.walls)
//   { kind: 'light', id }     a light or an anti-light
//   { kind: 'tp', id }        a teleport cell
//   { kind: 'reveal', index } a revealed area (index in scene.reveal)
// A revealed area is a rectangle [x, y, w, h] or a polygon { poly: [[x, y], ...] } (see revealPts).

import { cellCenter } from './tp.js';

/** What the selection checkboxes choose from (all ticked by default). */
export const SELECT_KINDS = ['tokens', 'walls', 'doors', 'lights', 'tps', 'reveal'];
export const defaultFilter = () => Object.fromEntries(SELECT_KINDS.map((k) => [k, true]));

/** Ray casting; pts is [[x, y], ...] (closed implicitly). */
export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
/** A rectangle from two corners, as a polygon. */
export const rectPoly = (x1, y1, x2, y2) => {
  const a = Math.min(x1, x2), b = Math.min(y1, y2), c = Math.max(x1, x2), d = Math.max(y1, y2);
  return [[a, b], [c, b], [c, d], [a, d]];
};
/** The corners of a revealed area, whatever its shape. */
export function revealPts(r) {
  if (Array.isArray(r)) return rectPoly(r[0], r[1], r[0] + r[2], r[1] + r[3]);
  return Array.isArray(r?.poly) ? r.poly : [];
}
/** Is a point inside an area that may be a rectangle polygon on the border (inclusive) or any polygon? */
const inside = (x, y, area) => pointInPoly(x, y, area) || area.some(([px, py]) => px === x && py === y);

/** Which kind of checkbox a map item answers to. */
export function itemFilterKind(scene, it) {
  if (it.kind === 'wall') return scene.walls?.[it.index]?.[4] ? 'doors' : 'walls';
  return { light: 'lights', tp: 'tps', reveal: 'reveal' }[it.kind];
}
export const allowed = (scene, it, filter) => !filter || filter[itemFilterKind(scene, it)] !== false;

/**
 * Everything inside an area (a polygon): tokens by their centre, walls and doors by both ends, lights and TP cells by their
 * centre, revealed areas when every corner is inside. Only the kinds ticked in the filter.
 */
export function pickInArea(scene, tokens, area, filter = defaultFilter()) {
  const out = { tokens: [], items: [] };
  if (!area || area.length < 3) return out;
  if (filter.tokens) for (const t of tokens) if (inside(t.x, t.y, area)) out.tokens.push(t.id);
  (scene.walls || []).forEach((w, index) => {
    if (!allowed(scene, { kind: 'wall', index }, filter)) return;
    if (inside(w[0], w[1], area) && inside(w[2], w[3], area)) out.items.push({ kind: 'wall', index });
  });
  if (filter.lights) for (const l of scene.lights || []) if (inside(l.x, l.y, area)) out.items.push({ kind: 'light', id: l.id });
  if (filter.tps) for (const c of scene.tps || []) if (inside(c.x, c.y, area)) out.items.push({ kind: 'tp', id: c.id });
  if (filter.reveal) (scene.reveal || []).forEach((r, index) => { const p = revealPts(r); if (p.length && p.every(([x, y]) => inside(x, y, area))) out.items.push({ kind: 'reveal', index }); });
  return out;
}

export const itemKey = (it) => (it.kind === 'wall' || it.kind === 'reveal' ? `${it.kind}:${it.index}` : `${it.kind}:${it.id}`);
export const hasItem = (items, it) => items.some((x) => itemKey(x) === itemKey(it));
/** Shift+click: add the item, or take it out if it was already there. */
export const toggleItem = (items, it) => (hasItem(items, it) ? items.filter((x) => itemKey(x) !== itemKey(it)) : [...items, it]);
/** Both selections together (no duplicates). */
export function mergeSelection(a, b) {
  const items = [...a.items];
  for (const it of b.items) if (!hasItem(items, it)) items.push(it);
  return { tokens: [...new Set([...a.tokens, ...b.tokens])], items };
}

/** A drag distance snapped like the tool's snapping: whole cells, half cells, or free (to the pixel). */
export function snapDelta(scene, dx, dy, mode = 'grid') {
  if (mode === 'off') return { dx: Math.round(dx), dy: Math.round(dy) };
  const g = mode === 'half' ? scene.grid / 2 : scene.grid;
  return { dx: Math.round(dx / g) * g + 0, dy: Math.round(dy / g) * g + 0 }; // + 0: no "-0"
}
const r10 = (v) => Math.round(v * 10) / 10;
/** Move the selected map items by (dx, dy): the scene patch to send. TP cells stay on cell centres. */
export function moveItems(scene, items, dx, dy) {
  const patch = {}, walls = new Set(), lights = new Set(), tps = new Set(), reveal = new Set();
  for (const it of items) ({ wall: walls, reveal }[it.kind] ?? { light: lights, tp: tps }[it.kind])?.add(it.kind === 'wall' || it.kind === 'reveal' ? it.index : it.id);
  if (walls.size) patch.walls = (scene.walls || []).map((w, i) => (walls.has(i) ? [r10(w[0] + dx), r10(w[1] + dy), r10(w[2] + dx), r10(w[3] + dy), ...w.slice(4)] : w));
  if (lights.size) patch.lights = (scene.lights || []).map((l) => (lights.has(l.id) ? { ...l, x: Math.round(l.x + dx), y: Math.round(l.y + dy) } : l));
  if (tps.size) patch.tps = (scene.tps || []).map((c) => (tps.has(c.id) ? { ...c, ...cellCenter(scene, c.x + dx, c.y + dy) } : c));
  if (reveal.size) patch.reveal = (scene.reveal || []).map((r, i) => {
    if (!reveal.has(i)) return r;
    return Array.isArray(r) ? [Math.round(r[0] + dx), Math.round(r[1] + dy), r[2], r[3]] : { poly: r.poly.map(([x, y]) => [Math.round(x + dx), Math.round(y + dy)]) };
  });
  return patch;
}
/** Remove the selected map items: the scene patch to send. */
export function deleteItems(scene, items) {
  const patch = {}, gone = new Set(items.map(itemKey));
  const keep = (kind, list, key) => list.filter((x, i) => !gone.has(`${kind}:${key(x, i)}`));
  if (items.some((x) => x.kind === 'wall')) patch.walls = keep('wall', scene.walls || [], (_, i) => i);
  if (items.some((x) => x.kind === 'light')) patch.lights = keep('light', scene.lights || [], (l) => l.id);
  if (items.some((x) => x.kind === 'tp')) patch.tps = keep('tp', scene.tps || [], (c) => c.id);
  if (items.some((x) => x.kind === 'reveal')) patch.reveal = keep('reveal', scene.reveal || [], (_, i) => i);
  return patch;
}
/** Selected items that still exist in the scene (after an edit made somewhere else). */
export function liveItems(scene, items) {
  return items.filter((it) => (it.kind === 'wall' ? !!scene.walls?.[it.index] : it.kind === 'reveal' ? !!scene.reveal?.[it.index]
    : it.kind === 'light' ? (scene.lights || []).some((l) => l.id === it.id) : (scene.tps || []).some((c) => c.id === it.id)));
}
