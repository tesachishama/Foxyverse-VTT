// Canvas battle map. World units are map pixels; the camera is {x, y} (world point at the top-left) plus zoom.
import { computeVision, inReveal, distToSeg } from './vision.js';
import { cellCenter } from './tp.js';
import { W as WALL, makeWall, blocksSight, blocksMove, moveBlocked, doorCenter, splitWall, nodesAt, moveNodes, mergeOnRelease, radiusStep } from './walls.js';
import { pickInArea, rectPoly, revealPts, pointInPoly, allowed, toggleItem, hasItem, mergeSelection, snapDelta, moveItems, placeAt } from './select.js';
import { wallToolFlags } from './tools.js';
const ICON = 0.5; // door, light and TP icons: half a cell
/** A hit (see hitItem) as a selection item (public/select.js). */
const asItem = (it) => (!it ? null : it.kind === 'door' || it.kind === 'wall' ? { kind: 'wall', index: it.index } : it.kind === 'light' ? { kind: 'light', id: it.light.id } : it.kind === 'tp' ? { kind: 'tp', id: it.cell.id } : null);

export const DEAD_ALPHA = 0.5;
const images = new Map();
function image(url, redraw) {
  if (!url) return null;
  let rec = images.get(url);
  if (!rec) {
    const img = new Image(); rec = { img, ok: false };
    img.onload = () => { rec.ok = true; redraw(); };
    img.src = url; images.set(url, rec);
  }
  return rec.ok ? rec.img : null;
}

/**
 * hooks:
 *  state() -> { scene, tokens, selected:Set, tool:{name, radius, snap}, gm, playerView, viewers:[{x,y,vision,darkvision}], lights:[{x,y,radius}],
 *             explored: { sceneId, dims, bits, rev } | null (what this player has seen before, drawn dimmed) }
 *  onVision(scene, vis): the vision was recomputed
 *  (state also carries viewerIds:Set of token ids whose eyes are used)
 *  canMove(token), hpRatio(token) -> 0..1|null, isDead(token) -> boolean, onFog(totalDarkness:boolean)
 *  onSelect(Set), onMove(token, x, y, final), onOpen(token), onSceneEdit(patch)
 *  onDoor(wall): a door icon was clicked; onPick({kind:'wall', index} | {kind:'light', id} | null): the GM picked a map item
 *  (state.picked is the picked item, drawn highlighted; a picked light shows a handle to resize its radius)
 */
