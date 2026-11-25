// Line-of-sight geometry. Pure functions, no DOM: used by the map renderer and by the tests.
// Walls: see walls.js. Distances in px unless stated; token vision/light are in grid cells.
import { blocksSight } from './walls.js';

/** Segments that block sight and light: walls that do, closed doors, and the map border (tangible-only walls do not). */
export function blockers(scene) {
  const w = scene.width || 2000, h = scene.height || 1400;
  const out = [[0, 0, w, 0], [w, 0, w, h], [w, h, 0, h], [0, h, 0, 0]];
  for (const s of scene.walls || []) if (blocksSight(s)) out.push(s);
  return out;
}

function raySeg(ox, oy, dx, dy, s) {
  const sx = s[2] - s[0], sy = s[3] - s[1];
  const den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((s[0] - ox) * sy - (s[1] - oy) * sx) / den;
  const u = ((s[0] - ox) * dy - (s[1] - oy) * dx) / den;
  return t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
}

/** Polygon of everything visible from (ox, oy), by casting rays at every wall endpoint (+/- a hair). */
export function visibilityPolygon(ox, oy, segs) {
  const angles = [];
  for (const s of segs) for (let i = 0; i < 4; i += 2) { const a = Math.atan2(s[i + 1] - oy, s[i] - ox); angles.push(a - 1e-5, a, a + 1e-5); }
  const pts = [];
  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    let best = Infinity;
    for (const s of segs) { const t = raySeg(ox, oy, dx, dy, s); if (t !== null && t < best) best = t; }
    if (best < Infinity) pts.push([a, ox + dx * best, oy + dy * best]);
  }
  pts.sort((p, q) => p[0] - q[0]);
  return pts.map((p) => [p[1], p[2]]);
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The vision model (ROADMAP 2 §4).
 *  L (light)  = every light (GM lights, lights tokens carry), stopped by walls that block light, minus anti-lights.
 *               A scene that is not dark is all light.
 *  V (vision) = the union of the viewers' sight, each limited by its radius (in cells; 0 = sees nothing) and by walls.
 *  A light only adds to L, a viewer only adds to V. What the page shows: V ∩ L. A viewer with darkvision sees its whole V
 *  without light, but what lies outside L is shown in black and white.
 *
 * viewers: [{x, y, vision, darkvision?}]
 * lights:  [{x, y, radius, anti?, playersWin?, player?}]   radius in cells
 *   anti: removes light under its area. It always wins over lights, except a player's token light when it has playersWin.
 * Returns { dark, sight, lit, anti, canSee(x, y), isLit(x, y), grey(x, y) }:
 *   canSee: inside what is shown; grey: shown, but only thanks to darkvision (black and white).
 */
export function computeVision(scene, viewers, lights) {
  const segs = blockers(scene), g = scene.grid || 70, dark = !!scene.dark;
  const sight = viewers.filter((v) => (Number(v.vision) || 0) > 0)
    .map((v) => ({ x: v.x, y: v.y, r: v.vision * g, dv: !!v.darkvision, poly: visibilityPolygon(v.x, v.y, segs) }));
  const zone = (l) => ({ x: l.x, y: l.y, r: l.radius * g, player: !!l.player, playersWin: !!l.playersWin, poly: visibilityPolygon(l.x, l.y, segs) });
  const lit = lights.filter((l) => l.radius > 0 && !l.anti).map(zone);
  const anti = lights.filter((l) => l.radius > 0 && l.anti).map(zone);
  const covers = (z, x, y) => Math.hypot(x - z.x, y - z.y) <= z.r && pointInPoly(x, y, z.poly);
  const isLit = (x, y) => !dark || lit.some((l) => covers(l, x, y) && !anti.some((a) => covers(a, x, y) && !(a.playersWin && l.player)));
  const inV = (s, x, y) => covers(s, x, y);
  const canSee = (x, y) => sight.some((s) => inV(s, x, y) && (s.dv || isLit(x, y)));
  const grey = (x, y) => dark && !isLit(x, y) && sight.some((s) => s.dv && inV(s, x, y));
  return { dark, sight, lit, anti, canSee, isLit, grey };
}

/**
 * Whose eyes a page uses, and which tokens it always draws.
 *  perm(tok): 'edit' | 'view' | 'none' for the player looking; dead(tok): no vision when dead.
 *  - tokens in edit: always drawn (even dead, even in the dark), and always give their vision while alive;
 *  - tokens in view only: give their vision when the scene has "shared vision", or when the player has no living token in edit;
 *  - a token marked "shares its sight" (sight) gives its vision to everyone (the GM's override).
 */
export function pickViewers(tokens, perm, dead, shared) {
  const own = tokens.filter((t) => perm(t) === 'edit');
  const share = !!shared || !own.some((t) => !dead(t));
  const eyes = tokens.filter((t) => !dead(t) && (perm(t) === 'edit' || (share && perm(t) === 'view') || t.sight));
  return { eyes, own, shared: share };
}

// ---------------------------------------------------------------- exploration memory ("dynamic fog")
// What a player has seen on a scene, as a bitmap of half cells (one bit per half cell, row by row). The server keeps one
// per player slot and scene; pages OR what they see into it.
export function exploreDims(scene) {
  const cell = Math.max(5, (scene.grid || 70) / 2), w = scene.width || 2000, h = scene.height || 1400;
  return { cell, cols: Math.ceil(w / cell), rows: Math.ceil(h / cell) };
}
export const emptyBits = (d) => new Uint8Array(Math.ceil((d.cols * d.rows) / 8));
export const getBit = (bits, i) => (bits[i >> 3] >> (i & 7)) & 1;
/** Mark every half cell whose centre is seen right now. Returns true when something new was marked. */
export function markSeen(bits, d, canSee) {
  let changed = false;
  for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) {
    const i = r * d.cols + c;
    if (getBit(bits, i)) continue;
    if (canSee((c + 0.5) * d.cell, (r + 0.5) * d.cell)) { bits[i >> 3] |= 1 << (i & 7); changed = true; }
  }
  return changed;
}
/** a |= b, in place (same size). */
export function orBits(a, b) { for (let i = 0; i < a.length && i < b.length; i++) a[i] |= b[i]; return a; }
export const bitsToBase64 = (bits) => { let s = ''; for (let i = 0; i < bits.length; i += 0x8000) s += String.fromCharCode(...bits.subarray(i, i + 0x8000)); return btoa(s); };
export const bitsFromBase64 = (b64, d) => { const out = emptyBits(d); try { const s = atob(b64 || ''); for (let i = 0; i < out.length && i < s.length; i++) out[i] = s.charCodeAt(i); } catch { /* bad data: nothing explored */ } return out; };
/**
 * Dead look (black and white, 50 %) and no vision: forced by the GM ("dead" / "alive"), else the linked sheet's HP
 * (hp = current HP when the page has the sheet, else null), else what the server says (tok.dead).
 */
export function isTokenDead(tok, hp = null) {
  if (tok.life === 'dead') return true;
  if (tok.life === 'alive') return false;
  return hp != null ? hp <= 0 : !!tok.dead;
}

export const inReveal =(scene, x, y) => (scene.reveal || []).some((r) => x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3]);

/** Distance from point to segment, for click-to-erase / door toggling. */
export function distToSeg(px, py, s) {
  const dx = s[2] - s[0], dy = s[3] - s[1], len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / len2)) : 0;
  return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
}
