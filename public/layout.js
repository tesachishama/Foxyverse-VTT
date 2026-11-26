// Layout rules of the page: tab rows, floating windows, chat bubbles. Pure (no DOM): the page and the tests share it.

/** Tabs never scroll: up to 5 fit on one line, more go on two lines (the GM's 7 tabs: 4 + 3). Returns the number of columns. */
export const tabColumns = (count) => (count > 5 ? Math.ceil(count / 2) : Math.max(1, count));

/** A floating window's rectangle kept usable inside the viewport: at least its title bar stays reachable. */
export function clampRect(r, vw, vh, min = { w: 260, h: 180 }) {
  const w = Math.max(min.w, Math.min(Number(r?.w) || 380, vw - 16));
  const h = Math.max(min.h, Math.min(Number(r?.h) || 520, vh - 16));
  const x = Math.min(Math.max(0, Number(r?.x) || 0), Math.max(0, vw - 120));
  const y = Math.min(Math.max(0, Number(r?.y) || 0), Math.max(0, vh - 40));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * A floating window folded to its title bar (double click on the title, ROADMAP 3 §1.8) and back. Its saved size is kept as it
 * was, so it unfolds to the same size. Returns the new saved entry.
 */
export const toggleFold = (saved) => ({ ...(saved ?? {}), folded: !saved?.folded });
/** Floating windows are tabs ("sheets", "journal"...) or single sheets ("sheet:<id>", ROADMAP 3 §2.7, several at once). */
export const sheetFloatId = (actorId) => `sheet:${actorId}`;
export function floatTarget(id) {
  const m = /^sheet:(\d+)$/.exec(String(id));
  return m ? { kind: 'sheet', actorId: Number(m[1]) } : { kind: 'tab', tab: String(id) };
}
/** The size to remember after a resize: none while folded (the window is only its title bar then). */
export const sizeToSave = (folded, w, h) => (folded ? null : { w, h });

/** Browser storage can be missing or throw (private window, blocked site data): reads fall back, writes are best effort. */
export function readJSON(storage, key, fallback) {
  try { const v = storage?.getItem(key); return v == null ? fallback : JSON.parse(v) ?? fallback; } catch { return fallback; }
}
export function writeJSON(storage, key, value) {
  try { storage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/**
 * Chat bubbles while the chat is folded: each bubble has its own timer (5 s by default), so several bubbles never vanish together
 * on the first one's timer. onExpire(id) removes it from the page. Timers are injectable for the tests.
 */
export function createBubbles({ life = 5000, onExpire, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map();
  return {
    add(id) { clearTimer(timers.get(id)); timers.set(id, setTimer(() => { timers.delete(id); onExpire(id); }, life)); },
    remove(id) { clearTimer(timers.get(id)); timers.delete(id); },
    clear() { for (const id of [...timers.keys()]) { clearTimer(timers.get(id)); timers.delete(id); onExpire(id); } },
    ids: () => [...timers.keys()],
  };
}

/**
 * Keyboard moves for the selected tokens: arrows, and the WASD keys by their place on the keyboard (event.code), so the same keys
 * work as ZQSD on a French AZERTY keyboard without detecting anything. Returns { dx, dy } in cells, or null.
 */
const STEPS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
export function keyStep(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null; // shortcuts (Ctrl+Z, Ctrl+S...) are not moves
  const s = STEPS[e.code] ?? STEPS[e.key];
  return s ? { dx: s[0], dy: s[1] } : null;
}
/** Map shortcuts (ROADMAP 3 §1.5): "delete" (Delete, or Backspace for keyboards without Delete), "undo" (Ctrl/Cmd+Z), or null. */
export function mapShortcut(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) return 'undo';
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) return 'delete';
  return null;
}
/** Keys go to the map only when nobody is typing (fields, the chat) and no dialog is open. */
export const typingTarget = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable === true);