export function createMap(canvas, hooks) {
  const ctx = canvas.getContext('2d');
  const layer = () => { const c = document.createElement('canvas'); return [c, c.getContext('2d')]; };
  const [fogC, fogX] = layer(), [visC, visX] = layer(), [litC, litX] = layer(), [pcC, pcX] = layer(), [greyC, greyX] = layer();
  const cam = { x: 0, y: 0, z: 1 };
  let W = 0, H = 0, dpr = 1, drag = null, lastSend = 0, sceneId = null, fitted = false, draft = null, cursor = null;
  let placing = null, hover = null; // a token following the pointer until a click puts it down (ROADMAP 3 §2.5)
  const pointers = new Map();
  let visCache = { scene: null, key: '', vis: null }, shownDoors = new Set();

  const size = (s) => ({ w: s.width || 2000, h: s.height || 1400 });
  const toWorld = (px, py) => ({ x: px / cam.z + cam.x, y: py / cam.z + cam.y });
  const redraw = () => requestAnimationFrame(draw);

  function resize() {
    const r = canvas.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    for (const c of [fogC, visC, litC, pcC, greyC]) { c.width = canvas.width; c.height = canvas.height; }
    redraw();
  }
  new ResizeObserver(resize).observe(canvas);

  function fit() {
    const { scene } = hooks.state(); if (!scene || !W || !H) return;
    const { w, h } = size(scene);
    fitted = true;
    cam.z = Math.min(W / w, H / h, 1.5) * 0.96;
    cam.x = w / 2 - W / 2 / cam.z; cam.y = h / 2 - H / 2 / cam.z; redraw();
  }
  const viewCenter = () => toWorld(W / 2, H / 2);

  function snapToken(scene, t, x, y) {
    const g = scene.grid, s = t.size;
    return { x: scene.ox + (Math.round((x - scene.ox) / g - s / 2) + s / 2) * g, y: scene.oy + (Math.round((y - scene.oy) / g - s / 2) + s / 2) * g };
  }
  /** mode: 'grid' (cell corners) | 'half' (half cells) | 'off' (free, but still magnetic to wall ends). `free` (Shift/Alt held) ignores everything. */
  function snapPoint(scene, x, y, free, mode = 'grid', magnet = true) {
    if (free) return { x: Math.round(x), y: Math.round(y) };
    const near = 12 / cam.z; // magnetise to existing wall ends first, so corners close cleanly (not while dragging a node: it merges on release)
    if (magnet) for (const w of scene.walls || []) for (const [px, py] of [[w[0], w[1]], [w[2], w[3]]]) if (Math.hypot(px - x, py - y) < near) return { x: px, y: py };
    if (mode === 'off') return { x: Math.round(x), y: Math.round(y) };
    const g = mode === 'half' ? scene.grid / 2 : scene.grid;
    return { x: Math.round((x - scene.ox) / g) * g + scene.ox, y: Math.round((y - scene.oy) / g) * g + scene.oy };
  }
  const bezier = (p0, c, p2, n) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n, u = 1 - t; return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y }; });
  const r10 = (v) => Math.round(v * 10) / 10;
  const chain = (pts, closed = false, preset = 'wall') => { const out = []; for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if (Math.hypot(a.x - b.x, a.y - b.y) > 0.5) out.push(makeWall(r10(a.x), r10(a.y), r10(b.x), r10(b.y), preset)); } return out; };
  const circlePts = (c, r, grid) => { const n = Math.max(12, Math.min(64, Math.round(r / (grid / 3)))); return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) })); };
  const curveSegs = (a, b, grid) => Math.max(8, Math.min(40, Math.round(Math.hypot(a.x - b.x, a.y - b.y) / (grid / 3))));

  // ---------------------------------------------------------------- vision & fog
  function vision(scene, st) {
    const key = JSON.stringify([scene.dark, scene._rev, scene.walls, st.viewers.map((v) => [v.x, v.y, v.vision, v.darkvision]), st.lights.map((l) => [l.x, l.y, l.radius, l.anti, l.playersWin, l.player])]);
    if (visCache.scene !== scene || visCache.key !== key) {
      visCache = { scene, key, vis: computeVision(scene, st.viewers, st.lights) };
      hooks.onVision?.(scene, visCache.vis); // e.g. remember what a player has seen (exploration memory)
    }
    return visCache.vis;
  }
  const poly = (c, pts) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); };
  const world = (c, fn) => { c.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * dpr * cam.z, -cam.y * dpr * cam.z); fn(c); c.setTransform(1, 0, 0, 1, 0, 0); };
  const clearL = (c, l) => { c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.filter = 'none'; c.clearRect(0, 0, l.width, l.height); };
  const discIn = (c, pts, x, y, r) => { c.save(); poly(c, pts); c.clip(); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.restore(); };
  const fillZones = (layer, zones) => world(layer, (c) => { c.fillStyle = '#fff'; for (const z of zones) discIn(c, z.poly, z.x, z.y, z.r); });
  /** The explored half cells as a tiny picture (one pixel each), redrawn only when the memory changes. */
  // "seen": every explored half cell; "grey": the ones seen only through darkvision (never in colour)
  const exploredPics = { seen: { ex: null, rev: null, canvas: null }, grey: { ex: null, rev: null, canvas: null } };
  function exploredCanvas(ex, mode = 'seen') {
    const pic = exploredPics[mode];
    if (pic.ex === ex && pic.rev === ex.rev) return pic.canvas; // a new memory (reset, other scene) is a new object
    const c = document.createElement('canvas'); c.width = ex.dims.cols; c.height = ex.dims.rows;
    const x = c.getContext('2d'), img = x.createImageData(c.width, c.height), bit = (b, i) => (b[i >> 3] >> (i & 7)) & 1;
    for (let i = 0; i < c.width * c.height; i++) if (bit(ex.bits, i) && (mode === 'seen' || !bit(ex.color ?? ex.bits, i))) img.data[i * 4 + 3] = 255;
    x.putImageData(img, 0, 0);
    exploredPics[mode] = { ex, rev: ex.rev, canvas: c };
    return c;
  }
  const drawExplored = (layer, ex, mode) => world(layer, (c) => { c.imageSmoothingEnabled = true; c.drawImage(exploredCanvas(ex, mode), 0, 0, ex.dims.cols * ex.dims.cell, ex.dims.rows * ex.dims.cell); });

  /**
   * Fog of war (ROADMAP 2 §4): what the page shows is V ∩ L (the whole V in a lit scene), plus the darkvision viewers' V, which
   * is black and white where there is no light. Explored places stay dimmed (without tokens); never seen ones stay black.
   */
  function drawFog(scene, vis, alpha, explored) {
    clearL(visX, visC); clearL(litX, litC);
    fillZones(visX, vis.sight.filter((s) => !s.dv || !vis.dark)); // what normal eyes see (and everyone in a lit scene)
    if (vis.dark) {
      // L: lights minus anti-lights; the lights of players' tokens go on their own layer, only beaten by anti-lights without "players win"
      clearL(pcX, pcC);
      fillZones(litX, vis.lit.filter((l) => !l.player)); fillZones(pcX, vis.lit.filter((l) => l.player));
      litX.globalCompositeOperation = 'destination-out'; pcX.globalCompositeOperation = 'destination-out';
      fillZones(litX, vis.anti); fillZones(pcX, vis.anti.filter((a) => !a.playersWin));
      litX.globalCompositeOperation = 'source-over'; pcX.globalCompositeOperation = 'source-over';
      litX.drawImage(pcC, 0, 0);
      visX.globalCompositeOperation = 'destination-in'; visX.drawImage(litC, 0, 0); visX.globalCompositeOperation = 'source-over'; // V ∩ L
      const dv = vis.sight.filter((s) => s.dv);
      if (dv.length) {
        // darkvision: its whole V; the part outside L is shown in black and white
        clearL(pcX, pcC); fillZones(pcX, dv);
        visX.drawImage(pcC, 0, 0);
        pcX.globalCompositeOperation = 'destination-out'; pcX.drawImage(litC, 0, 0); pcX.globalCompositeOperation = 'source-over';
        clearL(greyX, greyC);
        greyX.filter = 'grayscale(1)'; greyX.drawImage(canvas, 0, 0); greyX.filter = 'none';
        greyX.globalCompositeOperation = 'destination-in'; greyX.drawImage(pcC, 0, 0); greyX.globalCompositeOperation = 'source-over';
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(greyC, 0, 0); ctx.restore();
      }
    }
    world(visX, (c) => { c.fillStyle = '#fff'; for (const r of scene.reveal || []) { poly(c, revealPts(r)); c.fill(); } });
    if (explored) { // remembered places seen only through darkvision stay black and white (outside what is seen right now)
      clearL(pcX, pcC); drawExplored(pcX, explored, 'grey');
      pcX.globalCompositeOperation = 'destination-out'; pcX.drawImage(visC, 0, 0); pcX.globalCompositeOperation = 'source-over';
      clearL(greyX, greyC);
      greyX.filter = 'grayscale(1)'; greyX.drawImage(canvas, 0, 0); greyX.filter = 'none';
      greyX.globalCompositeOperation = 'destination-in'; greyX.drawImage(pcC, 0, 0); greyX.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(greyC, 0, 0); ctx.restore();
    }
    clearL(fogX, fogC); fogX.fillStyle = '#000'; fogX.fillRect(0, 0, fogC.width, fogC.height);
    fogX.globalCompositeOperation = 'destination-out';
    if (explored) { fogX.globalAlpha = 0.42; drawExplored(fogX, explored, 'seen'); fogX.globalAlpha = 1; } // places seen before: dimmed, not black (soft edges)
    fogX.drawImage(visC, 0, 0); fogX.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = alpha; ctx.drawImage(fogC, 0, 0); ctx.restore();
  }
  // ---------------------------------------------------------------- drawing
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const st = hooks.state(), { scene, tokens, selected } = st;
    ctx.fillStyle = '#1f0013'; ctx.fillRect(0, 0, W, H);
    if (!scene) return;
    if (scene.id !== sceneId) { sceneId = scene.id; fitted = false; }
    if (!fitted) { fit(); if (fitted) return; }
    const godView = st.gm && !st.playerView, fogOn = scene.fog;
    const vis = fogOn ? vision(scene, st) : null;
    hooks.onFog?.(fogOn && !godView && st.viewers.length === 0);

    ctx.save(); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
    const { w, h } = size(scene);
    const img = image(scene.image, redraw);
    if (img) ctx.drawImage(img, 0, 0, w, h); else { ctx.fillStyle = '#3a0023'; ctx.fillRect(0, 0, w, h); }
    ctx.strokeStyle = 'rgba(255,219,255,0.2)'; ctx.lineWidth = 1 / cam.z; ctx.beginPath();
    for (let x = scene.ox % scene.grid; x <= w; x += scene.grid) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = scene.oy % scene.grid; y <= h; y += scene.grid) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();

    const fogged = fogOn && !godView, own = (t) => fogged && st.viewerIds.has(t.id);
    for (const t of tokens) {
      if (own(t)) continue; // drawn above the fog, below
      if (fogged && !vis.canSee(t.x, t.y)) continue;
      drawToken(scene, t, selected.has(t.id));
    }
    ctx.restore();

    if (fogOn) drawFog(scene, vis, godView ? 0.5 : 1, !godView && st.explored?.sceneId === scene.id ? st.explored : null);
    ctx.save(); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
    for (const t of tokens) if (own(t)) drawToken(scene, t, selected.has(t.id)); // a player always sees their own tokens, even in the dark (not the map around them)
    // ghosts of tokens standing on TP cells, on every linked cell (seen like tokens: own ones always)
    for (const g of st.ghosts || []) if (!fogged || own(g.token) || vis.canSee(g.x, g.y)) drawToken(scene, { ...g.token, x: g.x, y: g.y }, false, true);
    drawDoors(scene, st, fogOn && !godView ? vis : null);
    if (placing && hover) { const at = placeAt(scene, placing.token.size || 1, hover.x, hover.y, st.tool.snap); drawToken(scene, { ...placing.token, ...at }, true, true); }
    if (st.gm) drawGuides(scene, st);
    ctx.restore();
  }

  /** Door icons (half a cell) on their segment, for everyone; under the fog only where the viewer sees one side of the door. */
  function drawDoors(scene, st, vis) {
    const g = scene.grid, s = ICON * g, img = image('/icons/door.svg', redraw);
    shownDoors = new Set(); // a player can only click the doors drawn for them
    (scene.walls || []).forEach((w, i) => {
      if (!w[WALL.door]) return;
      const c = doorCenter(w);
      if (vis) {
        const len = Math.hypot(w[2] - w[0], w[3] - w[1]) || 1, nx = -(w[3] - w[1]) / len * g * 0.3, ny = (w[2] - w[0]) / len * g * 0.3;
        if (!vis.canSee(c.x + nx, c.y + ny) && !vis.canSee(c.x - nx, c.y - ny)) return;
      }
      shownDoors.add(i);
      ctx.save();
      ctx.globalAlpha = w[WALL.open] ? 0.55 : 1;
      if (img) ctx.drawImage(img, c.x - s / 2, c.y - s / 2, s, s); else { ctx.fillStyle = '#7ad7ff'; ctx.fillRect(c.x - s / 2, c.y - s / 2, s, s); }
      ctx.globalAlpha = 1;
      if (w[WALL.locked]) { ctx.fillStyle = '#ffd84d'; ctx.beginPath(); ctx.arc(c.x + s / 2, c.y - s / 2, s * 0.18, 0, Math.PI * 2); ctx.fill(); } // locked: a gold dot
      if (st.picked?.kind === 'wall' && st.picked.index === i) { ctx.strokeStyle = '#ff9a4d'; ctx.lineWidth = 3 / cam.z; ctx.strokeRect(c.x - s / 2, c.y - s / 2, s, s); }
      ctx.restore();
    });
  }

  function drawToken(scene, t, selected, ghost = false) {
    const d = t.size * scene.grid * 0.92, r = d / 2;
    const dead = !!hooks.isDead?.(t);
    ctx.save(); ctx.globalAlpha = (t.hidden ? 0.5 : 1) * (dead ? DEAD_ALPHA : 1) * (ghost ? 0.45 : 1); // a ghost (TP): see-through
    if (dead) ctx.filter = 'grayscale(1)'; // a dead character: black and white, 50 % opacity (and no vision, see app.js)
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, Math.PI * 2); ctx.fillStyle = t.color; ctx.fill();
    const ti = image(t.image, redraw);
    if (ti) { ctx.save(); ctx.clip(); ctx.drawImage(ti, t.x - r, t.y - r, d, d); ctx.restore(); }
    else { ctx.fillStyle = '#2a0019'; ctx.font = `600 ${r}px Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((t.name[0] || '?').toUpperCase(), t.x, t.y + r * 0.05); }
    ctx.filter = 'none';
    ctx.lineWidth = (selected ? 4 : 2) / cam.z; ctx.strokeStyle = selected ? '#ff9a4d' : '#ffdbff';
    if (t.hidden || ghost) ctx.setLineDash([6 / cam.z, 4 / cam.z]);
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    const ratio = hooks.hpRatio(t);
    if (ratio != null) {
      const bw = d * 0.8, by = t.y + r + 3 / cam.z, bh = 5 / cam.z;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(t.x - bw / 2, by, bw, bh);
      ctx.fillStyle = ratio > 0.5 ? '#9fe3b4' : ratio > 0.25 ? '#ffd84d' : '#ff8a8a'; ctx.fillRect(t.x - bw / 2, by, bw * Math.max(0, Math.min(1, ratio)), bh);
    }
    if (cam.z > 0.35) {
      ctx.font = `${12 / cam.z}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(t.name).width, ly = t.y - r - 16 / cam.z;
      ctx.fillStyle = 'rgba(42,0,25,0.8)'; ctx.fillRect(t.x - tw / 2 - 3 / cam.z, ly, tw + 6 / cam.z, 14 / cam.z);
      ctx.fillStyle = '#ffdbff'; ctx.fillText(t.name, t.x, ly + 1 / cam.z);
    }
    ctx.restore();
  }

  function drawGuides(scene, st) {
    const z = 1 / cam.z, editing = st.tool.name !== 'select', items = st.items || [];
    const isSel = (it) => hasItem(items, it) || (st.picked && hasItem([st.picked], it));
    (scene.reveal || []).forEach((r, i) => {
      const sel = isSel({ kind: 'reveal', index: i });
      poly(ctx, revealPts(r)); ctx.fillStyle = sel ? 'rgba(255,154,77,0.12)' : 'rgba(159,227,180,0.08)'; ctx.fill();
      ctx.setLineDash([8 * z, 6 * z]); ctx.strokeStyle = sel ? '#ff9a4d' : 'rgba(159,227,180,0.6)'; ctx.lineWidth = (sel ? 2 : 1) * z; ctx.stroke(); ctx.setLineDash([]);
    });
    // walls: orange = sight + light, green dashed = movement only, orange with a green core = both; doors in blue (dashed when open)
    (scene.walls || []).forEach((w, i) => {
      const picked = isSel({ kind: 'wall', index: i });
      ctx.lineCap = 'round';
      if (picked) { ctx.lineWidth = 9 * z; ctx.strokeStyle = 'rgba(255,219,255,0.5)'; ctx.beginPath(); ctx.moveTo(w[0], w[1]); ctx.lineTo(w[2], w[3]); ctx.stroke(); }
      const sight = blocksSight(w) || (w[WALL.door] && w[WALL.open]), move = !w[WALL.door] && blocksMove(w);
      ctx.lineWidth = (w[WALL.door] ? 4 : 3) * z;
      ctx.strokeStyle = w[WALL.door] ? (w[WALL.open] ? 'rgba(122,215,255,0.45)' : '#7ad7ff') : sight ? '#ff9a4d' : '#9fe3b4';
      if ((w[WALL.door] && w[WALL.open]) || (!sight && move)) ctx.setLineDash([5 * z, 7 * z]);
      ctx.beginPath(); ctx.moveTo(w[0], w[1]); ctx.lineTo(w[2], w[3]); ctx.stroke(); ctx.setLineDash([]);
      if (sight && move) { ctx.lineWidth = 1.2 * z; ctx.strokeStyle = '#9fe3b4'; ctx.beginPath(); ctx.moveTo(w[0], w[1]); ctx.lineTo(w[2], w[3]); ctx.stroke(); }
      if (editing || picked) { ctx.fillStyle = '#ffdbff'; for (const [px, py] of [[w[0], w[1]], [w[2], w[3]]]) { ctx.beginPath(); ctx.arc(px, py, 3 * z, 0, Math.PI * 2); ctx.fill(); } }
    });
    // TP cells (GM only): icon, and a dashed line to the other cells of the same group
    const tps = scene.tps || [], ts = ICON * scene.grid, tpImg = image('/icons/tp.svg', redraw);
    ctx.strokeStyle = 'rgba(159,227,180,0.55)'; ctx.lineWidth = 1.5 * z; ctx.setLineDash([4 * z, 6 * z]);
    tps.forEach((a, i) => { for (const b of tps.slice(i + 1)) if (b.group === a.group) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } });
    ctx.setLineDash([]);
    for (const c of tps) {
      if (tpImg) ctx.drawImage(tpImg, c.x - ts / 2, c.y - ts / 2, ts, ts); else { ctx.fillStyle = '#9fe3b4'; ctx.fillRect(c.x - ts / 2, c.y - ts / 2, ts, ts); }
      ctx.font = `600 ${11 * z}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#9fe3b4'; ctx.fillText(c.group, c.x + ts / 2 + 2 * z, c.y - ts / 2);
      if (isSel({ kind: 'tp', id: c.id })) { ctx.strokeStyle = '#ff9a4d'; ctx.lineWidth = 3 * z; ctx.strokeRect(c.x - ts / 2, c.y - ts / 2, ts, ts); }
    }
    // lights: small icons (GM only); the picked one shows its radius and a handle to resize it
    for (const l of scene.lights || []) {
      const anti = l.kind === 'anti', s = ICON * scene.grid, img = image(anti ? '/icons/antilight.svg' : '/icons/light.svg', redraw);
      const picked = st.picked?.kind === 'light' && st.picked.id === l.id, color = anti ? 'rgba(235,165,255,0.75)' : 'rgba(255,216,77,0.7)';
      if (!picked && isSel({ kind: 'light', id: l.id })) { ctx.strokeStyle = '#ff9a4d'; ctx.lineWidth = 3 * z; ctx.strokeRect(l.x - s / 2, l.y - s / 2, s, s); }
      if (editing || picked) { ctx.setLineDash([6 * z, 6 * z]); ctx.strokeStyle = color; ctx.lineWidth = (picked ? 2 : 1) * z; ctx.beginPath(); ctx.arc(l.x, l.y, l.radius * scene.grid, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
      if (img) ctx.drawImage(img, l.x - s / 2, l.y - s / 2, s, s); else { ctx.fillStyle = anti ? '#eba5ff' : '#ffd84d'; ctx.beginPath(); ctx.arc(l.x, l.y, s / 2, 0, Math.PI * 2); ctx.fill(); }
      if (picked) {
        ctx.strokeStyle = '#ff9a4d'; ctx.lineWidth = 3 * z; ctx.strokeRect(l.x - s / 2, l.y - s / 2, s, s);
        const hx = l.x + l.radius * scene.grid; // the radius handle, on the right of the circle
        ctx.fillStyle = '#ff9a4d'; ctx.beginPath(); ctx.arc(hx, l.y, 7 * z, 0, Math.PI * 2); ctx.fill();
        ctx.font = `${12 * z}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffdbff'; ctx.fillText(`${l.radius}`, hx + 10 * z, l.y);
      }
    }
    if (draft?.pts?.length && cursor) { // wall in progress
      const last = draft.pts[draft.pts.length - 1];
      ctx.strokeStyle = draft.door ? '#7ad7ff' : '#ff9a4d'; ctx.lineWidth = 3 * z; ctx.setLineDash([6 * z, 4 * z]);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(cursor.x, cursor.y); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const area of [draft?.marquee, draft?.lasso]) if (area?.length > 1) { // the selection being drawn
      ctx.setLineDash([6 * z, 4 * z]); ctx.strokeStyle = '#ffdbff'; ctx.lineWidth = 1.5 * z; poly(ctx, area); ctx.fillStyle = 'rgba(255,219,255,0.08)'; ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    }
    if (draft?.revpoly) { // polygon in progress: its sides, the next side to the cursor, its first corner (click it to close)
      const pts = draft.revpoly;
      ctx.strokeStyle = '#9fe3b4'; ctx.lineWidth = 2 * z; ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (cursor) ctx.lineTo(cursor.x, cursor.y);
      ctx.stroke();
      ctx.fillStyle = '#9fe3b4'; ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], 6 * z, 0, Math.PI * 2); ctx.fill();
    }
    if (draft?.rect) { const r = draft.rect; ctx.strokeStyle = '#9fe3b4'; ctx.lineWidth = 2 * z; ctx.strokeRect(r.x, r.y, r.w, r.h); }
    ctx.strokeStyle = '#ff9a4d'; ctx.lineWidth = 3 * z; ctx.setLineDash([6 * z, 4 * z]);
    const sh = draft?.shape;
    if (sh?.type === 'rect') ctx.strokeRect(Math.min(sh.x, sh.x2), Math.min(sh.y, sh.y2), Math.abs(sh.x2 - sh.x), Math.abs(sh.y2 - sh.y));
    if (sh?.type === 'circle') { ctx.beginPath(); ctx.arc(sh.x, sh.y, Math.hypot(sh.x2 - sh.x, sh.y2 - sh.y), 0, Math.PI * 2); ctx.stroke(); }
    if (draft?.curve && cursor) {
      const [a, b] = draft.curve.pts, ctrl = draft.curve.pts[2] ?? cursor;
      const pts = draft.curve.pts.length === 1 ? [a, cursor] : bezier(a, ctrl, b, curveSegs(a, b, scene.grid));
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke();
      ctx.fillStyle = '#ffdbff'; for (const q of draft.curve.pts) { ctx.beginPath(); ctx.arc(q.x, q.y, 4 * z, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.setLineDash([]);
  }

  // ---------------------------------------------------------------- input
  function hitToken(px, py) {
    const { scene, tokens } = hooks.state(); if (!scene) return null;
    const p = toWorld(px, py);
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i], r = (t.size * scene.grid * 0.92) / 2;
      if (Math.hypot(p.x - t.x, p.y - t.y) <= r) return t;
    }
    return null;
  }
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const edit = (patch) => hooks.onSceneEdit(patch);

  /** What is under the pointer among the GM's map items: a door icon, a light icon (or the picked light's radius handle), a wall. */
  function hitItem(scene, w, gm, picked) {
    const g = scene.grid, half = (ICON * g) / 2 + 2 / cam.z, near = 10 / cam.z;
    for (const [i, wl] of (scene.walls || []).entries()) if (wl[WALL.door] && (gm || shownDoors.has(i))) { const c = doorCenter(wl); if (Math.abs(w.x - c.x) <= half && Math.abs(w.y - c.y) <= half) return { kind: 'door', index: i }; }
    if (!gm) return null;
    const pl = picked?.kind === 'light' && (scene.lights || []).find((l) => l.id === picked.id);
    if (pl && Math.hypot(w.x - (pl.x + pl.radius * g), w.y - pl.y) < 12 / cam.z) return { kind: 'radius', light: pl };
    for (const l of [...(scene.lights || [])].reverse()) if (Math.abs(w.x - l.x) <= half && Math.abs(w.y - l.y) <= half) return { kind: 'light', light: l };
    for (const c of [...(scene.tps || [])].reverse()) if (Math.abs(w.x - c.x) <= half && Math.abs(w.y - c.y) <= half) return { kind: 'tp', cell: c };
    const wi = (scene.walls || []).findIndex((s) => distToSeg(w.x, w.y, s) < near);
    return wi >= 0 ? { kind: 'wall', index: wi } : null;
  }
  // the wall tool (ROADMAP 3 §1.4): one tool, a shape (line, curve, rectangle, circle) and three boxes: tangible, opaque, door
  const shapeOf = (tool) => (tool.name === 'wall' ? tool.shape || 'line' : tool.name);
  const preset = (tool) => wallToolFlags(shapeOf(tool), tool.wall);

  function useTool(st, e, p) {
    const { scene, tool } = st, w = toWorld(p.x, p.y), free = e.shiftKey || e.altKey, near = 12 / cam.z, snap = (x, y) => snapPoint(scene, x, y, free, tool.snap);
    if (shapeOf(tool) === 'line') {
      const door = preset(tool).door; // a door is one segment: two clicks
      if (door && !draft) { // clicking an existing door toggles it open/closed
        const hit = hitItem(scene, w, true, null);
        if (hit?.kind === 'door') return hooks.onDoor?.(scene.walls[hit.index]);
      }
      const pt = snap(w.x, w.y);
      if (!draft) { draft = { pts: [pt], door }; return redraw(); }
      const last = draft.pts[draft.pts.length - 1];
      if (last.x !== pt.x || last.y !== pt.y) edit({ walls: [...(scene.walls || []), makeWall(last.x, last.y, pt.x, pt.y, preset(tool), door)] });
      draft = door ? null : { pts: [pt], door }; // doors are single segments, walls chain on
      return redraw();
    }
    if (shapeOf(tool) === 'curve') { // start, end, then bend: three clicks
      const pt = snap(w.x, w.y);
      if (!draft?.curve) { draft = { curve: { pts: [pt] } }; return redraw(); }
      const c = draft.curve; c.pts.push(pt);
      if (c.pts.length < 3) return redraw();
      const [a, b, ctrl] = c.pts;
      draft = null;
      return edit({ walls: [...(scene.walls || []), ...chain(bezier(a, ctrl, b, curveSegs(a, b, scene.grid)), false, preset(tool))] });
    }
    if (tool.name === 'edit') {
      // grab a node (every wall end at that spot moves together); on a segment away from its ends, add a node there and grab it
      let best = null;
      for (const wl of scene.walls || []) for (const k of [0, 2]) { const d = Math.hypot(wl[k] - w.x, wl[k + 1] - w.y); if (d < near && (!best || d < best.d)) best = { d, x: wl[k], y: wl[k + 1] }; }
      let walls = scene.walls || [];
      if (!best) {
        const i = walls.findIndex((s) => distToSeg(w.x, w.y, s) < near);
        if (i < 0) return;
        const s = walls[i], dx = s[2] - s[0], dy = s[3] - s[1], t = Math.max(0, Math.min(1, ((w.x - s[0]) * dx + (w.y - s[1]) * dy) / (dx * dx + dy * dy || 1)));
        best = { x: r10(s[0] + t * dx), y: r10(s[1] + t * dy) };
        walls = splitWall(walls, i, best.x, best.y);
      }
      drag = { kind: 'vertex', refs: nodesAt(walls, best.x, best.y), walls, orig: scene.walls, moved: false };
      scene.walls = walls; scene._rev = (scene._rev || 0) + 1; return redraw();
    }
    if (tool.name === 'light' || tool.name === 'antilight') {
      const id = Math.random().toString(36).slice(2, 10);
      edit({ lights: [...(scene.lights || []), { id, x: Math.round(w.x), y: Math.round(w.y), radius: radiusStep(tool.radius), kind: tool.name === 'antilight' ? 'anti' : 'light', playersWin: false }] });
      return hooks.onPick?.({ kind: 'light', id });
    }
    if (tool.name === 'tp') { // a TP cell on the clicked grid cell; it joins the picked cell's group, else a new group
      const c = cellCenter(scene, w.x, w.y), id = Math.random().toString(36).slice(2, 10);
      if ((scene.tps || []).some((x) => x.x === c.x && x.y === c.y)) return;
      const picked = st.picked?.kind === 'tp' && (scene.tps || []).find((x) => x.id === st.picked.id);
      edit({ tps: [...(scene.tps || []), { id, x: c.x, y: c.y, group: picked ? picked.group : hooks.newTpGroup?.() ?? '1' }] });
      return hooks.onPick?.({ kind: 'tp', id });
    }
    if (tool.name === 'erase') {
      const ti = (scene.tps || []).findIndex((c) => Math.abs(c.x - w.x) < (ICON * scene.grid) / 2 && Math.abs(c.y - w.y) < (ICON * scene.grid) / 2);
      if (ti >= 0) return edit({ tps: scene.tps.filter((_, i) => i !== ti) });
      const li = (scene.lights || []).findIndex((l) => Math.hypot(l.x - w.x, l.y - w.y) < Math.max(near * 1.5, (ICON * scene.grid) / 2));
      if (li >= 0) return edit({ lights: scene.lights.filter((_, i) => i !== li) });
      const wi = (scene.walls || []).findIndex((s) => distToSeg(w.x, w.y, s) < near);
      if (wi >= 0) return edit({ walls: scene.walls.filter((_, i) => i !== wi) });
      const ri = (scene.reveal || []).findLastIndex((r) => inReveal({ reveal: [r] }, w.x, w.y));
      if (ri >= 0) return edit({ reveal: scene.reveal.filter((_, i) => i !== ri) });
    }
  }

  /** At most n points of a free-hand line (every k-th one). */
  const thin = (pts, n) => (pts.length <= n ? pts : pts.filter((_, i) => i % Math.ceil(pts.length / n) === 0));
  /** Finish the polygon being drawn with the reveal tool (a double click, or a click on its first corner). */
  function closePoly() {
    const pts = [];
    for (const q of draft?.revpoly ?? []) if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 1) pts.push(q); // a double click adds the same corner twice
    draft = null;
    const { scene } = hooks.state();
    if (pts.length >= 3) edit({ reveal: [...(scene.reveal || []), { poly: pts.slice(0, 500) }] });
    redraw();
  }
  /** Start dragging the whole selection (tokens and map items) from world point w. */
  function startGroup(st, w) {
    const sc = st.scene;
    drag = { kind: 'group', start: w, d: { dx: 0, dy: 0 }, moved: false, items: [...(st.items || [])],
      toks: st.tokens.filter((t) => st.selected.has(t.id)).map((t) => ({ t, x: t.x, y: t.y })),
      orig: { walls: sc.walls, lights: sc.lights, tps: sc.tps, reveal: sc.reveal } };
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e); pointers.set(e.pointerId, p);
    if (pointers.size === 2) { // pinch / two-finger pan
      const [a, b] = [...pointers.values()];
      drag = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      return;
    }
    const st = hooks.state(), tool = st.tool.name;
    if (placing) { // a click puts the token down (calibrated to the grid by the snapping mode); right click cancels
      const w = toWorld(p.x, p.y), pl = placing; placing = null; canvas.style.cursor = '';
      if (e.button === 0 && st.scene) pl.done(placeAt(st.scene, pl.token.size || 1, w.x, w.y, st.tool.snap)); else pl.cancel?.();
      return redraw();
    }
    if (e.button === 1 || e.button === 2) { drag = { kind: 'pan', sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false, right: e.button === 2 }; return; }
    if (tool !== 'select' && st.gm && st.scene) {
      if (tool === 'reveal') { // three ways (ROADMAP 3 §1.3): rectangle, lasso (free hand), polygon (click the corners)
        const w = toWorld(p.x, p.y), mode = st.tool.reveal || 'rect';
        if (mode === 'lasso') { drag = { kind: 'revlasso', pts: [[w.x, w.y]] }; draft = { lasso: drag.pts }; return; }
        if (mode === 'poly') {
          const pt = snapPoint(st.scene, w.x, w.y, e.shiftKey || e.altKey, st.tool.snap, false), pts = draft?.revpoly;
          if (pts?.length >= 3 && Math.hypot(pt.x - pts[0][0], pt.y - pts[0][1]) < 10 / cam.z) return closePoly(); // back on the first corner
          if (!pts) draft = { revpoly: [[pt.x, pt.y]] }; else pts.push([pt.x, pt.y]);
          return redraw();
        }
        drag = { kind: 'rect', x: w.x, y: w.y }; draft = { pts: [], rect: { x: w.x, y: w.y, w: 0, h: 0 } }; return;
      }
      const shape = shapeOf(st.tool);
      if (tool === 'wall' && (shape === 'rect' || shape === 'circle')) {
        const w = toWorld(p.x, p.y), pt = snapPoint(st.scene, w.x, w.y, e.shiftKey || e.altKey, st.tool.snap);
        drag = { kind: 'shape', type: shape, x: pt.x, y: pt.y }; draft = { pts: [], shape: { type: shape, x: pt.x, y: pt.y, x2: pt.x, y2: pt.y } }; return;
      }
      return useTool(st, e, p);
    }
    const w = toWorld(p.x, p.y), item = st.scene && hitItem(st.scene, w, st.gm, st.picked);
    if (item?.kind === 'radius') { drag = { kind: 'radius', id: item.light.id, lights: st.scene.lights.map((l) => ({ ...l })), orig: st.scene.lights }; return; }
    // the GM's selection (ROADMAP 3 §1.2): the checkboxes say what can be picked; Shift adds or takes out; Shift+drag is a lasso
    const filter = st.gm ? st.filter : null, items = st.items || [];
    const mapItem = st.gm ? asItem(item) : null, okItem = !!mapItem && allowed(st.scene, mapItem, filter);
    const tok = hitToken(p.x, p.y), okTok = !!tok && (!st.gm || filter?.tokens !== false);
    if (st.gm && e.shiftKey && st.scene) {
      if (okTok) { const next = new Set(st.selected); if (next.has(tok.id)) next.delete(tok.id); else next.add(tok.id); hooks.onSelect(next, items); return redraw(); }
      if (okItem) { hooks.onSelect(new Set(st.selected), toggleItem(items, mapItem)); return redraw(); }
      drag = { kind: 'lasso', pts: [[w.x, w.y]] }; draft = { lasso: drag.pts }; return redraw();
    }
    // pressing on a part of a selection of several things drags them all together
    const inSelReveal = !tok && !item && items.some((it) => it.kind === 'reveal' && st.scene.reveal?.[it.index] && pointInPoly(w.x, w.y, revealPts(st.scene.reveal[it.index])));
    if (st.gm && st.selected.size + items.length > 1 && ((okTok && st.selected.has(tok.id)) || (okItem && hasItem(items, mapItem)) || inSelReveal)) { startGroup(st, w); return redraw(); }
    if (item?.kind === 'door') { hooks.onDoor?.(st.scene.walls[item.index]); if (okItem) hooks.onPick?.({ kind: 'wall', index: item.index }); return redraw(); }
    if (item?.kind === 'tp' && okItem) {
      hooks.onPick?.({ kind: 'tp', id: item.cell.id });
      drag = { kind: 'tp', id: item.cell.id, tps: st.scene.tps.map((c) => ({ ...c })), orig: st.scene.tps, moved: false };
      return redraw();
    }
    // a ghost (TP): picking it up teleports the real token there, and the move goes on from that side
    const ghost = !hitToken(p.x, p.y) && [...(st.ghosts || [])].reverse().find((g) => Math.hypot(w.x - g.x, w.y - g.y) <= (g.token.size * st.scene.grid * 0.92) / 2);
    if (ghost && hooks.canMove(ghost.token)) {
      const t = ghost.token, home = { x: t.x, y: t.y }; hooks.onSelect(new Set([t.id]), []);
      t.x = ghost.x; t.y = ghost.y;
      drag = { kind: 'token', t, dx: 0, dy: 0, ok: { x: t.x, y: t.y }, sent: { x: t.x, y: t.y }, free: st.gm, via: ghost.to.id, home, moved: false };
      drag.dx = t.x - w.x; drag.dy = t.y - w.y;
      return redraw();
    }
    if (item?.kind === 'light' && okItem) {
      hooks.onPick?.({ kind: 'light', id: item.light.id });
      drag = { kind: 'light', id: item.light.id, dx: item.light.x - w.x, dy: item.light.y - w.y, lights: st.scene.lights.map((l) => ({ ...l })), orig: st.scene.lights, moved: false };
      return redraw();
    }
    const t = okTok ? tok : null, { selected } = st;
    if (t) {
      const next = new Set(e.shiftKey ? selected : []);
      if (e.shiftKey && selected.has(t.id)) next.delete(t.id); else next.add(t.id);
      hooks.onSelect(next, []);
      if (hooks.canMove(t) && !e.shiftKey) drag = { kind: 'token', t, dx: t.x - w.x, dy: t.y - w.y, ok: { x: t.x, y: t.y }, sent: { x: t.x, y: t.y }, free: st.gm };
    } else if (st.gm && okItem && mapItem.kind === 'wall') {
      hooks.onPick?.(mapItem);
    } else if (st.gm && st.scene) { // the empty map: a selection rectangle (a click without dragging clears the selection)
      drag = { kind: 'marquee', x: w.x, y: w.y, sx: p.x, sy: p.y }; draft = { marquee: rectPoly(w.x, w.y, w.x, w.y) };
    } else {
      if (!e.shiftKey) hooks.onSelect(new Set(), []);
      drag = { kind: 'pan', sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false };
    }
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    const st = hooks.state();
    hover = toWorld(p.x, p.y);
    if (placing) { canvas.style.cursor = 'copy'; return redraw(); }
    if (st.scene && st.tool.name !== 'select') { const w = toWorld(p.x, p.y); cursor = snapPoint(st.scene, w.x, w.y, e.shiftKey || e.altKey, st.tool.snap, drag?.kind !== 'vertex'); if (draft) redraw(); }
    if (!drag) { canvas.style.cursor = st.tool.name !== 'select' && st.gm ? 'crosshair' : hitToken(p.x, p.y) || (st.scene && hitItem(st.scene, toWorld(p.x, p.y), st.gm, st.picked)?.kind?.match(/door|light|radius/)) ? 'pointer' : 'grab'; return; }
    if (drag.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const before = toWorld(drag.mx, drag.my);
      cam.z = Math.min(4, Math.max(0.08, cam.z * (d / drag.d)));
      cam.x = before.x - mx / cam.z; cam.y = before.y - my / cam.z;
      drag.d = d; drag.mx = mx; drag.my = my; redraw(); return;
    }
    if (drag.kind === 'pan') {
      if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 3) drag.moved = true;
      cam.x = drag.cx - (p.x - drag.sx) / cam.z; cam.y = drag.cy - (p.y - drag.sy) / cam.z;
    } else if (drag.kind === 'shape') {
      draft.shape.x2 = cursor.x; draft.shape.y2 = cursor.y;
    } else if (drag.kind === 'vertex') { // only the grabbed ends move; passing over another node does not take it along
      const sc = st.scene;
      drag.walls = moveNodes(drag.walls, drag.refs, cursor.x, cursor.y); drag.moved = true;
      sc.walls = drag.walls; sc._rev = (sc._rev || 0) + 1;
    } else if (drag.kind === 'tp') { // TP cells move from cell centre to cell centre
      const sc = st.scene, c = drag.tps.find((x) => x.id === drag.id), w = toWorld(p.x, p.y), to = cellCenter(sc, w.x, w.y);
      if (c && (c.x !== to.x || c.y !== to.y)) { c.x = to.x; c.y = to.y; drag.moved = true; sc.tps = drag.tps; sc._rev = (sc._rev || 0) + 1; }
    } else if (drag.kind === 'light' || drag.kind === 'radius') {
      const sc = st.scene, w = toWorld(p.x, p.y), l = drag.lights.find((x) => x.id === drag.id); if (!l) return;
      if (drag.kind === 'light') { l.x = Math.round(w.x + drag.dx); l.y = Math.round(w.y + drag.dy); }
      else l.radius = radiusStep(Math.hypot(w.x - l.x, w.y - l.y) / sc.grid); // steps of half a cell
      drag.moved = true; sc.lights = drag.lights; sc._rev = (sc._rev || 0) + 1;
    } else if (drag.kind === 'marquee') {
      const w = toWorld(p.x, p.y); draft = { marquee: rectPoly(drag.x, drag.y, w.x, w.y) };
    } else if (drag.kind === 'lasso' || drag.kind === 'revlasso') {
      const w = toWorld(p.x, p.y), last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(w.x - last[0], w.y - last[1]) > 4 / cam.z && drag.pts.length < 2000) drag.pts.push([w.x, w.y]);
    } else if (drag.kind === 'group') {
      const sc = st.scene, w = toWorld(p.x, p.y), rx = w.x - drag.start.x, ry = w.y - drag.start.y;
      const d = e.altKey ? { dx: Math.round(rx), dy: Math.round(ry) } : snapDelta(sc, rx, ry, st.tool.snap);
      if (d.dx !== drag.d.dx || d.dy !== drag.d.dy) {
        drag.d = d; drag.moved = true;
        for (const m of drag.toks) { m.t.x = m.x + d.dx; m.t.y = m.y + d.dy; }
        Object.assign(sc, drag.orig, moveItems({ ...sc, ...drag.orig }, drag.items, d.dx, d.dy)); sc._rev = (sc._rev || 0) + 1;
      }
    } else if (drag.kind === 'rect') {
      const w = toWorld(p.x, p.y); draft.rect = { x: Math.min(drag.x, w.x), y: Math.min(drag.y, w.y), w: Math.abs(w.x - drag.x), h: Math.abs(w.y - drag.y) };
    } else if (drag.kind === 'token') {
      // players' tokens stop at tangible walls and closed doors (the server checks it too); the GM goes anywhere
      const w = toWorld(p.x, p.y), to = { x: w.x + drag.dx, y: w.y + drag.dy };
      if (Math.hypot(to.x - drag.ok.x, to.y - drag.ok.y) > 2) drag.moved = true;
      if (drag.free || !moveBlocked(st.scene?.walls, drag.ok.x, drag.ok.y, to.x, to.y)) drag.ok = to;
      drag.t.x = drag.ok.x; drag.t.y = drag.ok.y;
      if (performance.now() - lastSend > 90 && (drag.free || !moveBlocked(st.scene?.walls, drag.sent.x, drag.sent.y, drag.ok.x, drag.ok.y))) {
        lastSend = performance.now(); drag.sent = { ...drag.ok }; hooks.onMove(drag.t, drag.t.x, drag.t.y, false, drag.via); drag.via = null; // the jump is sent with the first move
      }
    }
    redraw();
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (drag?.kind === 'pinch') { if (pointers.size < 2) drag = null; return; }
    // a click on a ghost (ROADMAP 3 §1.6) makes it the real one: the token jumps there; it still stands on a linked cell, so a ghost stays
    // on the cell it left (nothing is lost, nothing to undo)
    if (drag?.kind === 'token' && drag.home && !drag.moved) { hooks.onMove(drag.t, drag.t.x, drag.t.y, true, drag.via); drag = null; return redraw(); }
    if (drag?.kind === 'token') {
      const { scene } = hooks.state(), t = drag.t;
      let s = scene ? snapToken(scene, t, t.x, t.y) : t;
      if (!drag.free && scene && moveBlocked(scene.walls, drag.sent.x, drag.sent.y, s.x, s.y)) s = moveBlocked(scene.walls, drag.sent.x, drag.sent.y, drag.ok.x, drag.ok.y) ? drag.sent : drag.ok;
      t.x = s.x; t.y = s.y; hooks.onMove(t, s.x, s.y, true, drag.via);
    }
    if (drag?.kind === 'marquee' || drag?.kind === 'lasso') {
      const st = hooks.state(), p = pos(e), area = drag.kind === 'lasso' ? drag.pts : draft?.marquee;
      draft = null;
      if (drag.kind === 'marquee' && Math.hypot(p.x - drag.sx, p.y - drag.sy) < 4) hooks.onSelect(new Set(), []); // a plain click
      else if (st.scene && area?.length >= 3) {
        const got = pickInArea(st.scene, st.tokens, area, st.filter);
        // the rectangle replaces the selection; the lasso (Shift) adds to it
        const next = drag.kind === 'lasso' ? mergeSelection({ tokens: [...st.selected], items: st.items || [] }, got) : got;
        hooks.onSelect(new Set(next.tokens), next.items);
      }
    }
    if (drag?.kind === 'revlasso') {
      const { scene } = hooks.state(), pts = thin(drag.pts, 500); draft = null;
      if (pts.length >= 3) edit({ reveal: [...(scene.reveal || []), { poly: pts.map(([x, y]) => [Math.round(x), Math.round(y)]) }] });
    }
    if (drag?.kind === 'group') {
      const { scene } = hooks.state(), d = drag.d, patch = moveItems({ ...scene, ...drag.orig }, drag.items, d.dx, d.dy);
      Object.assign(scene, drag.orig); scene._rev = (scene._rev || 0) + 1;
      if (drag.moved && (d.dx || d.dy)) hooks.onGroupMove?.(drag.toks.map((m) => ({ t: m.t, from: { x: m.x, y: m.y }, to: { x: m.t.x, y: m.t.y } })), patch);
      else for (const m of drag.toks) { m.t.x = m.x; m.t.y = m.y; }
    }
    if (drag?.kind === 'rect') {
      const r = draft?.rect, { scene } = hooks.state();
      draft = null;
      if (r && r.w > 8 && r.h > 8) edit({ reveal: [...(scene.reveal || []), [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]] });
    }
    if (drag?.kind === 'shape') {
      const sh = draft?.shape, st = hooks.state(), { scene } = st; draft = null;
      if (sh) {
        const dx = Math.abs(sh.x2 - sh.x), dy = Math.abs(sh.y2 - sh.y), kind = preset(st.tool);
        if (sh.type === 'rect' && dx > 8 && dy > 8) edit({ walls: [...(scene.walls || []), ...chain([{ x: sh.x, y: sh.y }, { x: sh.x2, y: sh.y }, { x: sh.x2, y: sh.y2 }, { x: sh.x, y: sh.y2 }], true, kind)] });
        const r = Math.hypot(dx, dy);
        if (sh.type === 'circle' && r > 12) edit({ walls: [...(scene.walls || []), ...chain(circlePts({ x: sh.x, y: sh.y }, r, scene.grid), true, kind)] });
      }
    }
    if (drag?.kind === 'vertex') { // merging happens here, on release only
      const { scene } = hooks.state(), walls = mergeOnRelease(drag.walls, drag.refs, 12 / cam.z);
      scene.walls = drag.orig;
      if (drag.moved || walls.length !== drag.orig.length) edit({ walls });
    }
    if (drag?.kind === 'tp' && drag.moved) { const { scene } = hooks.state(); const tps = drag.tps; scene.tps = drag.orig; edit({ tps }); }
    if ((drag?.kind === 'light' || drag?.kind === 'radius') && drag.moved) { const { scene } = hooks.state(); const lights = drag.lights; scene.lights = drag.orig; edit({ lights }); }
    if (drag?.kind === 'pan' && drag.right && !drag.moved) draft = null; // right-click ends a wall chain / cancels a curve
    drag = null; redraw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && placing) { const pl = placing; placing = null; canvas.style.cursor = ''; pl.cancel?.(); redraw(); }
    if (e.key === 'Escape' && draft) { draft = null; redraw(); }
  });
  canvas.addEventListener('dblclick', (e) => { if (draft?.revpoly) return closePoly(); if (hooks.state().tool.name !== 'select') return; const p = pos(e), t = hitToken(p.x, p.y); if (t) hooks.onOpen(t); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pos(e), before = toWorld(p.x, p.y);
    cam.z = Math.min(4, Math.max(0.08, cam.z * Math.exp(-e.deltaY * 0.0015)));
    cam.x = before.x - p.x / cam.z; cam.y = before.y - p.y / cam.z; redraw();
  }, { passive: false });

  /** Let a token follow the pointer; done({ x, y }) on the click that puts it down, cancel() on Escape or a right click. */
  const place = (token, done, cancel) => { placing = { token, done, cancel }; redraw(); };
  return { redraw, fit, viewCenter, place, placing: () => !!placing, cancel: () => { draft = null; redraw(); } };
}
