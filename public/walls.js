// Walls, doors and lights of a scene. Pure functions (no DOM): shared by the map, the server and the tests.
//
// A wall is [x1, y1, x2, y2, door, open, locked, move, sight]:
//   door   1 = a door (shown as an icon; closed: blocks sight, light AND movement; open: blocks nothing)
//   open   a door's state           locked  only the GM opens it
//   move   blocks movement ("tangible": players cannot walk through; the GM always can)
//   sight  blocks sight and light (one property for both)
// Walls saved before these properties existed ([x1, y1, x2, y2, door, open]) block sight and light, not movement.

export const W = { door: 4, open: 5, locked: 6, move: 7, sight: 8 };
/** Drawing presets: plain wall (sight + light), tangible wall (movement), or both. */
export const PRESETS = { wall: { move: 0, sight: 1 }, tangible: { move: 1, sight: 0 }, both: { move: 1, sight: 1 } };

/** A wall in the full format, whatever was stored. */
export function normWall(w) {
  const b = (i, d) => (w[i] === undefined || w[i] === null ? d : w[i] ? 1 : 0);
  return [w[0], w[1], w[2], w[3], b(4, 0), b(5, 0), b(6, 0), b(7, 0), b(8, 1)];
}
/** preset: a PRESETS name, or the wall tool's boxes { move, sight } (ROADMAP 3 §1.4). */
export const makeWall = (x1, y1, x2, y2, preset = 'wall', door = false) => {
  const p = typeof preset === 'object' && preset ? { move: preset.move ? 1 : 0, sight: preset.sight ? 1 : 0 } : PRESETS[preset] ?? PRESETS.wall;
  return [x1, y1, x2, y2, door ? 1 : 0, 0, 0, door ? 1 : p.move, door ? 1 : p.sight];
};
const closedDoor = (w) => !!w[W.door] && !w[W.open];
/** Does this wall stop sight and light right now? */
export const blocksSight = (w) => (w[W.door] ? !w[W.open] : (w[W.sight] ?? 1) !== 0);
/** Does this wall stop a player's token right now? */
export const blocksMove = (w) => (w[W.door] ? closedDoor(w) : !!w[W.move]);

/** Do segments p1-p2 and q1-q2 cross or touch? */
export function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => { const v = (qx - px) * (ry - py) - (qy - py) * (rx - px); return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : -1; };
  const on = (px, py, qx, qy, rx, ry) => Math.min(px, qx) - 1e-9 <= rx && rx <= Math.max(px, qx) + 1e-9 && Math.min(py, qy) - 1e-9 <= ry && ry <= Math.max(py, qy) + 1e-9;
  const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy), o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(ax, ay, bx, by, cx, cy)) || (o2 === 0 && on(ax, ay, bx, by, dx, dy)) || (o3 === 0 && on(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && on(cx, cy, dx, dy, bx, by));
}
/** Would moving a token's centre from (x1, y1) to (x2, y2) go through a wall that blocks movement (tangible wall, closed door)? */
export function moveBlocked(walls, x1, y1, x2, y2) {
  if (x1 === x2 && y1 === y2) return false;
  return (walls || []).some((w) => blocksMove(w) && segmentsCross(x1, y1, x2, y2, w[0], w[1], w[2], w[3]));
}

/** Where a door's icon sits: the middle of its segment. */
export const doorCenter = (w) => ({ x: (w[0] + w[2]) / 2, y: (w[1] + w[3]) / 2 });

// ---------------------------------------------------------------- editing (the GM's wall editor)
/** Add a node on a segment: wall i is cut in two at (x, y); both halves keep its properties. Returns a new list. */
export function splitWall(walls, i, x, y) {
  const w = walls[i]; if (!w) return walls;
  const a = [...w], b = [...w];
  a[2] = x; a[3] = y; b[0] = x; b[1] = y;
  return [...walls.slice(0, i), a, b, ...walls.slice(i + 1)];
}
/** The ends ([wall index, 0 | 2]) found at a point: every wall end at that spot moves together. */
export function nodesAt(walls, x, y, eps = 0.01) {
  const refs = [];
  walls.forEach((w, i) => { for (const k of [0, 2]) if (Math.abs(w[k] - x) < eps && Math.abs(w[k + 1] - y) < eps) refs.push([i, k]); });
  return refs;
}
/** Move exactly the grabbed ends (not whatever they pass over while dragging). Returns a new list. */
export function moveNodes(walls, refs, x, y) {
  const out = walls.map((w) => [...w]);
  for (const [i, k] of refs) { out[i][k] = x; out[i][k + 1] = y; }
  return out;
}
/**
 * On release only: if the dragged ends landed on another node (within "near"), they snap onto it and merge.
 * Walls that shrank to nothing are dropped. Returns a new list.
 */
export function mergeOnRelease(walls, refs, near) {
  if (!refs.length) return walls;
  const [i0, k0] = refs[0], x = walls[i0][k0], y = walls[i0][k0 + 1];
  const mine = new Set(refs.map(([i, k]) => `${i}:${k}`));
  let best = null;
  walls.forEach((w, i) => { for (const k of [0, 2]) {
    if (mine.has(`${i}:${k}`)) continue;
    const d = Math.hypot(w[k] - x, w[k + 1] - y);
    if (d < near && (!best || d < best.d)) best = { d, x: w[k], y: w[k + 1] };
  } });
  const out = best ? moveNodes(walls, refs, best.x, best.y) : walls;
  return out.filter((w) => Math.hypot(w[2] - w[0], w[3] - w[1]) > 0.5);
}

// ---------------------------------------------------------------- lights (small GM tokens)
/** Light radius, in cells, in steps of half a cell (0 to 100). */
export const radiusStep = (r) => Math.min(100, Math.max(0, Math.round((Number(r) || 0) * 2) / 2));
