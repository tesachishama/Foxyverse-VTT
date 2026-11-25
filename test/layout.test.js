// ROADMAP 2 §2: layout rules of the page (public/layout.js is pure).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabColumns, clampRect, readJSON, writeJSON, createBubbles } from '../public/layout.js';

test('2.2 tabs never scroll: the GM\'s 7 tabs on 2 lines of 4, a player\'s 4 tabs on one line', () => {
  assert.equal(tabColumns(7), 4); assert.equal(Math.ceil(7 / tabColumns(7)), 2);
  assert.equal(tabColumns(4), 4); assert.equal(Math.ceil(4 / tabColumns(4)), 1);
  assert.equal(tabColumns(1), 1); assert.equal(tabColumns(0), 1);
});

test('2.3 folded chat: each bubble has its own 5 s timer; a newer bubble outlives an older one', () => {
  let now = 0; const timers = [];
  const setTimer = (fn, ms) => { const tm = { at: now + ms, fn, live: true }; timers.push(tm); return tm; };
  const clearTimer = (tm) => { if (tm) tm.live = false; };
  const advance = (ms) => { now += ms; for (const tm of timers) if (tm.live && tm.at <= now) { tm.live = false; tm.fn(); } };
  const gone = [];
  const b = createBubbles({ onExpire: (id) => gone.push(id), setTimer, clearTimer });
  b.add(1); advance(2000); b.add(2);
  advance(2999); assert.deepEqual(gone, []);
  advance(1); assert.deepEqual(gone, [1]); assert.deepEqual(b.ids(), [2]); // the first goes at 5 s, the second stays
  advance(2000); assert.deepEqual(gone, [1, 2]);
  b.add(3); b.clear(); assert.deepEqual(gone, [1, 2, 3]); // opening the chat clears every bubble
});

test('2.5 floating windows stay reachable inside the window and keep a usable size', () => {
  assert.deepEqual(clampRect({ x: 100, y: 50, w: 400, h: 500 }, 1400, 900), { x: 100, y: 50, w: 400, h: 500 });
  assert.deepEqual(clampRect({ x: 5000, y: -40, w: 10, h: 99999 }, 1400, 900), { x: 1280, y: 0, w: 260, h: 884 });
  assert.deepEqual(clampRect(null, 1400, 900), { x: 0, y: 0, w: 380, h: 520 });
});

test('2.5 window positions are remembered in browser storage, and a broken storage never breaks the page', () => {
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(writeJSON(store, 'floatTabs', { sheets: { x: 1, y: 2, w: 300, h: 400, open: true } }), true);
  assert.deepEqual(readJSON(store, 'floatTabs', {}), { sheets: { x: 1, y: 2, w: 300, h: 400, open: true } });
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(readJSON(broken, 'floatTabs', {}), {}); assert.equal(writeJSON(broken, 'floatTabs', {}), false);
  assert.deepEqual(readJSON(null, 'x', 'fallback'), 'fallback');
  mem.set('bad', '{not json'); assert.deepEqual(readJSON(store, 'bad', {}), {});
});
