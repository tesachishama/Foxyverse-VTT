// Teleport cells (ROADMAP 2 §5). Pure functions (no DOM): shared by the map, the server and the tests.
//
// A TP cell is { id, x, y, group }: (x, y) is the centre of a grid cell; cells with the same group are linked (a group may hold more
// than two cells). A token standing on a TP cell is copied, as a "ghost", onto every linked cell: the ghosts give the matching vision
// (seen from there), and the player can pick up a ghost to move on from that side: the real token teleports there. Ghosts are never
// stored, they come from where the tokens are. The server checks a move that starts from a ghost.

/** Centre of the grid cell containing (x, y). */
export function cellCenter(scene, x, y) {
  const g = scene.grid || 70, ox = scene.ox || 0, oy = scene.oy || 0;
  return { x: ox + (Math.floor((x - ox) / g) + 0.5) * g, y: oy + (Math.floor((y - oy) / g) + 0.5) * g };
}
/** The TP cell a point stands on (its cell contains the point), or null. */
export function tpAt(tps, grid, x, y) {
  return (tps || []).find((c) => Math.abs(x - c.x) < grid / 2 && Math.abs(y - c.y) < grid / 2) ?? null;
}
/** The other cells of a TP cell's group. */
export const linkedTps = (tps, cell) => (cell && cell.group ? (tps || []).filter((c) => c.group === cell.group && c.id !== cell.id) : []);

/** Ghosts of the tokens standing on TP cells: [{ token, from, to, x, y }] (to: the linked cell the ghost stands on). */
export function ghostsOf(tokens, tps, grid) {
  const out = [];
  for (const t of tokens) {
    const from = tpAt(tps, grid, t.x, t.y); if (!from) continue;
    for (const to of linkedTps(tps, from)) out.push({ token: t, from, to, x: to.x + (t.x - from.x), y: to.y + (t.y - from.y) });
  }
  return out;
}

/**
 * The light a ghost gives: its token's light (radius > 0, not hidden), from the ghost's position. Same rules as the token's own light
 * (stopped by walls, put out by anti-lights unless "players' light wins" and it is a player's token). The real light stays where the token is.
 */
export const ghostLights = (ghosts) => (ghosts || []).filter((g) => g.token.light > 0 && !g.token.hidden)
  .map((g) => ({ x: g.x, y: g.y, radius: g.token.light, player: !!g.token.pc }));

/**
 * Where a move "from a ghost" really starts: the token must stand on a TP cell linked to cell `viaId`. Returns that start point
 * (the ghost's position), or null when the move is not allowed.
 */
export function ghostStart(tps, grid, token, viaId) {
  const from = tpAt(tps, grid, token.x, token.y), to = (tps || []).find((c) => c.id === viaId);
  if (!from || !to || to.id === from.id || !to.group || to.group !== from.group) return null;
  return { x: to.x + (token.x - from.x), y: to.y + (token.y - from.y) };
}

/** The groups of a scene, in order, with their cells: [[group, cells]]. */
export function tpGroups(tps) {
  const m = new Map();
  for (const c of tps || []) { if (!m.has(c.group)) m.set(c.group, []); m.get(c.group).push(c); }
  return [...m];
}
/** A group name not used yet. */
export function newGroup(tps) {
  const used = new Set((tps || []).map((c) => c.group));
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}
