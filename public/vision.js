// Line-of-sight geometry. Pure functions, no DOM: used by the map renderer and by the tests.
// A wall is [x1, y1, x2, y2, isDoor, isOpen]. Distances in px unless stated; token vision/light are in grid cells.

/** Segments that block sight: walls, closed doors, and the map border. */
export function blockers(scene) {
  const w = scene.width || 2000, h = scene.height || 1400;
  const out = [[0, 0, w, 0], [w, 0, w, h], [w, h, 0, h], [0, h, 0, 0]];
  for (const s of scene.walls || []) if (!(s[4] && s[5])) out.push(s);
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
 * viewers: [{x, y, vision}]   vision in cells, 0 = unlimited (lit scenes) / none (dark scenes)
 * lights:  [{x, y, radius}]   radius in cells
 * Returns { sight, lit, canSee(x, y) }.
 *  - Lit scene:  you see what is in line of sight (within `vision` cells if set).
 *  - Dark scene: you also need light (or darkvision = `vision` cells) on the spot.
 */
export function computeVision(scene, viewers, lights) {
  const segs = blockers(scene), g = scene.grid || 70, dark = !!scene.dark;
  const sight = viewers.map((v) => ({ x: v.x, y: v.y, r: (v.vision || 0) * g, poly: visibilityPolygon(v.x, v.y, segs) }));
  const lit = lights.filter((l) => l.radius > 0).map((l) => ({ x: l.x, y: l.y, r: l.radius * g, poly: visibilityPolygon(l.x, l.y, segs) }));
  const canSee = (x, y) => sight.some((s) => {
    if (!pointInPoly(x, y, s.poly)) return false;
    const d = Math.hypot(x - s.x, y - s.y);
    if (!dark) return s.r === 0 || d <= s.r;
    return (s.r > 0 && d <= s.r) || lit.some((l) => Math.hypot(x - l.x, y - l.y) <= l.r && pointInPoly(x, y, l.poly));
  });
  return { dark, sight, lit, canSee };
}

export const inReveal = (scene, x, y) => (scene.reveal || []).some((r) => x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3]);

/** Distance from point to segment, for click-to-erase / door toggling. */
export function distToSeg(px, py, s) {
  const dx = s[2] - s[0], dy = s[3] - s[1], len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / len2)) : 0;
  return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
}
