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
