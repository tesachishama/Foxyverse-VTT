// Canvas battle map. World units are map pixels; the camera is {x, y} (world point at the top-left) plus zoom.
import { computeVision, inReveal, distToSeg } from './vision.js';

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
 *  state() -> { scene, tokens, selected:Set, tool:{name, radius, snap}, gm, playerView, viewers:[{x,y,vision}], lights:[{x,y,radius}] }
 *  (state also carries viewerIds:Set of token ids whose eyes are used)
 *  canMove(token), hpRatio(token) -> 0..1|null, onFog(totalDarkness:boolean)
 *  onSelect(Set), onMove(token, x, y, final), onOpen(token), onSceneEdit(patch)
 */
export function createMap(canvas, hooks) {
  const ctx = canvas.getContext('2d');
  const layer = () => { const c = document.createElement('canvas'); return [c, c.getContext('2d')]; };
  const [fogC, fogX] = layer(), [visC, visX] = layer(), [litC, litX] = layer();
  const cam = { x: 0, y: 0, z: 1 };
  let W = 0, H = 0, dpr = 1, drag = null, lastSend = 0, sceneId = null, fitted = false, draft = null, cursor = null;
  const pointers = new Map();
  let visCache = { scene: null, key: '', vis: null };

  const size = (s) => ({ w: s.width || 2000, h: s.height || 1400 });
  const toWorld = (px, py) => ({ x: px / cam.z + cam.x, y: py / cam.z + cam.y });
  const redraw = () => requestAnimationFrame(draw);

  function resize() {
    const r = canvas.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    for (const c of [fogC, visC, litC]) { c.width = canvas.width; c.height = canvas.height; }
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
  function snapPoint(scene, x, y, free, mode = 'grid') {
    if (free) return { x: Math.round(x), y: Math.round(y) };
    const near = 12 / cam.z; // magnetise to existing wall ends first, so corners close cleanly
    for (const w of scene.walls || []) for (const [px, py] of [[w[0], w[1]], [w[2], w[3]]]) if (Math.hypot(px - x, py - y) < near) return { x: px, y: py };
    if (mode === 'off') return { x: Math.round(x), y: Math.round(y) };
    const g = mode === 'half' ? scene.grid / 2 : scene.grid;
    return { x: Math.round((x - scene.ox) / g) * g + scene.ox, y: Math.round((y - scene.oy) / g) * g + scene.oy };
  }
  const bezier = (p0, c, p2, n) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n, u = 1 - t; return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y }; });
  const chain = (pts, closed = false) => { const out = []; for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if (Math.hypot(a.x - b.x, a.y - b.y) > 0.5) out.push([Math.round(a.x * 10) / 10, Math.round(a.y * 10) / 10, Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, 0, 0]); } return out; };
  const circlePts = (c, r, grid) => { const n = Math.max(12, Math.min(64, Math.round(r / (grid / 3)))); return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) })); };
  const curveSegs = (a, b, grid) => Math.max(8, Math.min(40, Math.round(Math.hypot(a.x - b.x, a.y - b.y) / (grid / 3))));

  // ---------------------------------------------------------------- vision & fog
  function vision(scene, st) {
    const key = JSON.stringify([scene.dark, scene._rev, scene.walls?.length, st.viewers.map((v) => [v.x, v.y, v.vision]), st.lights.map((l) => [l.x, l.y, l.radius])]);
    if (visCache.scene !== scene || visCache.key !== key) visCache = { scene, key, vis: computeVision(scene, st.viewers, st.lights) };
    return visCache.vis;
  }
  const poly = (c, pts) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); };
  const world = (c, fn) => { c.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * dpr * cam.z, -cam.y * dpr * cam.z); fn(c); c.setTransform(1, 0, 0, 1, 0, 0); };
  const clearL = (c, l) => { c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, l.width, l.height); };
  const discIn = (c, pts, x, y, r) => { c.save(); poly(c, pts); c.clip(); c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.restore(); };

  function drawFog(scene, vis, alpha) {
    clearL(visX, visC); clearL(litX, litC);
    world(visX, (c) => {
      c.fillStyle = '#fff';
      for (const s of vis.sight) { if (!vis.dark && s.r > 0) discIn(c, s.poly, s.x, s.y, s.r); else { poly(c, s.poly); c.fill(); } }
    });
    if (vis.dark) { // keep only the lit part of what the viewers can see
      world(litX, (c) => {
        c.fillStyle = '#fff';
        for (const l of vis.lit) discIn(c, l.poly, l.x, l.y, l.r);
        for (const s of vis.sight) if (s.r > 0) discIn(c, s.poly, s.x, s.y, s.r);
      });
      visX.globalCompositeOperation = 'destination-in'; visX.drawImage(litC, 0, 0); visX.globalCompositeOperation = 'source-over';
    }
    world(visX, (c) => { c.fillStyle = '#fff'; for (const r of scene.reveal || []) c.fillRect(r[0], r[1], r[2], r[3]); });
    clearL(fogX, fogC); fogX.fillStyle = '#000'; fogX.fillRect(0, 0, fogC.width, fogC.height);
    fogX.globalCompositeOperation = 'destination-out'; fogX.drawImage(visC, 0, 0); fogX.globalCompositeOperation = 'source-over';
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

    for (const t of tokens) {
      if (fogOn && !godView && !st.viewerIds.has(t.id) && !vis.canSee(t.x, t.y)) continue;
      drawToken(scene, t, selected.has(t.id));
    }
    ctx.restore();

    if (fogOn) drawFog(scene, vis, godView ? 0.5 : 1);
    if (st.gm) { ctx.save(); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y); drawGuides(scene, st); ctx.restore(); }
  }

  function drawToken(scene, t, selected) {
    const d = t.size * scene.grid * 0.92, r = d / 2;
    ctx.save(); ctx.globalAlpha = t.hidden ? 0.5 : 1;
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, Math.PI * 2); ctx.fillStyle = t.color; ctx.fill();
    const ti = image(t.image, redraw);
    if (ti) { ctx.save(); ctx.clip(); ctx.drawImage(ti, t.x - r, t.y - r, d, d); ctx.restore(); }
    else { ctx.fillStyle = '#2a0019'; ctx.font = `600 ${r}px Georgia, serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((t.name[0] || '?').toUpperCase(), t.x, t.y + r * 0.05); }
    ctx.lineWidth = (selected ? 4 : 2) / cam.z; ctx.strokeStyle = selected ? '#ff9a4d' : '#ffdbff';
    if (t.hidden) ctx.setLineDash([6 / cam.z, 4 / cam.z]);
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
    const z = 1 / cam.z, editing = st.tool.name !== 'select';
    for (const r of scene.reveal || []) { ctx.fillStyle = 'rgba(159,227,180,0.08)'; ctx.fillRect(r[0], r[1], r[2], r[3]); ctx.setLineDash([8 * z, 6 * z]); ctx.strokeStyle = 'rgba(159,227,180,0.6)'; ctx.lineWidth = z; ctx.strokeRect(r[0], r[1], r[2], r[3]); ctx.setLineDash([]); }
    for (const l of scene.lights || []) {
      ctx.fillStyle = '#ffd84d'; ctx.beginPath(); ctx.arc(l.x, l.y, 6 * z, 0, Math.PI * 2); ctx.fill();
      if (editing) { ctx.setLineDash([6 * z, 6 * z]); ctx.strokeStyle = 'rgba(255,216,77,0.6)'; ctx.lineWidth = z; ctx.beginPath(); ctx.arc(l.x, l.y, l.radius * scene.grid, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    }
    for (const w of scene.walls || []) {
      ctx.lineWidth = (w[4] ? 4 : 3) * z; ctx.lineCap = 'round';
      ctx.strokeStyle = w[4] ? (w[5] ? 'rgba(122,215,255,0.45)' : '#7ad7ff') : '#ff9a4d';
      if (w[4] && w[5]) ctx.setLineDash([5 * z, 7 * z]);
      ctx.beginPath(); ctx.moveTo(w[0], w[1]); ctx.lineTo(w[2], w[3]); ctx.stroke(); ctx.setLineDash([]);
      if (editing) { ctx.fillStyle = '#ffdbff'; for (const [px, py] of [[w[0], w[1]], [w[2], w[3]]]) { ctx.beginPath(); ctx.arc(px, py, 3 * z, 0, Math.PI * 2); ctx.fill(); } }
    }
    if (draft?.pts?.length && cursor) { // wall in progress
      const last = draft.pts[draft.pts.length - 1];
      ctx.strokeStyle = draft.door ? '#7ad7ff' : '#ff9a4d'; ctx.lineWidth = 3 * z; ctx.setLineDash([6 * z, 4 * z]);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(cursor.x, cursor.y); ctx.stroke(); ctx.setLineDash([]);
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

  function useTool(st, e, p) {
    const { scene, tool } = st, w = toWorld(p.x, p.y), free = e.shiftKey || e.altKey, near = 12 / cam.z, snap = (x, y) => snapPoint(scene, x, y, free, tool.snap);
    if (tool.name === 'wall' || tool.name === 'door') {
      const door = tool.name === 'door';
      if (door && !draft) { // clicking an existing door toggles it open/closed
        const i = (scene.walls || []).findIndex((s) => s[4] && distToSeg(w.x, w.y, s) < near);
        if (i >= 0) { const walls = scene.walls.map((s) => s.slice()); walls[i][5] = walls[i][5] ? 0 : 1; return edit({ walls }); }
      }
      const pt = snap(w.x, w.y);
      if (!draft) { draft = { pts: [pt], door }; return redraw(); }
      const last = draft.pts[draft.pts.length - 1];
      if (last.x !== pt.x || last.y !== pt.y) edit({ walls: [...(scene.walls || []), [last.x, last.y, pt.x, pt.y, door ? 1 : 0, 0]] });
      draft = door ? null : { pts: [pt], door }; // doors are single segments, walls chain on
      return redraw();
    }
    if (tool.name === 'curve') { // start, end, then bend: three clicks
      const pt = snap(w.x, w.y);
      if (!draft?.curve) { draft = { curve: { pts: [pt] } }; return redraw(); }
      const c = draft.curve; c.pts.push(pt);
      if (c.pts.length < 3) return redraw();
      const [a, b, ctrl] = c.pts;
      draft = null;
      return edit({ walls: [...(scene.walls || []), ...chain(bezier(a, ctrl, b, curveSegs(a, b, scene.grid)))] });
    }
    if (tool.name === 'edit') { // grab a wall end (every wall end at that spot moves together)
      let best = null;
      for (const [i, wl] of (scene.walls || []).entries()) for (const k of [0, 2]) { const d = Math.hypot(wl[k] - w.x, wl[k + 1] - w.y); if (d < near && (!best || d < best.d)) best = { d, x: wl[k], y: wl[k + 1] }; }
      if (!best) return;
      const walls = scene.walls.map((s) => s.slice());
      drag = { kind: 'vertex', from: { x: best.x, y: best.y }, walls, orig: scene.walls, free };
      scene.walls = walls; return;
    }
    if (tool.name === 'light') return edit({ lights: [...(scene.lights || []), { id: '', x: Math.round(w.x), y: Math.round(w.y), radius: tool.radius }] });
    if (tool.name === 'erase') {
      const wi = (scene.walls || []).findIndex((s) => distToSeg(w.x, w.y, s) < near);
      if (wi >= 0) return edit({ walls: scene.walls.filter((_, i) => i !== wi) });
      const li = (scene.lights || []).findIndex((l) => Math.hypot(l.x - w.x, l.y - w.y) < near * 1.5);
      if (li >= 0) return edit({ lights: scene.lights.filter((_, i) => i !== li) });
      const ri = (scene.reveal || []).findIndex((r) => inReveal({ reveal: [r] }, w.x, w.y));
      if (ri >= 0) return edit({ reveal: scene.reveal.filter((_, i) => i !== ri) });
    }
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
    if (e.button === 1 || e.button === 2) { drag = { kind: 'pan', sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false, right: e.button === 2 }; return; }
    if (tool !== 'select' && st.gm && st.scene) {
      if (tool === 'reveal') { const w = toWorld(p.x, p.y); drag = { kind: 'rect', x: w.x, y: w.y }; draft = { pts: [], rect: { x: w.x, y: w.y, w: 0, h: 0 } }; return; }
      if (tool === 'rect' || tool === 'circle') {
        const w = toWorld(p.x, p.y), pt = snapPoint(st.scene, w.x, w.y, e.shiftKey || e.altKey, st.tool.snap);
        drag = { kind: 'shape', type: tool, x: pt.x, y: pt.y }; draft = { pts: [], shape: { type: tool, x: pt.x, y: pt.y, x2: pt.x, y2: pt.y } }; return;
      }
      return useTool(st, e, p);
    }
    const t = hitToken(p.x, p.y), { selected } = st;
    if (t) {
      const next = new Set(e.shiftKey ? selected : []);
      if (e.shiftKey && selected.has(t.id)) next.delete(t.id); else next.add(t.id);
      hooks.onSelect(next);
      if (hooks.canMove(t) && !e.shiftKey) { const w = toWorld(p.x, p.y); drag = { kind: 'token', t, dx: t.x - w.x, dy: t.y - w.y }; }
    } else {
      if (!e.shiftKey) hooks.onSelect(new Set());
      drag = { kind: 'pan', sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false };
    }
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    const st = hooks.state();
    if (st.scene && st.tool.name !== 'select') { const w = toWorld(p.x, p.y); cursor = snapPoint(st.scene, w.x, w.y, e.shiftKey || e.altKey, st.tool.snap); if (draft) redraw(); }
    if (!drag) { canvas.style.cursor = st.tool.name !== 'select' && st.gm ? 'crosshair' : hitToken(p.x, p.y) ? 'pointer' : 'grab'; return; }
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
    } else if (drag.kind === 'vertex') {
      const sc = hooks.state().scene, to = cursor;
      for (const wl of drag.walls) for (const k of [0, 2]) if (Math.abs(wl[k] - drag.from.x) < 0.01 && Math.abs(wl[k + 1] - drag.from.y) < 0.01) { wl[k] = to.x; wl[k + 1] = to.y; }
      drag.from = { x: to.x, y: to.y }; sc._rev = (sc._rev || 0) + 1;
    } else if (drag.kind === 'rect') {
      const w = toWorld(p.x, p.y); draft.rect = { x: Math.min(drag.x, w.x), y: Math.min(drag.y, w.y), w: Math.abs(w.x - drag.x), h: Math.abs(w.y - drag.y) };
    } else if (drag.kind === 'token') {
      const w = toWorld(p.x, p.y); drag.t.x = w.x + drag.dx; drag.t.y = w.y + drag.dy;
      if (performance.now() - lastSend > 90) { lastSend = performance.now(); hooks.onMove(drag.t, drag.t.x, drag.t.y, false); }
    }
    redraw();
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (drag?.kind === 'pinch') { if (pointers.size < 2) drag = null; return; }
    if (drag?.kind === 'token') {
      const { scene } = hooks.state(), t = drag.t, s = scene ? snapToken(scene, t, t.x, t.y) : t;
      t.x = s.x; t.y = s.y; hooks.onMove(t, s.x, s.y, true);
    }
    if (drag?.kind === 'rect') {
      const r = draft?.rect, { scene } = hooks.state();
      draft = null;
      if (r && r.w > 8 && r.h > 8) edit({ reveal: [...(scene.reveal || []), [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]] });
    }
    if (drag?.kind === 'shape') {
      const sh = draft?.shape, { scene } = hooks.state(); draft = null;
      if (sh) {
        const dx = Math.abs(sh.x2 - sh.x), dy = Math.abs(sh.y2 - sh.y);
        if (sh.type === 'rect' && dx > 8 && dy > 8) edit({ walls: [...(scene.walls || []), ...chain([{ x: sh.x, y: sh.y }, { x: sh.x2, y: sh.y }, { x: sh.x2, y: sh.y2 }, { x: sh.x, y: sh.y2 }], true)] });
        const r = Math.hypot(dx, dy);
        if (sh.type === 'circle' && r > 12) edit({ walls: [...(scene.walls || []), ...chain(circlePts({ x: sh.x, y: sh.y }, r, scene.grid), true)] });
      }
    }
    if (drag?.kind === 'vertex') { const { scene } = hooks.state(); scene.walls = drag.orig; edit({ walls: drag.walls }); }
    if (drag?.kind === 'pan' && drag.right && !drag.moved) draft = null; // right-click ends a wall chain / cancels a curve
    drag = null; redraw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && draft) { draft = null; redraw(); } });
  canvas.addEventListener('dblclick', (e) => { if (hooks.state().tool.name !== 'select') return; const p = pos(e), t = hitToken(p.x, p.y); if (t) hooks.onOpen(t); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pos(e), before = toWorld(p.x, p.y);
    cam.z = Math.min(4, Math.max(0.08, cam.z * Math.exp(-e.deltaY * 0.0015)));
    cam.x = before.x - p.x / cam.z; cam.y = before.y - p.y / cam.z; redraw();
  }, { passive: false });

  return { redraw, fit, viewCenter, cancel: () => { draft = null; redraw(); } };
}
