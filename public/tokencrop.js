// Round framed token from a portrait: the user drags and zooms the picture inside the circle, we export a PNG.
// The frame imitates the Foxyverse tokens (design-reference/tokens): a plum ring with a light rim.
import { h, t } from './lib.js';

const EDIT = 320; // editor canvas size (css px); the output is drawn at any size from the same view
const OUT = 512;

/** Draw the token: picture clipped to the inner circle, then the ring. view = { x, y, s } in editor pixels. */
export function drawToken(ctx, img, size, view) {
  const r = size / 2, ring = size * 0.065, k = size / EDIT;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath(); ctx.arc(r, r, r - ring * 0.6, 0, Math.PI * 2); ctx.clip();
  const bg = ctx.createRadialGradient(r, r * 0.8, r * 0.1, r, r, r); bg.addColorStop(0, '#6a3466'); bg.addColorStop(1, '#2b0a24');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
  if (img) ctx.drawImage(img, view.x * k, view.y * k, img.naturalWidth * view.s * k, img.naturalHeight * view.s * k);
  ctx.restore();
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#e6b8ea'); g.addColorStop(0.45, '#8c4a86'); g.addColorStop(1, '#3d1238');
  ctx.lineWidth = ring; ctx.strokeStyle = g;
  ctx.beginPath(); ctx.arc(r, r, r - ring / 2, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = Math.max(1, size * 0.008); ctx.strokeStyle = 'rgba(255, 219, 255, .6)'; // light inner rim
  ctx.beginPath(); ctx.arc(r, r, r - ring, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(30, 0, 20, .7)';
  ctx.beginPath(); ctx.arc(r, r, r - ctx.lineWidth / 2, 0, Math.PI * 2); ctx.stroke();
}

const loadImage = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('image')); i.src = src; });

/** Open the editor on an image URL. Resolves with a PNG Blob, or null if cancelled. */
export async function openTokenCropper(src) {
  const img = await loadImage(src);
  const w = img.naturalWidth, hgt = img.naturalHeight;
  const fit = EDIT / Math.min(w, hgt); // smallest zoom that still covers the circle
  // start centred, a little towards the top (faces are usually there)
  const view = { s: fit, x: (EDIT - w * fit) / 2, y: Math.min(0, -(hgt * fit - EDIT) * 0.15) };
  const canvas = h('canvas', { class: 'crop-canvas', width: EDIT * devicePixelRatio, height: EDIT * devicePixelRatio, style: `width:${EDIT}px;height:${EDIT}px` });
  const ctx = canvas.getContext('2d');
  const draw = () => { ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); drawToken(ctx, img, EDIT, view); };
  const clamp = () => { // never leave an empty corner inside the circle
    view.s = Math.max(fit, Math.min(fit * 8, view.s));
    view.x = Math.min(0, Math.max(EDIT - w * view.s, view.x)); view.y = Math.min(0, Math.max(EDIT - hgt * view.s, view.y));
  };
  const zoomAt = (s, cx = EDIT / 2, cy = EDIT / 2) => { const k = s / view.s; view.x = cx - (cx - view.x) * k; view.y = cy - (cy - view.y) * k; view.s = s; clamp(); draw(); slider.value = view.s / fit; };
  const slider = h('input', { type: 'range', min: 1, max: 8, step: 0.01, value: 1, oninput: (e) => zoomAt(fit * Number(e.target.value)) });
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; view.x = drag.vx + e.clientX - drag.x; view.y = drag.vy + e.clientY - drag.y; clamp(); draw(); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const b = canvas.getBoundingClientRect(); zoomAt(view.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - b.left, e.clientY - b.top); }, { passive: false });
  clamp(); draw();
  return new Promise((resolve) => {
    const close = (v) => { modal.remove(); resolve(v); };
    const done = () => {
      const out = h('canvas', { width: OUT, height: OUT });
      drawToken(out.getContext('2d'), img, OUT, view);
      out.toBlob((b) => close(b ? new File([b], 'token.png', { type: 'image/png' }) : null), 'image/png');
    };
    const modal = h('div', { class: 'modal', onclick: (e) => { if (e.target === e.currentTarget) close(null); } },
      h('div', { class: 'modal-card crop' }, h('h3', {}, t('cropToken')), h('p', { class: 'hint' }, t('cropHint')), canvas,
        h('label', { class: 'line' }, t('zoom'), slider),
        h('div', { class: 'line' }, h('button', { class: 'primary', onclick: done }, t('save')), h('button', { onclick: () => close(null) }, t('cancel')))));
    document.body.append(modal);
  });
}
