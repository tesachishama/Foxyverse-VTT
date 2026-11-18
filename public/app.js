import { h, $, $$, api, request, setApiBase, eventsUrl, CLIENT_ID, upload, toast, debounce, t, setLang, getLang, inline, markdown, setKnownRollTypes } from './lib.js';
import { createMap } from './map.js';
import { createAudio } from './audio.js';
import { inventoryView, icon } from './inventory.js';
import { openTokenCropper } from './tokencrop.js';

const S = {
  me: null, users: [], system: null, scene: null, scenes: [], tokens: [], actors: [], chat: [], table: null, allTables: [], mapMode: false,
  tab: 'sheets', sheetId: null, selected: new Set(), rollMod: '', draft: null,
  sounds: [], playing: [], journals: [], compendium: [], npcs: [], compView: 'table', compGlobal: null, compFilter: { tables: null, campaigns: null }, campaigns: [], savedSystems: [], timeOffset: 0, viewId: null, tool: { name: 'select', radius: 6, snap: 'grid' }, playerView: false, viewAs: 'players', undo: [],
  journalId: null, journalEdit: false, modal: null, audioBlocked: false, openItems: new Set(),
  actorId: Number(localStorage.getItem('speakAs')) || null,
};
const app = document.getElementById('app');
const isGM = () => S.me?.role === 'gm';
const actorById = (id) => S.actors.find((a) => a.id === id);
const userById = (id) => S.users.find((u) => u.id === id);
// Native append/replaceChildren print false/null/undefined as text, so every dynamic child list goes through these.
const clean = (kids) => kids.flat(9).filter((k) => k != null && k !== false);
const fill = (el, ...kids) => { el.replaceChildren(...clean(kids)); return el; };
const add = (el, ...kids) => { el.append(...clean(kids)); return el; };
const upsert = (list, item) => { const i = list.findIndex((x) => x.id === item.id); if (i >= 0) list[i] = item; else list.push(item); };
const remove = (list, id) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); };
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
let map, dockEl, panelEl, chatEl, chatPane, chatList, chatInput, chatWho, inspectorEl, hudEl, topEl, footEl, fogNote, audio, editQueue = Promise.resolve();

// ------------------------------------------------------------------ boot & pages
// URLs: "/" tables, "/<table>" pick a player then play, "/admin" GM home, "/admin/<table>" GM at a table, "/admin?map=<id>" map library editor.
const ROUTE = (() => {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  const g = /^\/admin(?:\/([a-z0-9-]+))?$/.exec(p);
  if (g) return { gm: true, slug: g[1] ?? null, map: g[1] ? null : Number(new URLSearchParams(location.search).get('map')) || null };
  const m = /^\/([a-z0-9-]+)$/.exec(p);
  return { gm: false, slug: m?.[1] ?? null, map: null };
})();
const slugify = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const langBtn = () => h('button', { class: 'quiet', title: 'FR / EN', onclick: () => { setLang(getLang() === 'fr' ? 'en' : 'fr'); location.reload(); } }, getLang().toUpperCase());
const copyText = guard(async (text) => { await navigator.clipboard.writeText(text); toast(t('copied'), false); });
const page = (...kids) => fill(app, h('main', { class: 'home' }, h('div', { class: 'line' }, h('h1', { class: 'grow' }, 'Foxyverse VTT'), langBtn()), ...kids));

async function boot() {
  if (ROUTE.gm && ROUTE.map) return mapEditor(ROUTE.map);
  if (ROUTE.gm && !ROUTE.slug) return adminHome();
  if (!ROUTE.slug) return playerHome();
  setApiBase(ROUTE.gm ? `/admin/api/t/${ROUTE.slug}` : `/api/t/${ROUTE.slug}`);
  try { await loadState(); } catch (e) {
    if (!ROUTE.gm && e.status === 401) return lobbyPage(ROUTE.slug);
    if (e.status === 404) return page(h('p', { class: 'hint' }, t('tableNotFound')), h('a', { href: ROUTE.gm ? '/admin' : '/' }, ROUTE.gm ? t('gmHome') : t('allTables')));
    throw e;
  }
  if (ROUTE.gm) { await loadGmLists(); S.table.campaignId = S.allTables.find((x) => x.slug === S.table.slug)?.campaignId ?? null; }
  document.title = `${S.table.name} · Foxyverse VTT`;
  buildShell();
  connect();
}

async function loadGmLists() {
  const [{ tables }, { campaigns }, { systems }] = await Promise.all([request('GET', '/admin/api/tables'), request('GET', '/admin/api/campaigns'), request('GET', '/admin/api/systems')]);
  Object.assign(S, { allTables: tables, campaigns, savedSystems: systems });
}

/** "/": the listed tables. */
async function playerHome() {
  const { tables } = await request('GET', '/api/tables');
  page(h('h2', {}, t('chooseTable')),
    tables.length ? h('ul', { class: 'list' }, tables.map((x) => h('li', { class: 'card' }, h('a', { class: 'row', href: '/' + x.slug }, h('b', {}, x.name)))))
      : h('p', { class: 'hint' }, t('noTables')));
}

/** "/<table>" before playing: pick one of the player slots the GM created. Taken slots are greyed out; refreshed every few seconds. */
async function lobbyPage(slug) {
  let timer = null;
  const draw = async () => {
    let lb;
    try { lb = await request('GET', `/api/t/${slug}/lobby`); } catch (e) {
      clearInterval(timer);
      return page(h('p', { class: 'hint' }, e.status === 404 ? t('tableNotFound') : e.message), h('a', { href: '/' }, t('allTables')));
    }
    document.title = `${lb.table.name} · Foxyverse VTT`;
    const pick = guard(async (sl) => { await request('POST', `/api/t/${slug}/join`, { slotId: sl.id }); clearInterval(timer); await boot(); });
    page(h('h2', {}, lb.table.name, ' · ', t('pickPlayer')),
      !lb.slots.length && h('p', { class: 'hint' }, t('noSlots')),
      h('div', { class: 'slots' }, lb.slots.map((sl) => {
        const mine = sl.id === lb.me, busy = sl.online && !mine;
        return h('button', { class: 'slot' + (mine ? ' on' : ''), disabled: busy, onclick: () => pick(sl) },
          h('span', { class: 'dot', style: `background:${sl.color}` }), h('b', {}, sl.name),
          busy && h('span', { class: 'dim' }, t('taken')), mine && h('span', { class: 'dim' }, t('you')));
      })),
      h('a', { class: 'dim', href: '/' }, '← ' + t('allTables')));
  };
  await draw();
  timer = setInterval(draw, 5000);
}

/** "/admin": every table, a new table, and the map library. */
async function adminHome() {
  document.title = `${t('gmHome')} · Foxyverse VTT`;
  const [{ tables, devMode }, { scenes }, { campaigns }, { systems }] = await Promise.all([request('GET', '/admin/api/tables'), request('GET', '/admin/api/library'), request('GET', '/admin/api/campaigns'), request('GET', '/admin/api/systems')]);
  const reload = () => adminHome().catch((e) => toast(e.message));
  const name = h('input', { type: 'text', placeholder: t('tableName'), maxlength: 60 });
  const slug = h('input', { type: 'text', class: 'code', placeholder: t('tableAddress'), maxlength: 40 });
  let slugTouched = false;
  name.addEventListener('input', () => { if (!slugTouched) slug.value = slugify(name.value); });
  slug.addEventListener('input', () => { slugTouched = true; });
  const listed = h('input', { type: 'checkbox', checked: true });
  const campSel = (value, onchange, attrs = {}) => { const sel = h('select', { ...attrs, onchange }, h('option', { value: '' }, t('noCampaign')), campaigns.map((c) => h('option', { value: c.id }, c.name))); sel.value = value ?? ''; return sel; };
  const sysSel = (value, onchange) => { const sel = h('select', { title: t('linkedSystem'), onchange }, h('option', { value: '' }, t('noLinkedSystem')), systems.map((x) => h('option', { value: x.id }, x.name))); sel.value = value ?? ''; return sel; };
  const newCamp = campSel(null, null, { title: t('campaign') });
  const create = guard(async () => { const r = await request('POST', '/admin/api/tables', { name: name.value, slug: slug.value || slugify(name.value), listed: listed.checked, campaignId: newCamp.value ? Number(newCamp.value) : null }); location.assign('/admin/' + r.slug); });
  const campName = h('input', { type: 'text', placeholder: t('newCampaign'), maxlength: 60 });
  const addCamp = guard(async () => { if (!campName.value.trim()) return; await request('POST', '/admin/api/campaigns', { name: campName.value }); reload(); });
  const mapName = h('input', { type: 'text', placeholder: t('mapName'), maxlength: 80 });
  const mapFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  const newMap = guard(async () => {
    setApiBase('/admin/api/library', '/admin/api/upload');
    const r = await api('POST', '/scenes', await newSceneBody(mapName.value || t('newMap'), mapFile.files[0]));
    location.assign('/admin?map=' + r.id);
  });
  const copySel = (m) => tables.length > 0 && h('select', { onchange: guard(async (e) => {
    if (!e.target.value) return;
    await request('POST', `/admin/api/scenes/${m.id}/copy`, { table: e.target.value });
    toast(`${t('copiedTo')} ${e.target.selectedOptions[0].textContent}`, false); e.target.value = '';
  }) }, h('option', { value: '' }, t('copyTo')), tables.map((x) => h('option', { value: x.slug }, x.name)));
  fill(app, h('main', { class: 'home wide' },
    h('div', { class: 'line' }, h('h1', { class: 'grow' }, 'Foxyverse VTT · ', t('gmHome')), langBtn()),
    devMode && h('p', { class: 'warn' }, t('devMode')),
    h('section', { class: 'sec' }, h('h3', {}, t('tables')),
      !tables.length && h('p', { class: 'hint' }, t('empty')),
      h('ul', { class: 'list' }, tables.map((x) => h('li', { class: 'line card' },
        h('a', { class: 'grow', href: '/admin/' + x.slug }, h('b', {}, x.name),
          h('span', { class: 'dim' }, ` /${x.slug} · ${x.players} ${t('playersShort')}, ${x.online} ${t('online')}${x.campaignId ? ' · ' + (campaigns.find((c) => c.id === x.campaignId)?.name ?? '') : ''}`)),
        h('label', { class: 'check', title: t('listed') }, h('input', { type: 'checkbox', checked: x.listed, onchange: guard(async (e) => { await request('PATCH', `/admin/api/tables/${x.slug}`, { listed: e.target.checked }); reload(); }) }), t('listedShort')),
        h('button', { title: t('playerLink'), onclick: () => copyText(`${location.origin}/${x.slug}`) }, t('copyLink')),
        h('a', { class: 'button primary', href: '/admin/' + x.slug }, t('openTable')),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => {
          if (prompt(`${t('confirmTable')} ${x.slug}`) !== x.slug) return;
          await request('DELETE', `/admin/api/tables/${x.slug}`); reload();
        }) }, '×')))),
      h('div', { class: 'line' }, name, slug, newCamp, h('label', { class: 'check' }, listed, t('listed')), h('button', { class: 'primary', onclick: create }, '+ ' + t('newTable')))),
    h('section', { class: 'sec' }, h('h3', {}, t('campaigns')), h('p', { class: 'hint' }, t('campaignHint')),
      h('ul', { class: 'list' }, campaigns.map((c) => h('li', { class: 'line card' },
        h('input', { type: 'text', class: 'grow', value: c.name, maxlength: 60, onchange: guard(async (e) => { await request('PATCH', `/admin/api/campaigns/${c.id}`, { name: e.target.value }); }) }),
        sysSel(c.systemId, guard(async (e) => { await request('PATCH', `/admin/api/campaigns/${c.id}`, { systemId: e.target.value ? Number(e.target.value) : null }); })),
        h('span', { class: 'dim' }, `${tables.filter((x) => x.campaignId === c.id).length} ${t('tables').toLowerCase()}`),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await request('DELETE', `/admin/api/campaigns/${c.id}`); reload(); }) }, '×')))),
      h('div', { class: 'line' }, campName, h('button', { class: 'primary', onclick: addCamp }, '+ ' + t('newCampaign')))),
    h('section', { class: 'sec' }, h('h3', {}, t('systemsLib')), h('p', { class: 'hint' }, t('systemsHint')),
      !systems.length && h('p', { class: 'hint' }, t('empty')),
      h('ul', { class: 'list' }, systems.map((x) => h('li', { class: 'line card' },
        h('input', { type: 'text', class: 'grow', value: x.name, maxlength: 60, onchange: guard(async (e) => { await request('PATCH', `/admin/api/systems/${x.id}`, { name: e.target.value }); }) }),
        h('span', { class: 'dim' }, new Date(x.updated).toLocaleDateString()),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await request('DELETE', `/admin/api/systems/${x.id}`); reload(); }) }, '×'))))),
    h('section', { class: 'sec' }, h('h3', {}, t('mapLibrary')), h('p', { class: 'hint' }, t('mapHint')),
      h('ul', { class: 'list' }, scenes.map((m) => h('li', { class: 'line card' },
        h('a', { class: 'grow', href: '/admin?map=' + m.id }, h('b', {}, m.name), m.width > 0 && h('span', { class: 'dim' }, ` ${m.width}×${m.height}`)),
        copySel(m),
        h('a', { class: 'button', href: '/admin?map=' + m.id }, t('editMap')),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await request('DELETE', `/admin/api/library/scenes/${m.id}`); reload(); }) }, '×')))),
      h('div', { class: 'line' }, mapName, mapFile, h('button', { class: 'primary', onclick: newMap }, '+ ' + t('newMap'))))));
}

/** "/admin?map=<id>": the map editor of the library (walls, lights...), without the game tools. */
async function mapEditor(id) {
  setApiBase('/admin/api/library', '/admin/api/upload');
  const [{ scenes }, { tables }] = await Promise.all([request('GET', '/admin/api/library'), request('GET', '/admin/api/tables')]);
  Object.assign(S, { mapMode: true, tab: 'map', me: { id: 0, name: 'MJ', role: 'gm' }, scenes, scene: null, tokens: [], actors: [], chat: [], users: [],
    sounds: [], playing: [], journals: [], compendium: [], allTables: tables });
  S.viewId = scenes.some((x) => x.id === id) ? id : scenes[0]?.id ?? null;
  document.title = `${t('mapLibrary')} · Foxyverse VTT`;
  buildShell();
}

async function loadState() {
  const st = await api('GET', '/state');
  Object.assign(S, { me: st.me, table: st.table, users: st.users, system: st.system, scene: st.scene, scenes: st.scenes, tokens: st.tokens, actors: st.actors, chat: st.chat,
    sounds: st.sounds, playing: st.playing, journals: st.journals, compendium: st.compendium, npcs: st.npcs ?? [], timeOffset: st.serverTime - Date.now() });
  if (st.me.role === 'gm' && !S.scenes.some((x) => x.id === S.viewId)) S.viewId = st.scene?.id ?? S.scenes[0]?.id ?? null;
  if (audio) { audio.stopAll(); audio.sync(S.playing, S.sounds); }
  setKnownRollTypes(S.system);
  const mine = S.actors.filter((a) => a.perm === 'edit'); // the characters this page can speak and roll as
  if (S.actorId && !mine.some((a) => a.id === S.actorId)) S.actorId = null;
  if (!S.actorId && mine.length === 1) S.actorId = mine[0].id;
  if (S.sheetId && !actorById(S.sheetId)) S.sheetId = null;
}

// ------------------------------------------------------------------ realtime
let opened = false, es = null;
function connect() {
  es = new EventSource(eventsUrl());
  es.onopen = () => { if (opened) loadState().then(renderAll).catch(() => {}); opened = true; };
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  // The browser does not retry a refused stream (slot taken over, table deleted): find out why, or start again.
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) loadState().then(() => { renderAll(); setTimeout(connect, 2000); }).catch(() => location.reload()); };
}
const pending = new Set(); // actor ids with unsaved local edits
function onEvent(ev) {
  const { type, op, data, by } = ev;
  if (type === 'kicked' || type === 'gone') { // the GM freed our slot, or deleted the table
    es?.close(); toast(t(type === 'gone' ? 'tableGone' : 'kicked'));
    return setTimeout(() => (type === 'gone' ? location.assign(isGM() ? '/admin' : '/') : location.reload()), 1800);
  }
  if (type === 'left') { es?.close(); return location.reload(); } // "switch player" in another tab of this browser
  if (type === 'table') { // renamed, or moved to a new address
    if (data.slug !== S.table.slug) return location.assign((isGM() ? '/admin/' : '/') + data.slug);
    S.table = data; document.title = `${S.table.name} · Foxyverse VTT`; if (S.tab === 'table') renderPanel(); return;
  }
  if (type === 'refresh') return loadState().then(renderAll);
  if (type === 'user') { upsert(S.users, data); if (S.tab === 'table') renderPanel(); return; }
  if (type === 'scene') {
    if (editsPending) return; // our own queued edits are newer than this echo
    replaceScene(data); if (S.tab === 'table') renderPanel(); return;
  }
  if (type === 'token') {
    if (by === CLIENT_ID) return; // this page is the source; its local copy is authoritative
    if (op === 'delete') remove(S.tokens, data.id); else upsert(S.tokens, data);
    map.redraw(); renderInspector(); return;
  }
  if (type === 'sound') {
    if (op === 'delete') remove(S.sounds, data.id); else { upsert(S.sounds, data); audio.update(data); }
    if (S.tab === 'sound') renderPanel(); return;
  }
  if (type === 'audio') {
    audio.apply(ev, S.sounds);
    if (op === 'play') { remove(S.playing, ev.id); S.playing.push({ id: ev.id, startedAt: ev.startedAt }); } else if (op === 'stop') remove(S.playing, ev.id); else S.playing = [];
    if (S.tab === 'sound') renderPanel(); return;
  }
  if (type === 'journal') {
    if (op === 'delete') { remove(S.journals, data.id); if (S.journalId === data.id) S.journalId = null; } else upsert(S.journals, data);
    if (S.tab === 'journal' && !S.journalEdit) renderPanel(); return;
  }
  if (type === 'show') { S.modal = ev.id; renderModal(); return; }
  if (type === 'comp') {
    if (op === 'delete') remove(S.compendium, data.id); else upsert(S.compendium, data);
    if (S.tab === 'comp' && !compEditing()) renderPanel(); return;
  }
  if (type === 'npcs') { S.npcs = data; if (S.tab === 'comp' && !compEditing()) renderPanel(); return; }
  if (type === 'actor') {
    if (op === 'delete') { remove(S.actors, data.id); if (S.sheetId === data.id) S.sheetId = null; renderAll(); return; }
    if (by === CLIENT_ID && pending.has(data.id)) return;
    const had = actorById(data.id);
    const typing = S.tab === 'sheets' && S.sheetId === data.id && panelEl.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (had && typing) {
      // Someone else changed this character (damage, healing, a cast) while the sheet is being edited: keep our local copy, but take the live
      // resources so that our next save cannot write the old HP / mana / favors back.
      Object.assign(had.data.hp, data.data.hp); Object.assign(had.data.mp, data.data.mp); Object.assign(had.data.fav, data.data.fav);
      had.computed = data.computed; patchComputed(had); map.redraw(); renderChatWho(); return;
    }
    upsert(S.actors, data);
    if (!had) { if (!S.actorId) S.actorId = data.id; renderAll(); return; }
    map.redraw(); renderChatWho();
    if (S.tab === 'sheets' && S.sheetId === data.id) renderPanel();
    return;
  }
  if (type === 'chat') {
    const fresh = op !== 'delete' && !S.chat.some((m) => m.id === data.id);
    if (op === 'delete') remove(S.chat, data.id); else upsert(S.chat, data);
    if (S.chat.length > 300) S.chat.splice(0, S.chat.length - 300);
    renderChat();
    if (fresh) peekChat();
  }
}

// ------------------------------------------------------------------ shell
// The GM can look at (and prepare) any scene; players only ever see the active one.
const viewScene = () => (isGM() ? S.scenes.find((s) => s.id === S.viewId) ?? S.scene : S.scene);
const viewTokens = () => { const sc = viewScene(); return sc ? S.tokens.filter((t) => t.sceneId === sc.id) : []; };
const isPlayerToken = (tok) => {
  if (tok.sight) return true; // a token the GM shares with everyone (ally, torch bearer...)
  const a = tok.actorId && actorById(tok.actorId);
  if (!a) return false;
  return isGM() ? Object.values(a.perms ?? {}).includes('edit') : a.perm === 'edit'; // a player's tokens: sheets they can edit
};
/** Whose eyes the fog uses: a player's own tokens; for the GM's "player view", all players, one player, or the selected token. */
function viewerTokens(tokens) {
  if (!isGM()) return tokens.filter(isPlayerToken);
  if (S.viewAs === 'selected' && S.selected.size) return tokens.filter((x) => S.selected.has(x.id));
  if (typeof S.viewAs === 'number') return tokens.filter((x) => x.sight || actorById(x.actorId)?.perms?.[S.viewAs] === 'edit');
  return tokens.filter(isPlayerToken);
}
let editsPending = 0;
function replaceScene(r) {
  if (isGM()) upsert(S.scenes, r);
  if (r.active || S.scene?.id === r.id) S.scene = r;
  map.redraw(); renderHud();
}
/** Optimistic scene edit: consecutive wall clicks must see each other, so apply locally first and queue the saves in order. */
function sceneEdit(patch, { undoable = true } = {}) {
  const sc = viewScene(); if (!sc) return Promise.resolve();
  if (undoable) {
    const prev = {};
    for (const k of ['walls', 'lights', 'reveal']) if (k in patch) prev[k] = structuredClone(sc[k] ?? []);
    if (Object.keys(prev).length) { S.undo.push({ sceneId: sc.id, prev }); if (S.undo.length > 60) S.undo.shift(); }
  }
  Object.assign(sc, patch); sc._rev = (sc._rev || 0) + 1; map.redraw(); editsPending++;
  editQueue = editQueue
    .then(() => api('PATCH', '/scenes/' + sc.id, patch))
    .then((r) => { if (--editsPending === 0) replaceScene(r); })
    .catch((e) => { editsPending = Math.max(0, editsPending - 1); toast(e.message); });
  return editQueue;
}

function undoSceneEdit() {
  const last = S.undo[S.undo.length - 1];
  if (!last || last.sceneId !== viewScene()?.id) return;
  S.undo.pop(); sceneEdit(last.prev, { undoable: false }); renderHud();
}

function buildShell() {
  const canvas = h('canvas', { id: 'map' });
  inspectorEl = h('div', { class: 'inspector hidden' });
  hudEl = h('div', { class: 'hud' }); topEl = h('div', { class: 'hud-top' });
  fogNote = h('div', { class: 'fog-note hidden' }, isGM() ? t('noViewers') : t('noViewersPlayer'));
  const stage = h('div', { id: 'stage' }, canvas, fogNote, inspectorEl, topEl, hudEl);
  dockEl = h('aside', { id: 'dock' });
  panelEl = h('section', { id: 'panel' });
  footEl = h('div', { class: 'dock-foot' });
  chatPane = !S.mapMode && h('aside', { id: 'chatpane' });
  app.replaceChildren(h('div', { id: 'layout', class: S.mapMode ? 'no-chat' : '' }, chatPane, stage, dockEl));
  audio = createAudio({ getOffset: () => S.timeOffset, onBlocked: () => { if (!S.audioBlocked) { S.audioBlocked = true; renderFoot(); } } });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '') && isGM()) { e.preventDefault(); undoSceneEdit(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modal) { S.modal = null; renderModal(); } });
  document.addEventListener('click', () => { if (S.audioBlocked) { S.audioBlocked = false; audio.unlock(); renderFoot(); } });
  map = createMap(canvas, {
    state: () => {
      const sc = viewScene(), tokens = viewTokens(), eyes = viewerTokens(tokens);
      return {
        scene: sc, tokens, selected: S.selected, tool: S.tool, gm: isGM(), playerView: S.playerView,
        viewers: eyes.map((x) => ({ x: x.x, y: x.y, vision: x.vision })), viewerIds: new Set(eyes.map((x) => x.id)),
        lights: [...(sc?.lights ?? []), ...tokens.filter((x) => x.light > 0 && !x.hidden).map((x) => ({ x: x.x, y: x.y, radius: x.light }))],
      };
    },
    canMove: (tok) => isGM() || (!!tok.actorId && actorById(tok.actorId)?.perm === 'edit'),
    onFog: (total) => fogNote.classList.toggle('hidden', !total),
    isDead: (tok) => { // forced by the GM, else the sheet's HP when this page has it, else what the server says
      if (tok.life === 'dead') return true;
      if (tok.life === 'alive') return false;
      const a = tok.actorId && actorById(tok.actorId);
      return a ? a.data.hp.cur <= 0 : !!tok.dead;
    },
    hpRatio: (tok) => { const a = tok.actorId && actorById(tok.actorId); const max = a?.computed.derived.maxhp; return max ? a.data.hp.cur / max : null; },
    onSelect: (set) => { S.selected = set; renderInspector(); renderChat(); },
    onMove: (tok, x, y) => { api('PATCH', '/tokens/' + tok.id, { x, y }).catch(() => {}); },
    onOpen: (tok) => { if (tok.actorId && actorById(tok.actorId)) { S.tab = 'sheets'; S.sheetId = tok.actorId; renderAll(); } },
    onSceneEdit: sceneEdit,
  });
  buildChat();
  if (chatPane) mountChat();
  renderAll();
  audio.sync(S.playing, S.sounds);
}
function renderAll() { renderDock(); renderChat(); renderChatWho(); renderInspector(); renderHud(); map?.redraw(); }

const TOOL_HINT = {
  fr: { wall: 'Clic : poser un point · clic droit ou Échap : finir · Maj ou Alt : placement libre', rect: 'Glisser : rectangle de murs · Maj : sans aimant', circle: 'Glisser du centre vers le bord : cercle de murs',
    curve: 'Clic : départ · clic : arrivée · bouger pour courber · clic : valider · Échap : annuler', door: 'Clic : poser une porte · clic sur une porte : ouvrir / fermer', edit: 'Glisser un sommet pour déplacer les murs qui y sont reliés',
    light: 'Clic : poser une lumière', reveal: 'Glisser : révéler une zone en permanence', erase: 'Clic : supprimer mur, lumière ou zone' },
  en: { wall: 'Click to add points · right-click or Esc to finish · Shift or Alt: free placement', rect: 'Drag: rectangle of walls · Shift: no snapping', circle: 'Drag from the centre to the edge: circle of walls',
    curve: 'Click: start · click: end · move to bend · click: confirm · Esc: cancel', door: 'Click to place a door · click a door to open / close it', edit: 'Drag a corner to move the walls attached to it',
    light: 'Click to place a light', reveal: 'Drag to permanently reveal an area', erase: 'Click to delete a wall, light or area' },
};
function renderHud() {
  hudEl.replaceChildren(h('button', { title: 'Fit', onclick: () => map.fit() }, '⤢'));
  topEl.replaceChildren();
  if (!isGM()) return;
  const sc = viewScene();
  const sel = h('select', { title: t('scenes'), onchange: (e) => { S.viewId = Number(e.target.value); S.selected = new Set(); renderAll(); } },
    S.scenes.map((s) => h('option', { value: s.id }, s.name + (s.active ? ' ●' : ''))));
  sel.value = S.viewId ?? '';
  const flag = (label, checked, on) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onchange: (e) => on(e.target.checked) }), label);
  const viewAs = h('select', { title: t('viewAs'), onchange: (e) => { const v = e.target.value; S.viewAs = /^\d+$/.test(v) ? Number(v) : v; map.redraw(); } },
    h('option', { value: 'players' }, t('viewPlayers')), h('option', { value: 'selected' }, t('viewSelected')),
    S.users.filter((u) => u.role === 'player').map((u) => h('option', { value: u.id }, u.name)));
  viewAs.value = String(S.viewAs);
  add(topEl, S.scenes.length ? sel : null,
    sc && !sc.active && !S.mapMode && h('button', { class: 'primary', onclick: guard(() => api('POST', `/scenes/${sc.id}/activate`)) }, t('activate')),
    sc && flag(t('fog'), sc.fog, (v) => { sceneEdit({ fog: v }, { undoable: false }); renderHud(); }),
    sc && flag(t('dark'), sc.dark, (v) => sceneEdit({ dark: v }, { undoable: false })),
    sc?.fog && !S.mapMode && flag(t('playerView'), S.playerView, (v) => { S.playerView = v; renderHud(); map.redraw(); }),
    sc?.fog && S.playerView && viewAs);
  if (!sc) return;
  const tools = [['select', 'toolSelect'], ['wall', 'toolWall'], ['rect', 'toolRect'], ['circle', 'toolCircle'], ['curve', 'toolCurve'], ['door', 'toolDoor'], ['edit', 'toolEdit'], ['light', 'toolLight'], ['reveal', 'toolReveal'], ['erase', 'toolErase']];
  const snapSel = h('select', { title: t('snap'), onchange: (e) => { S.tool.snap = e.target.value; } },
    h('option', { value: 'grid' }, t('snapGrid')), h('option', { value: 'half' }, t('snapHalf')), h('option', { value: 'off' }, t('snapOff')));
  snapSel.value = S.tool.snap;
  const canUndo = S.undo.some((u) => u.sceneId === sc.id);
  add(hudEl, h('div', { class: 'tools' },
    tools.map(([id, key]) => h('button', { class: S.tool.name === id ? 'on' : '', onclick: () => { S.tool.name = id; map.cancel(); renderHud(); } }, t(key))),
    S.tool.name !== 'select' && snapSel,
    S.tool.name === 'light' && h('label', {}, t('radius'), h('input', { type: 'number', class: 'n', min: 1, max: 100, value: S.tool.radius, oninput: (e) => { S.tool.radius = Number(e.target.value) || 6; } })),
    h('button', { title: 'Ctrl+Z', disabled: !canUndo, onclick: undoSceneEdit }, t('undo'))),
    TOOL_HINT[getLang()]?.[S.tool.name] && h('div', { class: 'hint tool-hint' }, TOOL_HINT[getLang()][S.tool.name]));
}

function renderFoot() {
  fill(footEl,
    h('button', { class: 'quiet' + (audio.isMuted() ? ' on' : ''), title: t('mute'), onclick: () => { audio.setMuted(!audio.isMuted()); renderFoot(); } }, audio.isMuted() ? t('mute') : '♪'),
    h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: audio.getMaster(), title: t('volume'), oninput: (e) => audio.setMaster(Number(e.target.value)) }),
    S.audioBlocked && h('button', { class: 'primary', onclick: () => { S.audioBlocked = false; audio.unlock(); renderFoot(); } }, t('unlock')),
    h('span', { class: 'spacer' }),
    h('button', { class: 'quiet', title: 'FR / EN', onclick: () => { setLang(getLang() === 'fr' ? 'en' : 'fr'); location.reload(); } }, getLang().toUpperCase()),
    isGM() ? gmNav() : h('button', { class: 'quiet', title: t('logout'), onclick: guard(async () => { await request('POST', `/api/t/${ROUTE.slug}/leave`); location.reload(); }) }, `${S.me.name} · ${t('logout')}`));
}
/** GM footer: jump to another table, or back to the GM home. */
function gmNav() {
  const sel = !S.mapMode && S.allTables.length > 1 && h('select', { title: t('tables'), onchange: (e) => location.assign('/admin/' + e.target.value) }, S.allTables.map((x) => h('option', { value: x.slug }, x.name)));
  if (sel) sel.value = S.table?.slug ?? '';
  return [sel, h('a', { class: 'quiet', href: '/admin' }, t('gmHome'))];
}

// The user's own icons (design-reference/icons) on the tabs, as in the plugin.
const TAB_ICON = { sheets: 'bio', journal: 'notes', rules: 'stats', comp: 'inventory', table: 'tab', system: 'settings', map: 'tab' };
function renderDock() {
  const tabs = S.mapMode ? [['map', t('mapLibrary')]] : [['sheets', t('sheets')], ['journal', t('journal')], ['rules', t('rules')], ['comp', t('compendium')],
    ...(isGM() ? [['table', t('table')], ['sound', t('sound')], ['system', t('system')]] : [])];
  fill(dockEl,
    h('nav', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: S.tab === id ? 'on' : '', title: label, onclick: () => { S.tab = id; if (id === 'system') S.draft = structuredClone(S.system); if (id === 'comp') refreshComp(); renderDock(); } }, TAB_ICON[id] && icon(TAB_ICON[id], 'ico tab-ico'), h('span', { class: 'tab-label' }, label)))),
    panelEl, footEl);
  renderPanel(); renderFoot();
}
function renderPanel() {
  const panels = { map: mapPanel, sheets: sheetsPanel, journal: journalPanel, rules: rulesPanel, table: tablePanel, sound: soundPanel, comp: compPanel, system: systemPanel };
  panelEl.className = 'panel-' + S.tab;
  panelEl.replaceChildren((panels[S.tab] ?? panels.chat)());
}

// ------------------------------------------------------------------ chat
function buildChat() {
  chatList = h('div', { class: 'chat-list' });
  chatWho = h('select', { class: 'who', title: t('speakingAs'), onchange: (e) => { S.actorId = Number(e.target.value) || null; localStorage.setItem('speakAs', S.actorId ?? ''); } });
  chatInput = h('textarea', { class: 'chat-input', rows: 1, placeholder: isGM() ? t('chatHintGm') : t('chatHint'), maxlength: 6000 });
  const sugg = h('div', { class: 'suggest hidden' });
  const hist = []; let hi = 0, opts = [], active = 0;
  const grow = () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + 'px'; };
  // "@" for the GM: suggest sheet names (they may contain spaces) and "mj" for narration
  const mention = () => { const pos = chatInput.selectionStart, m = /(^|\s)@([^@\n]{0,40})$/.exec(chatInput.value.slice(0, pos)); return m ? { start: pos - m[2].length - 1, end: pos, q: m[2].toLowerCase() } : null; };
  const showSugg = () => {
    const mq = isGM() && mention();
    opts = mq ? [{ name: 'mj', label: t('narrator') }, ...S.actors.map((a) => ({ name: a.name, avatar: a.data.token || a.data.portrait }))].filter((o) => o.name.toLowerCase().startsWith(mq.q)).slice(0, 8) : [];
    active = Math.min(active, Math.max(0, opts.length - 1));
    sugg.classList.toggle('hidden', !opts.length);
    fill(sugg, opts.map((o, i) => h('button', { type: 'button', class: i === active ? 'on' : '', onmousedown: (e) => { e.preventDefault(); pick(o); } },
      o.avatar ? h('img', { class: 'chat-avatar', src: o.avatar, alt: '' }) : h('span', { class: 'chat-avatar none' }, '@'), h('b', {}, o.name), o.label && h('span', { class: 'dim' }, o.label))));
  };
  const pick = (o) => {
    const mq = mention(); if (!mq) return;
    chatInput.value = chatInput.value.slice(0, mq.start) + '@' + o.name + ' ' + chatInput.value.slice(mq.end);
    const caret = mq.start + o.name.length + 2; chatInput.setSelectionRange(caret, caret); opts = []; showSugg(); grow();
  };
  chatInput.addEventListener('input', () => { grow(); active = 0; showSugg(); });
  chatInput.addEventListener('blur', () => setTimeout(() => sugg.classList.add('hidden'), 100));
  chatInput.addEventListener('keydown', async (e) => {
    if (opts.length && !sugg.classList.contains('hidden')) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = (active + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length; showSugg(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { pick(opts[active]); e.preventDefault(); return; }
      if (e.key === 'Escape') { opts = []; sugg.classList.add('hidden'); return; }
    }
    if (e.key === 'ArrowUp' && hist.length && !chatInput.value) { hi = Math.max(0, hi - 1); chatInput.value = hist[hi]; grow(); e.preventDefault(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return; // Shift+Enter: new line (a whole scene in one message)
    e.preventDefault();
    const text = chatInput.value.trim(); if (!text) return;
    hist.push(text); hi = hist.length; chatInput.value = ''; grow();
    await doRoll(text);
  });
  chatEl = h('div', { class: 'chat' }, chatList, h('div', { class: 'chat-bar' }, sugg, chatWho, chatInput));
}
/** The chat lives left of the map, outside the tabs: pinned open, or "dynamic" (a thin strip that opens on hover, focus or a new message). */
let chatMode = (() => { try { return localStorage.getItem('chatMode') === 'dynamic' ? 'dynamic' : 'pinned'; } catch { return 'pinned'; } })();
let chatPeek = null;
function mountChat() {
  const toggle = h('button', { class: 'quiet', title: t(chatMode === 'pinned' ? 'chatToDynamic' : 'chatToPinned'), onclick: () => {
    chatMode = chatMode === 'pinned' ? 'dynamic' : 'pinned';
    try { localStorage.setItem('chatMode', chatMode); } catch { /* private window */ }
    mountChat(); setTimeout(() => map?.resize?.(), 0);
  } }, chatMode === 'pinned' ? '⇤' : '📌');
  const wrap = h('div', { class: 'chat-wrap' }, h('div', { class: 'chat-head' }, h('b', {}, t('chat')), toggle), chatEl);
  const strip = h('div', { class: 'strip', title: t('chat') }, h('span', { class: 'strip-icon' }, '💬'), h('span', { class: 'unread hidden' }));
  chatPane.className = chatMode;
  fill(chatPane, strip, wrap);
  const open = (on) => { chatPane.classList.toggle('open', on); if (on) { strip.querySelector('.unread').classList.add('hidden'); chatList.scrollTop = chatList.scrollHeight; } };
  chatPane.onmouseenter = () => { if (chatMode === 'dynamic') open(true); };
  chatPane.onmouseleave = () => { if (chatMode === 'dynamic' && !chatPane.contains(document.activeElement)) open(false); };
  chatPane.onfocusin = () => { if (chatMode === 'dynamic') open(true); };
  chatPane.onfocusout = () => setTimeout(() => { if (chatMode === 'dynamic' && !chatPane.contains(document.activeElement) && !chatPane.matches(':hover')) open(false); }, 50);
}
/** Dynamic mode: a new message opens the chat for a few seconds. */
function peekChat() {
  if (chatMode !== 'dynamic' || !chatPane || chatPane.classList.contains('open')) return;
  chatPane.classList.add('open');
  clearTimeout(chatPeek);
  chatPeek = setTimeout(() => { if (!chatPane.matches(':hover') && !chatPane.contains(document.activeElement)) chatPane.classList.remove('open'); }, 4000);
}
function renderChatWho() {
  chatWho.replaceChildren(h('option', { value: '' }, t('noChar')), ...S.actors.filter((a) => a.perm === 'edit').map((a) => h('option', { value: a.id }, a.name)));
  chatWho.value = S.actorId ?? '';
}
const doRoll = guard(async (text, actorId = S.actorId) => {
  const m = await api('POST', '/chat', { text, actorId });
  upsert(S.chat, m); renderChat();
});
function renderChat() {
  const stick = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
  chatList.replaceChildren(...S.chat.map(msgNode));
  if (stick) chatList.scrollTop = chatList.scrollHeight;
}
const avatarEl = (src) => (src ? h('img', { class: 'chat-avatar', src, alt: '' }) : h('span', { class: 'chat-avatar none' }));
const pictureOf = (actorId) => { const a = actorId && actorById(actorId); return a ? a.data.token || a.data.portrait || null : null; };
function msgNode(m) {
  const b = m.body, u = userById(m.userId), del = isGM() && h('button', { class: 'x', title: t('del'), onclick: guard(() => api('DELETE', '/chat/' + m.id)) }, '×');
  const whisper = m.whisper && h('em', { class: 'whisper' }, ' → ' + t('gm'));
  if (b.t === 'info') return h('div', { class: 'msg info' }, b.text, del);
  if (b.t === 'narration') return h('div', { class: 'msg narration' }, whisper,
    b.parts.map((p) => (p.narration ? h('p', { class: 'narr' }, p.text)
      : h('div', { class: 'said' }, avatarEl(p.avatar ?? pictureOf(p.actorId)), h('b', {}, p.name), h('div', { class: 'body' }, inline(p.text, (c) => doRoll(c)))))), del);
  if (b.t === 'text') {
    const who = b.name ?? (m.actorId && actorById(m.actorId)?.name);
    return h('div', { class: 'msg said' }, avatarEl(b.avatar ?? pictureOf(m.actorId)),
      h('div', { class: 'msg-head' }, h('b', { style: `color:${u?.color ?? '#eba5ff'}` }, who || m.userName), who && h('span', { class: 'dim' }, ` (${m.userName})`), whisper),
      h('div', { class: 'body' }, inline(b.text, (c) => doRoll(c))), del);
  }
  return rollCard(m, b, del);
}
function rollCard(m, b, del) {
  const mine = m.userId === S.me.id, ownsActor = m.actorId && actorById(m.actorId)?.perm === 'edit';
  const check = b.kind === 'stat';
  return h('div', { class: 'msg roll' },
    h('div', { class: 'roll-head' },
      h('span', { class: 'msg-head' }, avatarEl(b.avatar ?? pictureOf(m.actorId)), h('b', {}, b.actorName), ' · ', b.label || b.title, m.whisper && h('em', { class: 'whisper' }, ' → ' + t('gm'))),
      del),
    h('div', { class: 'formula' }, `${b.count > 1 ? b.count + '× ' : ''}${b.formula}${b.rerolls ? ` · ↻${b.rerolls}` : ''}`),
    b.results.map((r) => h('div', { class: 'res ' + (r.outcome ?? '') },
      h('span', { class: 'dice' }, r.dice.filter((d) => d.results.length).map((d) => h('span', { class: 'dgroup', title: `${d.count}d${d.faces}` }, d.results.map((v) => h('span', { class: 'die' + (d.faces === 20 && (v === 1 || v === 20) ? (v === 1 ? ' nat1' : ' nat20') : '') }, v))))),
      h('span', { class: 'total' }, r.total),
      r.target != null && h('span', { class: 'target' }, (check ? '≤ ' : '/ ') + r.target),
      r.outcome && h('span', { class: 'badge ' + r.outcome }, t(r.outcome)))),
    b.talents && h('div', { class: 'formula' }, `${t('talents')} : ${b.talents.names.join(', ')} (${b.talents.total < 0 ? '+' : '−'}${Math.abs(b.talents.total)})`),
    b.count > 1 && h('div', { class: 'sum' }, 'Σ ', b.sum),
    h('div', { class: 'roll-actions' },
      (mine || isGM()) && h('button', { onclick: guard(() => api('POST', `/chat/${m.id}/reroll`)) }, '↻ ' + t('reroll')),
      ['damage', 'heal', 'theal', 'mana'].includes(b.kind) && (isGM() || (ownsActor && b.kind !== 'damage')) && h('button', { class: 'primary', onclick: applyRoll(m) }, t('apply') + (S.selected.size && isGM() ? ` (${S.selected.size})` : ''))),
    (b.applied ?? []).map((a) => h('div', { class: 'applied' + (a.undone ? ' undone' : '') }, `${a.name}: `, appliedText(a),
      a.id && !a.undone && (isGM() || (b.kind !== 'damage' && actorById(a.actorId)?.perm === 'edit')) &&
        h('button', { class: 'undo', title: t('undoApply'), onclick: guard(() => api('POST', `/chat/${m.id}/undo`, { entryId: a.id })) }, '↶'))));
}
const applyRoll = (m) => guard(async () => {
  const tokenIds = isGM() ? [...S.selected] : [];
  if (isGM() && !tokenIds.length && !(m.body.kind !== 'damage' && m.actorId)) return toast(t('noTarget'), false);
  await api('POST', `/chat/${m.id}/apply`, { tokenIds });
});
function appliedText(a) {
  if (a.note) return a.note;
  if (a.kind === 'damage') return `−${a.dealt} ${t('hp')}${a.tempLost ? ` (${a.tempLost} ${t('temp').toLowerCase()})` : ''}${a.mpLost ? `, −${a.mpLost} ${t('mp')}` : ''}${a.ko ? ' · KO' : ''}`;
  if (a.kind === 'heal') return `+${a.healed} ${t('hp')}`;
  if (a.kind === 'theal') return `+ ${t('temp')} → ${a.temp}`;
  return `+${a.restored} ${t('mp')}`;
}

// ------------------------------------------------------------------ sheets
let saveTimer;
const openTalents = new WeakSet(); // talents whose description is unfolded
const saveActor = (a) => { pending.add(a.id); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow(a), 350); };
// Saves run one after another: each one must send the HP / mana / favors the previous one got back from the server.
let saveChain = Promise.resolve();
const saveNow = (a) => { clearTimeout(saveTimer); const p = saveChain.then(() => sendSave(a)); saveChain = p; return p; };
const sendSave = guard(async (a) => {
  const sent = { hp: a.data.hp.cur, mp: a.data.mp.cur, fav: a.data.fav.cur };
  const res = await api('PATCH', '/actors/' + a.id, { name: a.name, data: a.data });
  // The server moves current values when a maximum changes (level, stats, gear); take them unless the user typed a new one meanwhile.
  for (const k of ['hp', 'mp', 'fav']) {
    if (a.data[k].cur !== sent[k] || res.data[k].cur === sent[k]) continue;
    a.data[k].cur = res.data[k].cur;
    const input = $(`[data-r="${k}"]`, panelEl);
    if (input && document.activeElement !== input) input.value = res.data[k].cur;
  }
  for (const k of ['talents', 'spells', 'items']) a.data[k].forEach((x, i) => { if (!x.id) x.id = res.data[k][i]?.id ?? ''; });
  a.data.items.forEach((x) => { if (x._k && x.id && S.openItems.has(x._k)) S.openItems.add(x.id); }); // a new card stays open once it has its real id
  a.computed = res.computed; pending.delete(a.id); patchComputed(a); map.redraw(); renderChatWho();
});
const cget = (a, path) => path.split('.').reduce((o, k) => o?.[k], a.computed);
function patchComputed(a) {
  $$('[data-c]', panelEl).forEach((el) => {
    el.textContent = cget(a, el.dataset.c) ?? 0;
    if (el.dataset.c === 'points.spent') el.classList.toggle('over', a.computed.points.spent > a.computed.points.budget);
  });
}
const C = (a, path) => h('span', { class: 'c', 'data-c': path }, cget(a, path) ?? 0);

function field(a, obj, key, kind = 'text', attrs = {}) {
  if (kind === 'bool') return h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; saveActor(a); } });
  const tag = kind === 'area' ? 'textarea' : 'input';
  const props = { ...attrs, value: obj[key] ?? '', oninput: (e) => { obj[key] = kind === 'int' ? Number(e.target.value) || 0 : e.target.value; saveActor(a); } };
  if (tag === 'input') Object.assign(props, kind === 'int' ? { type: 'number', step: 1 } : { type: 'text' });
  return h(tag, props);
}
const statIndex = () => { const m = new Map(); for (const s of S.system.stats) [s.id, ...s.aliases].forEach((n) => m.set(n, s.id)); return m; };

function sheetsPanel() {
  const a = S.sheetId && actorById(S.sheetId);
  if (a) return sheetView(a);
  return h('div', { class: 'pad' },
    isGM() && h('button', { class: 'primary wide', onclick: guard(async () => { const r = await api('POST', '/actors', { name: t('newChar') }); upsert(S.actors, r); S.actorId = r.id; S.sheetId = r.id; renderAll(); }) }, '+ ' + t('newChar')),
    !S.actors.length && h('p', { class: 'hint' }, t('empty')),
    h('ul', { class: 'list' }, S.actors.map((x) => h('li', {}, h('button', { class: 'row', onclick: () => { S.sheetId = x.id; renderPanel(); } },
      h('b', {}, x.name), h('span', { class: 'dim' }, ` ${t('level')} ${x.data.bio.level}${isGM() ? ' · ' + permSummary(x) : x.perm === 'view' ? ' · ' + t('permView') : ''}`),
      h('span', { class: 'dim right' }, `${x.data.hp.cur}/${x.computed.derived.maxhp} ${t('hp')}`))))));
}

const compBtn = () => null; // every named item / spell enters the compendium by itself
function compPick(kind, onPick) {
  const list = S.compendium.filter((c) => c.kind === kind);
  if (!list.length) return null;
  const sel = h('select', { class: 'comp-pick', onchange: (e) => { const c = list.find((x) => x.id === Number(e.target.value)); if (c) onPick(structuredClone(c.data)); } },
    h('option', { value: '' }, t('fromComp')), list.map((c) => h('option', { value: c.id }, c.name)));
  return sel;
}
function sheetView(a) {
  const sys = S.system, d = a.data, idx = statIndex();
  const modInput = h('input', { type: 'text', class: 'mod', placeholder: '+0', value: S.rollMod, oninput: (e) => { S.rollMod = e.target.value.trim(); } });
  const rollBtn = (cmdType, label, cls = 'roll') => h('button', { class: cls, onclick: () => doRoll(`/${cmdType} ${S.rollMod}`, a.id) }, label);
  const section = (title, body, actions) => h('section', { class: 'sec' }, h('h3', {}, title, actions), body);
  const num = (obj, key, lo = 0) => field(a, obj, key, 'int', { min: lo, class: 'n' });

  const head = h('div', { class: 'sheet-head' },
    h('button', { class: 'quiet', onclick: () => { saveNow(a); S.sheetId = null; renderPanel(); } }, '← ' + t('back')),
    h('div', { class: 'namerow' },
      h('button', { class: 'avatar', title: t('picture'), onclick: () => pictureDialog(a) }, (d.token || d.portrait) ? h('img', { src: d.token || d.portrait, alt: '' }) : '+'),
      field(a, a, 'name', 'text', { class: 'title grow' })),
    h('div', { class: 'grid2' },
      h('label', {}, t('cls'), field(a, d.bio, 'class')), h('label', {}, t('element'), field(a, d.bio, 'element')),
      h('label', {}, t('level'), field(a, d.bio, 'level', 'int', { min: 1, class: 'n' })),
      h('label', { class: 'check' }, field(a, d, 'elemental', 'bool'), t('elemental'))));

  const res = section(t('hp') + ' / ' + t('mp') + ' / ' + t('fav'), h('div', { class: 'res-grid' },
    h('label', {}, t('hp'), field(a, d.hp, 'cur', 'int', { min: -9999, class: 'n', 'data-r': 'hp' }), ' / ', C(a, 'derived.maxhp')),
    h('label', {}, t('temp'), num(d.hp, 'temp')),
    h('label', {}, t('mp'), field(a, d.mp, 'cur', 'int', { min: 0, class: 'n', 'data-r': 'mp' }), ' / ', C(a, 'derived.maxmp')),
    h('label', {}, t('fav'), field(a, d.fav, 'cur', 'int', { min: 0, class: 'n', 'data-r': 'fav' }), ' / ', C(a, 'derived.maxfav')),
    h('label', {}, t('actions'), C(a, 'derived.act')),
    h('label', {}, t('defP'), C(a, 'pdef'), ' ', t('defM'), ' ', C(a, 'mdef'))));

  const rows = sys.stats.map((s) => h('tr', {},
    h('td', {}, rollBtn(s.id, s.label)),
    h('td', {}, num(d.stats[s.id], 'base')), h('td', { class: 'dim' }, C(a, `stats.${s.id}.item`)),
    h('td', {}, num(d.stats[s.id], 'passive', -999)), h('td', { class: 'tot' }, C(a, `stats.${s.id}.total`))));
  const stats = section(t('modifier'), h('div', {},
    h('div', { class: 'mod-row' }, modInput, h('span', { class: 'dim' }, `${t('points')}: `, C(a, 'points.spent'), ' / ', C(a, 'points.budget'))),
    h('table', { class: 'stats' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('base')), h('th', {}, t('item')), h('th', {}, t('passive')), h('th', {}, t('total')))), h('tbody', {}, rows)),
    h('div', { class: 'quick' }, sys.quickRolls.map((q) => rollBtn(q.id, q.label, 'roll wide')),
      h('label', {}, t('actions') + ' +', num(d, 'bonact', -99)), h('label', {}, '+', num(d, 'bonspe', -999)))));

  // Tiers in roll terms (T2 = -3 on the die); shown as the bonus they are on a roll-under check ("+3").
  const tierMod = (n) => Number(sys.knowledgeTiers[n] ?? 0);
  const tierLabel = (n) => `T${n} ${tierMod(n) > 0 ? '−' : '+'}${Math.abs(tierMod(n))}`;
  const tierKeys = [...new Set(['0', ...Object.keys(sys.knowledgeTiers)])].sort((x, y) => x - y);
  const activeBonus = -d.talents.filter((tl) => tl.enabled).reduce((n, tl) => n + tierMod(tl.tier), 0);
  const talents = section(t('talents'), h('div', {},
    d.talents.map((tl, i) => {
      const open = openTalents.has(tl);
      return h('div', { class: 'talent' + (tl.enabled ? ' on' : '') },
        h('div', { class: 'line' },
          h('input', { type: 'checkbox', title: t('talentActive'), checked: tl.enabled, onchange: (e) => { tl.enabled = e.target.checked; saveActor(a); renderPanel(); } }),
          field(a, tl, 'name', 'text', { class: 'grow', placeholder: t('name') }),
          (() => { const sel = h('select', { onchange: (e) => { tl.tier = Number(e.target.value); saveActor(a); renderPanel(); } }, tierKeys.map((k) => h('option', { value: k }, tierLabel(k)))); sel.value = tl.tier; return sel; })(),
          h('button', { class: 'x', title: t('description'), onclick: () => { if (open) openTalents.delete(tl); else openTalents.add(tl); renderPanel(); } }, open ? '▴' : '▾'),
          h('button', { class: 'x', title: t('del'), onclick: () => { d.talents.splice(i, 1); saveActor(a); renderPanel(); } }, '×')),
        open && field(a, tl, 'description', 'area', { rows: 3, placeholder: t('description') }));
    }),
    h('p', { class: 'hint' }, activeBonus ? `${t('talentsOn')} : ${activeBonus > 0 ? '+' : ''}${activeBonus}` : t('talentHint'))),
  h('div', { class: 'addrow' }, h('button', { class: 'add', onclick: () => { const tl = { id: '', name: '', tier: 0, enabled: false, description: '' }; d.talents.push(tl); openTalents.add(tl); saveActor(a); renderPanel(); } }, '+ ' + t('add'))));

  const spells = section(t('spells'), h('div', {}, d.spells.map((sp, i) => h('div', { class: 'spell' },
    h('div', { class: 'line' }, field(a, sp, 'name', 'text', { class: 'grow' }), field(a, sp, 'cost', 'int', { min: 0, class: 'n', title: t('cost') }),
      (() => { const sel = h('select', { onchange: (e) => { sp.costType = e.target.value; saveActor(a); } }, h('option', { value: 'mp' }, t('mp')), h('option', { value: 'hp' }, t('hp'))); sel.value = sp.costType; return sel; })()),
    h('div', { class: 'line' }, h('label', { class: 'check' }, field(a, sp, 'armed', 'bool'), t('armed')), h('label', { class: 'check' }, field(a, sp, 'continuous', 'bool'), t('continuous')),
      h('button', { class: 'primary', onclick: guard(async () => {
        const stat = sp.armed ? sys.spells.armedStat : sys.spells.unarmedStat;
        await doRoll(`/${stat} ${S.rollMod}|${sp.name}`, a.id);
        if (pending.has(a.id)) await saveNow(a);
        const r = await api('POST', `/actors/${a.id}/cast`, { spellId: sp.id }); upsert(S.actors, r); renderPanel();
      }) }, t('cast')), compBtn('spell', sp), h('button', { class: 'x', onclick: () => { d.spells.splice(i, 1); saveActor(a); renderPanel(); } }, '×')),
    h('div', { class: 'spell-effect' + (sp.locked ? ' locked' : '') },
      field(a, sp, 'effect', 'area', { rows: 2, placeholder: t('effect'), readonly: sp.locked }),
      h('button', { class: 'quiet', title: sp.locked ? t('unlockText') : t('lockText'), onclick: () => { sp.locked = !sp.locked; saveActor(a); renderPanel(); } }, sp.locked ? '✎ ' + t('edit') : '🔒 ' + t('save')))))),
  h('div', { class: 'addrow' }, h('button', { class: 'add', onclick: () => { d.spells.push({ id: '', name: '', effect: '', cost: 1, costType: 'mp', armed: false, continuous: false, locked: false }); saveActor(a); renderPanel(); } }, '+ ' + t('add')), compPick('spell', (e) => { d.spells.push({ ...e, id: '' }); saveActor(a); renderPanel(); })));

  const items = inventoryView({ a, S, field, saveActor, rerender: renderPanel, compBtn, compPick });
  const money = section(t('currency'), h('div', { class: 'line' }, ['pc', 'pa', 'po'].map((k) => h('label', {}, k.toUpperCase(), field(a, d.currency, k, 'int', { min: 0, class: 'n wide' })))));
  const notes = section(t('notes'), field(a, d, 'notes', 'area', { rows: 6 }));
  const gm = isGM() && section('GM', h('div', { class: 'line' },
    viewScene() && h('button', { onclick: guard(async () => { const c = map.viewCenter(); await api('POST', '/tokens', { sceneId: viewScene().id, actorId: a.id, name: a.name, x: Math.round(c.x), y: Math.round(c.y) }); toast(t('saved'), false); await loadState(); renderAll(); }) }, t('placeToken')),
    h('label', { class: 'check', title: t('npcHint') }, h('input', { type: 'checkbox', checked: a.shown, onchange: guard(async (e) => { Object.assign(a, await api('PATCH', '/actors/' + a.id, { shown: e.target.checked })); }) }), t('shownToPlayers')),
    h('button', { class: 'danger', onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await api('DELETE', '/actors/' + a.id); }) }, t('del'))));
  const perms = isGM() && section(t('perms'), permsEditor(a));
  if (a.perm === 'view') return h('div', { class: 'sheet pad' }, // everything visible, nothing editable
    h('button', { class: 'quiet', onclick: () => { S.sheetId = null; renderPanel(); } }, '← ' + t('back')), h('p', { class: 'hint' }, t('viewOnly')),
    h('fieldset', { class: 'readonly', disabled: true }, head, res, stats, talents, spells, items, money, notes));
  return h('div', { class: 'sheet pad' }, head, res, stats, talents, spells, items, money, notes, perms, gm);
}
/** Portrait (the whole character) and token (round, framed: map, chat, NPC list). A new portrait asks for the token's framing. */
function pictureDialog(a) {
  const d = a.data;
  const close = () => $('.modal')?.remove();
  const done = () => { saveActor(a); close(); renderPanel(); };
  const crop = guard(async () => { const f = await openTokenCropper(d.portrait); if (f) { d.token = await upload(f); done(); } });
  const pick = (onFile) => h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onchange: guard(async (e) => { const f = e.target.files[0]; if (f) await onFile(f); }) });
  close();
  document.body.append(h('div', { class: 'modal', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal-card picture' }, h('button', { class: 'x close', onclick: close }, '×'), h('h3', {}, t('picture')),
      h('div', { class: 'picture-row' },
        h('figure', {}, d.portrait ? h('img', { class: 'portrait', src: d.portrait, alt: '' }) : h('div', { class: 'portrait empty' }, '—'), h('figcaption', {}, t('portrait'))),
        h('figure', {}, d.token ? h('img', { class: 'token', src: d.token, alt: '' }) : h('div', { class: 'token empty' }, d.portrait ? h('img', { src: d.portrait, alt: '' }) : '—'), h('figcaption', {}, t('tokenImage')))),
      h('div', { class: 'line' },
        h('label', { class: 'filebtn primary' }, t('newPortrait'), pick(async (f) => {
          d.portrait = await upload(f); d.token = '';
          const tok = await openTokenCropper(d.portrait); // frame it right away
          if (tok) d.token = await upload(tok);
          done();
        })),
        d.portrait && h('button', { onclick: crop }, t('cropToken')),
        h('label', { class: 'filebtn' }, t('readyToken'), pick(async (f) => { d.token = await upload(f); done(); })),
        (d.portrait || d.token) && h('button', { class: 'danger', onclick: () => { d.portrait = ''; d.token = ''; done(); } }, t('del'))))));
}
/** Names of the players who can edit a sheet ("—" for none). */
const permSummary = (a) => S.users.filter((u) => a.perms?.[u.id] === 'edit').map((u) => u.name).join(', ') || '—';
/** GM: per player of the table, edit / view only / none (invisible). */
function permsEditor(a) {
  if (!S.users.length) return h('p', { class: 'hint' }, t('noSlots'));
  return h('div', { class: 'perms' }, S.users.map((u) => {
    const sel = h('select', { onchange: guard(async (e) => {
      const next = { ...(a.perms ?? {}) };
      if (e.target.value) next[u.id] = e.target.value; else delete next[u.id];
      Object.assign(a, await api('PUT', `/actors/${a.id}/perms`, { perms: next })); // keep the same object: the open sheet holds it
    }) }, h('option', { value: '' }, t('permNone')), h('option', { value: 'view' }, t('permView')), h('option', { value: 'edit' }, t('permEdit')));
    sel.value = a.perms?.[u.id] ?? '';
    return h('label', { class: 'line' }, h('b', { class: 'grow', style: `color:${u.color}` }, u.name), sel);
  }));
}

// ------------------------------------------------------------------ rules
function rulesPanel() {
  return h('div', { class: 'pad' }, S.system.rules.map((r, i) => h('details', { open: i === 0 }, h('summary', {}, r.title), markdown(r.body, (c) => doRoll(c)))));
}

// ------------------------------------------------------------------ table (GM)
function imageSize(file) {
  return new Promise((res, rej) => { const u = URL.createObjectURL(file), i = new Image(); i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(u); }; i.onerror = rej; i.src = u; });
}
const sceneField = (sc, key, label) => h('label', {}, label, h('input', { type: 'number', class: 'n', value: sc[key], onchange: (e) => sceneEdit({ [key]: Number(e.target.value) }) }));
/** Grid, offset, image and clean-up of the scene being viewed (a table scene or a library map). */
function sceneSettings(sc) {
  return [
    h('div', { class: 'line' }, sceneField(sc, 'grid', t('grid')), sceneField(sc, 'ox', 'X'), sceneField(sc, 'oy', 'Y')),
    h('div', { class: 'line' },
      h('button', { onclick: () => confirm(t('confirmDel')) && sceneEdit({ walls: [] }) }, t('clearWalls')),
      h('button', { onclick: () => confirm(t('confirmDel')) && sceneEdit({ lights: [] }) }, t('clearLights')),
      h('button', { onclick: () => sceneEdit({ reveal: [] }) }, t('clearReveal'))),
    h('label', {}, t('mapImage'), h('input', { type: 'file', accept: 'image/*', onchange: guard(async (e) => { const f = e.target.files[0]; if (!f) return; const [url, dim] = await Promise.all([upload(f), imageSize(f)]); sceneEdit({ image: url, width: dim.w, height: dim.h }); }) })),
  ];
}
async function newSceneBody(name, file) {
  if (!file) return { name };
  const [url, dim] = await Promise.all([upload(file), imageSize(file)]);
  return { name, image: url, width: dim.w, height: dim.h };
}
/** "+ from the library": copies a library map into this table. Removed when the library is empty. */
function libraryPicker() {
  const sel = h('select', { class: 'comp-pick', onchange: guard(async (e) => {
    if (!e.target.value) return;
    const r = await request('POST', `/admin/api/scenes/${e.target.value}/copy`, { table: S.table.slug });
    S.viewId = r.id; await loadState(); renderAll();
  }) }, h('option', { value: '' }, t('fromLibrary')));
  request('GET', '/admin/api/library').then(({ scenes }) => { if (scenes.length) add(sel, scenes.map((m) => h('option', { value: m.id }, m.name))); else sel.remove(); }).catch(() => sel.remove());
  return sel;
}
const playerUrl = () => `${location.origin}/${S.table.slug}`;
function tablePanel() {
  const sc = viewScene();
  const nameIn = h('input', { type: 'text', placeholder: t('newScene') });
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  const create = guard(async () => {
    const r = await api('POST', '/scenes', await newSceneBody(nameIn.value || t('newScene'), fileIn.files[0]));
    S.viewId = r.id; await loadState(); renderAll();
  });
  const tokName = h('input', { type: 'text', placeholder: t('tokenName') });
  const slotName = h('input', { type: 'text', placeholder: t('name'), maxlength: 40 });
  const addSlot = guard(async () => { upsert(S.users, await api('POST', '/slots', { name: slotName.value || t('player') })); renderPanel(); });
  slotName.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSlot(); });
  const patchTable = async (body) => { S.table = { ...S.table, ...(await request('PATCH', `/admin/api/tables/${S.table.slug}`, body)) }; };
  return h('div', { class: 'pad' },
    h('section', { class: 'sec' }, h('h3', {}, t('players')),
      h('div', { class: 'line' }, h('span', { class: 'dim' }, t('playerLink')), h('code', { class: 'grow' }, playerUrl()), h('button', { onclick: () => copyText(playerUrl()) }, t('copyLink'))),
      S.users.map((u) => h('div', { class: 'line' },
        h('span', { class: 'dot' + (u.online ? ' online' : ''), title: u.online ? t('online') : '' }),
        h('input', { type: 'text', class: 'grow', value: u.name, maxlength: 40, onchange: guard(async (e) => upsert(S.users, await api('PATCH', `/slots/${u.id}`, { name: e.target.value }))) }),
        h('input', { type: 'color', value: u.color, onchange: guard(async (e) => upsert(S.users, await api('PATCH', `/slots/${u.id}`, { color: e.target.value }))) }),
        u.online && h('button', { onclick: guard(() => api('POST', `/slots/${u.id}/kick`)) }, t('kick')),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (confirm(t('confirmDel'))) await api('DELETE', `/slots/${u.id}`); }) }, '×'))),
      h('div', { class: 'line' }, slotName, h('button', { class: 'primary', onclick: addSlot }, '+ ' + t('addPlayer')))),
    h('section', { class: 'sec' }, h('h3', {}, t('scenes')),
      h('ul', { class: 'list' }, S.scenes.map((x) => h('li', { class: 'line' },
        h('button', { class: 'row grow' + (x.id === S.viewId ? ' on' : ''), title: t('view'), onclick: () => { S.viewId = x.id; S.selected = new Set(); renderAll(); } }, h('b', {}, x.name)),
        x.active ? h('span', { class: 'badge success' }, t('active')) : h('button', { onclick: guard(() => api('POST', `/scenes/${x.id}/activate`)) }, t('activate')),
        h('button', { class: 'x', title: t('toLibrary'), onclick: guard(async () => { await request('POST', `/admin/api/scenes/${x.id}/copy`, { table: null }); toast(t('saved'), false); }) }, '⇪'),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (confirm(t('confirmDel'))) await api('DELETE', '/scenes/' + x.id); }) }, '×')))),
      h('div', { class: 'line' }, nameIn, fileIn),
      h('div', { class: 'line' }, h('button', { class: 'primary', onclick: create }, '+ ' + t('newScene')), libraryPicker())),
    sc && h('section', { class: 'sec' }, h('h3', {}, sc.name), sceneSettings(sc),
      h('div', { class: 'line' }, tokName, h('button', { onclick: guard(async () => { const c = map.viewCenter(); await api('POST', '/tokens', { sceneId: sc.id, name: tokName.value || 'Token', x: Math.round(c.x), y: Math.round(c.y) }); await loadState(); map.redraw(); }) }, t('addToken')))),
    h('section', { class: 'sec' }, h('h3', {}, t('tableSettings')),
      h('label', {}, t('tableName'), h('input', { type: 'text', value: S.table.name, maxlength: 60, onchange: (e) => patchTable({ name: e.target.value }) })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.table.listed, onchange: (e) => patchTable({ listed: e.target.checked }) }), t('listed')),
      h('label', {}, t('campaign'), (() => {
        const sel = h('select', { onchange: guard(async (e) => {
          const id = e.target.value ? Number(e.target.value) : null;
          await patchTable({ campaignId: id });
          const linked = S.campaigns.find((c) => c.id === id)?.systemId;
          if (linked) previewSystem(linked, t('applyLinked')); // the campaign's rules, after a look at what changes
        }) }, h('option', { value: '' }, t('noCampaign')), S.campaigns.map((c) => h('option', { value: c.id }, c.name)));
        sel.value = S.table.campaignId ?? ''; return sel;
      })())));
}

/** Map library editor panel: name, grid, image, and "copy to" a table. */
function mapPanel() {
  const sc = viewScene();
  const back = h('a', { class: 'quiet', href: '/admin' }, '← ' + t('gmHome'));
  if (!sc) return h('div', { class: 'pad' }, back, h('p', { class: 'hint' }, t('empty')));
  const copySel = h('select', { onchange: guard(async (e) => {
    if (!e.target.value) return;
    await request('POST', `/admin/api/scenes/${sc.id}/copy`, { table: e.target.value });
    toast(`${t('copiedTo')} ${e.target.selectedOptions[0].textContent}`, false); e.target.value = '';
  }) }, h('option', { value: '' }, t('copyTo')), S.allTables.map((x) => h('option', { value: x.slug }, x.name)));
  return h('div', { class: 'pad' }, back,
    h('section', { class: 'sec' }, h('h3', {}, t('mapName')),
      h('input', { type: 'text', class: 'title', value: sc.name, maxlength: 80, onchange: (e) => { sceneEdit({ name: e.target.value }, { undoable: false }); renderHud(); } }),
      sceneSettings(sc), S.allTables.length > 0 && h('div', { class: 'line' }, copySel)));
}

// ------------------------------------------------------------------ token inspector (GM)
function renderInspector() {
  const tok = isGM() && S.selected.size === 1 ? S.tokens.find((x) => x.id === [...S.selected][0]) : null;
  inspectorEl.classList.toggle('hidden', !tok);
  if (!tok) return inspectorEl.replaceChildren();
  const patch = guard(async (body) => { const r = await api('PATCH', '/tokens/' + tok.id, body); Object.assign(tok, r); map.redraw(); renderInspector(); });
  const select = (value, options, onchange) => { const sel = h('select', { onchange }, options.map(([v, l]) => h('option', { value: v }, l))); sel.value = value; return sel; };
  const row = (label, control, title) => [h('span', { class: 'k', title }, label), control];
  const cells = (key) => h('input', { type: 'number', class: 'n', min: 0, step: 0.5, value: tok[key], onchange: (e) => patch({ [key]: Number(e.target.value) || 0 }) });
  const flag = (key) => h('input', { type: 'checkbox', checked: tok[key], onchange: (e) => patch({ [key]: e.target.checked }) });
  fill(inspectorEl,
    h('div', { class: 'insp-head' },
      h('input', { type: 'text', class: 'grow', value: tok.name, onchange: (e) => patch({ name: e.target.value }) }),
      h('button', { class: 'x', title: t('close'), onclick: () => { S.selected = new Set(); map.redraw(); renderInspector(); } }, '×')),
    h('div', { class: 'insp-grid' },
      row(t('linked'), select(tok.actorId ?? '', [['', t('none')], ...S.actors.map((a) => [a.id, a.name])], (e) => patch({ actorId: e.target.value ? Number(e.target.value) : null }))),
      row(t('size'), select(tok.size, [0.5, 1, 2, 3, 4, 6].map((v) => [v, v]), (e) => patch({ size: Number(e.target.value) }))),
      row(t('vision'), cells('vision')), row(t('light'), cells('light')),
      row(t('life'), select(tok.life ?? 'auto', [['auto', t('lifeAuto')], ['dead', t('lifeDead')], ['alive', t('lifeAlive')]], (e) => patch({ life: e.target.value })), t('lifeHint')),
      row(t('hidden'), flag('hidden')), row(t('sight'), flag('sight'), t('sightHint')),
      row(t('color'), h('input', { type: 'color', value: tok.color, onchange: (e) => patch({ color: e.target.value }) })),
      row(t('tokenImage'), h('label', { class: 'filebtn' }, t('choose'), h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { const f = e.target.files[0]; if (f) patch({ image: await upload(f) }); }) })))),
    h('button', { class: 'danger', onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await api('DELETE', '/tokens/' + tok.id); remove(S.tokens, tok.id); S.selected = new Set(); renderInspector(); map.redraw(); }) }, t('del')));
}

// ------------------------------------------------------------------ journal & handouts
const visLabel = (j) => (j.visibility === 'all' ? t('visAll') : j.visibility === 'gm' ? t('visGM') : t('visCustom'));
function journalPanel() {
  const j = S.journals.find((x) => x.id === S.journalId);
  if (j && S.journalEdit && isGM()) return journalForm(j);
  if (j) return journalView(j);
  return h('div', { class: 'pad' },
    isGM() && h('button', { class: 'primary wide', onclick: guard(async () => { const r = await api('POST', '/journals', { title: t('newEntry') }); upsert(S.journals, r); S.journalId = r.id; S.journalEdit = true; renderPanel(); }) }, '+ ' + t('newEntry')),
    !S.journals.length && h('p', { class: 'hint' }, t('empty')),
    h('ul', { class: 'list' }, S.journals.map((x) => h('li', {}, h('button', { class: 'row', onclick: () => { S.journalId = x.id; S.journalEdit = false; renderPanel(); } }, h('b', {}, x.title), isGM() && h('span', { class: 'dim right' }, visLabel(x)))))));
}
function journalBody(j) {
  return h('div', { class: 'journal-body' }, j.image && h('img', { class: 'handout', src: j.image, alt: j.title }),
    markdown(j.body, (c) => { S.modal = null; renderModal(); doRoll(c); }));
}
function journalView(j) {
  return h('div', { class: 'pad' },
    h('div', { class: 'line' }, h('button', { class: 'quiet', onclick: () => { S.journalId = null; renderPanel(); } }, '← ' + t('back')), h('h3', { class: 'grow' }, j.title)),
    isGM() && h('div', { class: 'line' },
      h('button', { onclick: () => { S.journalEdit = true; renderPanel(); } }, t('edit')),
      h('button', { class: 'primary', onclick: guard(() => api('POST', `/journals/${j.id}/show`)) }, t('showPlayers')),
      h('button', { class: 'danger', onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await api('DELETE', '/journals/' + j.id); S.journalId = null; }) }, t('del'))),
    journalBody(j));
}
function journalForm(j) {
  const d = { title: j.title, body: j.body, image: j.image, mode: j.visibility === 'all' ? 'all' : Array.isArray(j.visibility) ? 'custom' : 'gm', users: Array.isArray(j.visibility) ? [...j.visibility] : [] };
  const players = S.users.filter((u) => u.role === 'player');
  const vis = () => (d.mode === 'custom' ? d.users : d.mode);
  const modeSel = h('select', { onchange: (e) => { d.mode = e.target.value; renderPanel2(); } }, h('option', { value: 'gm' }, t('visGM')), h('option', { value: 'all' }, t('visAll')), h('option', { value: 'custom' }, t('visCustom')));
  modeSel.value = d.mode;
  const picks = h('div', { class: 'line' }, players.map((u) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.users.includes(u.id), onchange: (e) => { d.users = e.target.checked ? [...d.users, u.id] : d.users.filter((x) => x !== u.id); } }), u.name)));
  picks.classList.toggle('hidden', d.mode !== 'custom');
  const renderPanel2 = () => picks.classList.toggle('hidden', d.mode !== 'custom');
  const img = h('div', { class: 'line' }, h('label', { class: 'filebtn' }, t('image'), h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { const f = e.target.files[0]; if (f) { d.image = await upload(f); toast(t('saved'), false); } }) })),
    h('button', { class: 'quiet', onclick: () => { d.image = null; toast(t('saved'), false); } }, t('del') + ' ' + t('image').toLowerCase()));
  return h('div', { class: 'pad' },
    h('input', { type: 'text', class: 'title', value: d.title, oninput: (e) => { d.title = e.target.value; } }),
    img, h('textarea', { rows: 14, placeholder: t('body') + ' — **gras**, # titre, - liste, [str +2|label]', oninput: (e) => { d.body = e.target.value; } }, d.body),
    h('div', { class: 'line' }, t('visibility'), modeSel), picks,
    h('div', { class: 'line' },
      h('button', { class: 'primary', onclick: guard(async () => { const r = await api('PATCH', '/journals/' + j.id, { title: d.title, body: d.body, image: d.image, visibility: vis() }); upsert(S.journals, r); S.journalEdit = false; renderPanel(); }) }, t('save')),
      h('button', { onclick: () => { S.journalEdit = false; renderPanel(); } }, t('back'))));
}
function renderModal() {
  $('.modal')?.remove();
  const j = S.journals.find((x) => x.id === S.modal); if (!j) return;
  const close = () => { S.modal = null; renderModal(); };
  document.body.append(h('div', { class: 'modal', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal-card' }, h('button', { class: 'x close', onclick: close }, '×'), h('h3', {}, j.title), journalBody(j))));
}

// ------------------------------------------------------------------ sound (GM)
function soundPanel() {
  const file = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true, onchange: guard(async (e) => {
    for (const f of e.target.files) { const url = await upload(f); upsert(S.sounds, await api('POST', '/sounds', { name: f.name.replace(/\.[^.]+$/, ''), url, loop: false, volume: 1 })); }
    renderPanel();
  }) });
  const isOn = (s) => S.playing.some((p) => p.id === s.id);
  return h('div', { class: 'pad' }, h('p', { class: 'hint' }, t('soundHint')),
    h('div', { class: 'line' }, h('label', { class: 'filebtn' }, '+ ' + t('uploadAudio'), file), h('button', { onclick: guard(() => api('POST', '/audio/stop')) }, t('stopAll'))),
    !S.sounds.length && h('p', { class: 'hint' }, t('empty')),
    S.sounds.map((s) => h('div', { class: 'sound' + (isOn(s) ? ' on' : '') },
      h('div', { class: 'line' }, h('input', { type: 'text', class: 'grow', value: s.name, onchange: guard((e) => api('PATCH', '/sounds/' + s.id, { name: e.target.value })) }),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (confirm(t('confirmDel'))) await api('DELETE', '/sounds/' + s.id); }) }, '×')),
      h('div', { class: 'line' },
        h('button', { class: 'primary', onclick: guard(() => api('POST', `/sounds/${s.id}/play`)) }, '▶ ' + t('play')),
        h('button', { onclick: guard(() => api('POST', `/sounds/${s.id}/stop`)) }, t('stop')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.loop, onchange: guard((e) => api('PATCH', '/sounds/' + s.id, { loop: e.target.checked })) }), t('loop')),
        h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.volume, title: t('volume'), onchange: guard((e) => api('PATCH', '/sounds/' + s.id, { volume: Number(e.target.value) })) })))));
}

// ------------------------------------------------------------------ compendium (GM)
const CATS = () => [['weapon', t('invWeapons')], ['armor', t('invArmor')], ['consumable', t('invConsumable')], ['bag', t('invBag')], ['other', t('invOther')]];
let compOpen = new Set(); // ids of entries whose editor is open
const compEditing = () => compOpen.size > 0 && panelEl.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
/** Players: what their sheets carry changes all the time, so the tab asks the server each time it opens. */
const refreshComp = guard(async () => {
  if (isGM() && S.compView === 'global') { S.compGlobal = await request('GET', '/admin/api/compendium'); }
  else { const r = await api('GET', '/compendium'); S.compendium = r.entries; S.npcs = r.npcs; }
  if (S.tab === 'comp') renderPanel();
});
const bonusText = (d) => Object.entries(d.bonuses ?? {}).map(([k, v]) => `${S.system?.stats.find((x) => x.id === k)?.label ?? k} ${v > 0 ? '+' : ''}${v}`).join(', ');
/** One line of facts about an entry (players read it, the GM sees it above the editor). */
function entrySummary(e) {
  const d = e.data;
  if (e.kind === 'spell') return [`${t('cost')} ${d.cost} ${d.costType === 'hp' ? t('hp') : t('mp')}`, d.armed && t('armed'), d.continuous && t('continuous')].filter(Boolean).join(' · ');
  return [d.pdef && `${t('defP')} ${d.pdef}`, d.mdef && `${t('defM')} ${d.mdef}`, bonusText(d), d.equipExpr].filter(Boolean).join(' · ');
}
/** The GM's in-place editor of an entry. save(body) sends { name, data }. */
function entryEditor(e, save) {
  const d = structuredClone(e.data); let name = e.name;
  const num = (key) => h('input', { type: 'number', class: 'n', value: d[key] ?? 0, oninput: (ev) => { d[key] = Number(ev.target.value) || 0; } });
  const txt = (key, attrs = {}) => h('input', { type: 'text', value: d[key] ?? '', ...attrs, oninput: (ev) => { d[key] = ev.target.value; } });
  const chk = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!d[key], onchange: (ev) => { d[key] = ev.target.checked; } }), label);
  const fields = e.kind === 'spell'
    ? [h('div', { class: 'line' }, h('label', {}, t('cost'), num('cost')),
        (() => { const sel = h('select', { onchange: (ev) => { d.costType = ev.target.value; } }, h('option', { value: 'mp' }, t('mp')), h('option', { value: 'hp' }, t('hp'))); sel.value = d.costType ?? 'mp'; return sel; })(),
        chk('armed', t('armed')), chk('continuous', t('continuous'))),
      h('textarea', { rows: 3, placeholder: t('effect'), oninput: (ev) => { d.effect = ev.target.value; } }, d.effect ?? '')]
    : [h('div', { class: 'line' },
        (() => { const sel = h('select', { onchange: (ev) => { d.type = ev.target.value; } }, CATS().map(([k, l]) => h('option', { value: k }, l))); sel.value = d.type ?? 'other'; return sel; })(),
        h('label', {}, t('defP'), num('pdef')), h('label', {}, t('defM'), num('mdef'))),
      h('label', {}, t('slotsExpr'), txt('equipExpr', { class: 'code' })),
      S.system && h('div', { class: 'line' }, S.system.stats.map((st) => h('label', {}, st.label, h('input', { type: 'number', class: 'n', value: d.bonuses?.[st.id] ?? 0,
        oninput: (ev) => { const v = Number(ev.target.value) || 0; d.bonuses ??= {}; if (v) d.bonuses[st.id] = v; else delete d.bonuses[st.id]; } })))),
      h('textarea', { rows: 3, placeholder: t('notes'), oninput: (ev) => { d.notes = ev.target.value; } }, d.notes ?? '')];
  return h('div', { class: 'entry-edit' },
    h('input', { type: 'text', class: 'title', value: name, maxlength: 80, oninput: (ev) => { name = ev.target.value; } }),
    fields, h('div', { class: 'line' }, h('button', { class: 'primary', onclick: guard(async () => { await save({ name, data: { ...d, name } }); compOpen.delete(e.id); toast(t('saved'), false); renderPanel(); }) }, t('save'))));
}
const byCategory = (entries) => CATS().map(([k, label]) => [label, entries.filter((e) => e.kind === 'item' && e.category === k)]).filter(([, list]) => list.length);
function compPanel() {
  if (!isGM()) return playerCompendium();
  const sw = h('div', { class: 'line seg' },
    ['table', 'global'].map((v) => h('button', { class: S.compView === v ? 'on' : '', onclick: () => { S.compView = v; compOpen = new Set(); refreshComp(); renderPanel(); } }, v === 'table' ? t('compThis') : t('compGlobal'))));
  return h('div', { class: 'pad' }, sw, S.compView === 'global' ? globalCompendium() : tableCompendium());
}
/** Players: items by category, spells, NPCs (name and picture only). Read-only. */
function playerCompendium() {
  const entry = (e) => h('details', { class: 'entry' }, h('summary', {}, h('b', {}, e.name), h('span', { class: 'dim' }, ' ' + entrySummary(e))),
    e.data.notes && h('p', {}, e.data.notes), e.data.effect && h('p', {}, e.data.effect));
  const items = byCategory(S.compendium), spells = S.compendium.filter((e) => e.kind === 'spell');
  return h('div', { class: 'pad' },
    !S.compendium.length && !S.npcs.length && h('p', { class: 'hint' }, t('compPlayerHint')),
    items.length > 0 && h('section', { class: 'sec' }, h('h3', {}, t('items')), items.map(([label, list]) => [h('h4', {}, label), list.map(entry)])),
    spells.length > 0 && h('section', { class: 'sec' }, h('h3', {}, t('spells')), spells.map(entry)),
    S.npcs.length > 0 && h('section', { class: 'sec' }, h('h3', {}, t('npcs')), h('div', { class: 'npcs' }, S.npcs.map((n) => h('div', { class: 'npc' }, n.portrait ? h('img', { src: n.portrait, alt: '' }) : h('span', { class: 'avatar' }, '?'), h('b', {}, n.name))))));
}
/** GM, this table: edit in place, show to players, update copies whose original changed, NPC list. */
function tableCompendium() {
  const row = (e) => {
    const open = compOpen.has(e.id);
    return h('div', { class: 'entry' + (open ? ' open' : '') },
      h('div', { class: 'line' },
        h('button', { class: 'row grow', onclick: () => { if (open) compOpen.delete(e.id); else compOpen.add(e.id); renderPanel(); } }, h('b', {}, e.name), h('span', { class: 'dim' }, ' ' + entrySummary(e))),
        e.auto && h('span', { class: 'badge', title: t('autoHint') }, 'auto'),
        e.source?.stale && h('button', { class: 'primary', title: t('staleCopy'), onclick: guard(async () => { upsert(S.compendium, await api('POST', `/compendium/${e.id}/refresh`)); renderPanel(); }) }, '↻ ' + t('updateCopy')),
        h('label', { class: 'check', title: t('visibleToPlayers') }, h('input', { type: 'checkbox', checked: e.visible, onchange: guard(async (ev) => { upsert(S.compendium, await api('PATCH', '/compendium/' + e.id, { visible: ev.target.checked })); }) }), '👁'),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (confirm(t('confirmDel'))) { await api('DELETE', '/compendium/' + e.id); remove(S.compendium, e.id); renderPanel(); } }) }, '×')),
      open && entryEditor(e, async (body) => upsert(S.compendium, await api('PATCH', '/compendium/' + e.id, body))));
  };
  const create = (kind, type) => guard(async () => {
    const r = await api('POST', '/compendium', { kind, name: kind === 'spell' ? t('newSpell') : t('newItem'), data: type ? { type } : {} });
    upsert(S.compendium, r); compOpen.add(r.id); renderPanel();
  });
  const items = S.compendium.filter((e) => e.kind === 'item'), spells = S.compendium.filter((e) => e.kind === 'spell');
  return [
    h('p', { class: 'hint' }, t('compGmHint')),
    h('section', { class: 'sec' }, h('h3', {}, t('items'), h('button', { class: 'quiet', onclick: create('item', 'other') }, '+ ' + t('newItem'))),
      !items.length && h('p', { class: 'hint' }, t('empty')),
      CATS().map(([k, label]) => { const list = items.filter((e) => e.category === k); return list.length > 0 && [h('h4', {}, label), list.map(row)]; })),
    h('section', { class: 'sec' }, h('h3', {}, t('spells'), h('button', { class: 'quiet', onclick: create('spell') }, '+ ' + t('newSpell'))),
      !spells.length && h('p', { class: 'hint' }, t('empty')), spells.map(row)),
    h('section', { class: 'sec' }, h('h3', {}, t('npcs')), h('p', { class: 'hint' }, t('npcHint')),
      S.actors.map((a) => h('label', { class: 'line check' }, h('input', { type: 'checkbox', checked: a.shown, onchange: guard(async (ev) => { Object.assign(a, await api('PATCH', '/actors/' + a.id, { shown: ev.target.checked })); }) }),
        h('b', { class: 'grow' }, a.name), h('span', { class: 'dim' }, `${t('level')} ${a.data.bio.level}`)))),
  ];
}
/** A dropdown of checkboxes: null = everything ticked. */
function multiPick(label, options, chosen, onChange) {
  const all = options.map(([v]) => v), cur = chosen ?? all;
  return h('details', { class: 'multi' }, h('summary', {}, `${label} (${cur.length}/${all.length})`),
    options.map(([v, text]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cur.includes(v), onchange: (e) => {
      const next = e.target.checked ? [...cur, v] : cur.filter((x) => x !== v);
      onChange(next.length === all.length ? null : next);
    } }), text)));
}
/** GM, everything: all tables and outside tables, filters on tables and campaigns, "add to this table". */
function globalCompendium() {
  const g = S.compGlobal;
  if (!g) return h('p', { class: 'hint' }, '…');
  const OUT = '', NONE = 0;
  const tableOpts = [[OUT, t('outside')], ...g.tables.map((x) => [x.slug, x.name])];
  const campOpts = [[NONE, t('noCampaign')], ...g.campaigns.map((c) => [c.id, c.name])];
  const f = S.compFilter;
  const keep = (x) => (!f.tables || f.tables.includes(x.table ?? OUT)) && (!f.campaigns || f.campaigns.includes(x.campaignId ?? NONE));
  const tag = (x) => h('span', { class: 'dim' }, ' · ', x.table ? g.tables.find((tb) => tb.slug === x.table)?.name ?? x.table : t('outside'),
    x.campaignId && ' · ' + (g.campaigns.find((c) => c.id === x.campaignId)?.name ?? ''));
  const addHere = (path, x) => (x.table === S.table.slug ? h('span', { class: 'dim' }, t('inThisTable'))
    : h('button', { onclick: guard(async () => { const r = await api('POST', path, { id: x.id }); if (path.includes('actors')) upsert(S.actors, r); else upsert(S.compendium, r); toast(t('saved'), false); await refreshComp(); }) }, '+ ' + t('addToTable')));
  const row = (e) => {
    const open = compOpen.has(e.id), outside = !e.table;
    return h('div', { class: 'entry' + (open ? ' open' : '') },
      h('div', { class: 'line' },
        h('button', { class: 'row grow', onclick: () => { if (!outside) return; if (open) compOpen.delete(e.id); else compOpen.add(e.id); renderPanel(); } }, h('b', {}, e.name), tag(e)),
        addHere('/compendium/import', e),
        outside && h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (confirm(t('confirmDel'))) { await request('DELETE', '/admin/api/compendium/' + e.id); await refreshComp(); } }) }, '×')),
      open && entryEditor(e, async (body) => { await request('PATCH', '/admin/api/compendium/' + e.id, { ...body, table: S.table.slug }); await refreshComp(); }));
  };
  const entries = g.entries.filter(keep), npcs = g.npcs.filter(keep);
  const newCamp = h('select', {}, h('option', { value: '' }, t('noCampaign')), g.campaigns.map((c) => h('option', { value: c.id }, c.name)));
  const create = (kind) => guard(async () => {
    const r = await request('POST', '/admin/api/compendium', { kind, name: kind === 'spell' ? t('newSpell') : t('newItem'), table: S.table.slug, campaignId: newCamp.value ? Number(newCamp.value) : null });
    compOpen.add(r.id); await refreshComp();
  });
  return [
    h('div', { class: 'line' }, multiPick(t('tables'), tableOpts, f.tables, (v) => { f.tables = v; renderPanel(); }), multiPick(t('campaigns'), campOpts, f.campaigns, (v) => { f.campaigns = v; renderPanel(); })),
    h('div', { class: 'line' }, h('span', { class: 'dim' }, t('outside') + ' :'), newCamp, h('button', { onclick: create('item') }, '+ ' + t('newItem')), h('button', { onclick: create('spell') }, '+ ' + t('newSpell'))),
    h('section', { class: 'sec' }, h('h3', {}, t('items')), byCategory(entries).map(([label, list]) => [h('h4', {}, label), list.map(row)]), !entries.some((e) => e.kind === 'item') && h('p', { class: 'hint' }, t('empty'))),
    h('section', { class: 'sec' }, h('h3', {}, t('spells')), entries.filter((e) => e.kind === 'spell').map(row), !entries.some((e) => e.kind === 'spell') && h('p', { class: 'hint' }, t('empty'))),
    h('section', { class: 'sec' }, h('h3', {}, t('npcs')), npcs.map((n) => h('div', { class: 'line entry' }, h('span', { class: 'row grow' }, h('b', {}, n.name), h('span', { class: 'dim' }, ` ${t('level')} ${n.level}`), tag(n)), addHere('/actors/import', n))),
      !npcs.length && h('p', { class: 'hint' }, t('empty'))),
  ];
}

// ------------------------------------------------------------------ saved systems: preview the differences, then apply
const short = (v) => { const x = typeof v === 'string' ? v : JSON.stringify(v); return x.length > 80 ? x.slice(0, 77) + '…' : x; };
function dialog(title, body, actions) {
  $('.modal')?.remove();
  const close = () => $('.modal')?.remove();
  document.body.append(h('div', { class: 'modal', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal-card' }, h('button', { class: 'x close', onclick: close }, '×'), h('h3', {}, title), body,
      h('div', { class: 'line' }, actions.map(([label, fn, primary]) => h('button', { class: primary ? 'primary' : '', onclick: guard(async () => { await fn(); close(); }) }, label))))));
}
/** Show what a saved system would change in this table, and apply it on confirmation. */
const previewSystem = guard(async (systemId, intro) => {
  const { name, diff } = await api('GET', `/system/diff/${systemId}`);
  const OP = { added: t('opAdded'), removed: t('opRemoved'), changed: t('opChanged') };
  dialog(`${t('diffTitle')} : ${name}`, h('div', {}, intro && h('p', {}, intro),
    !diff.length ? h('p', { class: 'hint' }, t('noDiff')) : h('ul', { class: 'diff' }, diff.map((d) => h('li', { class: d.op },
      h('code', {}, d.path), ' ', h('b', {}, OP[d.op]), d.op === 'changed' ? [' : ', h('span', { class: 'dim' }, short(d.before)), ' → ', short(d.after)] : d.op === 'added' ? [' : ', short(d.after)] : null)))),
  [[t('applyNow'), async () => { await api('POST', `/system/apply/${systemId}`); S.draft = null; await loadState(); renderAll(); toast(t('saved'), false); }, true], [t('cancel'), () => {}]]);
});
/** System tab, top: save this table's rules to the library, update a saved one, apply one. */
function systemLibrary() {
  const pick = (label, fn) => h('select', { onchange: (e) => { const id = Number(e.target.value); e.target.value = ''; if (id) fn(id); } },
    h('option', { value: '' }, label), S.savedSystems.map((x) => h('option', { value: x.id }, x.name)));
  const reloadLib = async () => { S.savedSystems = (await request('GET', '/admin/api/systems')).systems; renderPanel(); };
  return h('section', { class: 'sec' }, h('h3', {}, t('systemsLib')), h('div', { class: 'line' },
    h('button', { onclick: guard(async () => { const name = prompt(t('systemName'), S.system.name); if (!name) return; await request('POST', '/admin/api/systems', { name, table: S.table.slug }); await reloadLib(); toast(t('saved'), false); }) }, t('saveSystemAs')),
    S.savedSystems.length > 0 && pick(t('updateSystem'), guard(async (id) => { if (!confirm(t('confirmOverwrite'))) return; await request('PATCH', `/admin/api/systems/${id}`, { table: S.table.slug }); await reloadLib(); toast(t('saved'), false); })),
    S.savedSystems.length > 0 && pick(t('applySystem'), (id) => previewSystem(id))));
}

// ------------------------------------------------------------------ system editor (GM)
function systemPanel() {
  const draft = S.draft ??= structuredClone(S.system);
  draft.spells ??= { armedStat: 'foc', unarmedStat: 'int' };
  const REQUIRED = ['maxhp', 'maxmp', 'maxfav', 'act'];
  const status = (el, r) => { el.textContent = r.ok ? `= ${r.total}${r.dice?.length ? ' ' + JSON.stringify(r.dice.map((d) => d.results)) : ''}${r.actor ? ` (${r.actor})` : ''}` : r.error; el.className = 'result ' + (r.ok ? 'ok' : 'err'); };
  const test = (formula, el, dice) => api('POST', '/system/test', { formula, dice, actorId: S.actorId }).then((r) => status(el, r)).catch(() => {});
  const txt = (obj, key, attrs = {}) => h('input', { type: 'text', ...attrs, value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; } });
  const numf = (obj, key) => h('input', { type: 'number', class: 'n', value: obj[key] ?? 0, oninput: (e) => { obj[key] = Number(e.target.value) || 0; } });
  const aliasField = (obj) => h('input', { type: 'text', class: 'code', placeholder: t('aliases'), value: (obj.aliases || []).join(', '), oninput: (e) => { obj.aliases = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); } });
  const delBtn = (list, i, locked) => h('button', { class: 'x', title: t('del'), disabled: locked, onclick: () => { list.splice(i, 1); renderPanel(); } }, '×');
  const addBtn = (list, item) => h('button', { class: 'add', onclick: () => { list.push(item); renderPanel(); } }, '+ ' + t('add'));
  const sec = (title, ...kids) => h('section', { class: 'sec' }, h('h3', {}, title), ...kids);
  const formulaRow = (list, item, i, dice, locked) => {
    const out = h('span', { class: 'result' });
    const run = debounce(() => test(item.formula, out, dice), 250);
    run();
    return h('div', { class: 'formula-row' },
      h('div', { class: 'line' }, txt(item, 'label', { class: 'grow', placeholder: t('name') }), txt(item, 'id', { class: 'code idf', disabled: locked }), delBtn(list, i, locked)),
      !dice && aliasField(item),
      h('input', { type: 'text', class: 'code', value: item.formula, oninput: (e) => { item.formula = e.target.value; run(); } }), out);
  };
  const tester = (() => { const f = h('input', { type: 'text', class: 'code grow', placeholder: 'con*(lvl+1)' }), o = h('span', { class: 'result' }), dice = h('input', { type: 'checkbox' });
    return h('div', { class: 'line' }, f, h('label', { class: 'check' }, dice, 'dice'), h('button', { onclick: () => test(f.value, o, dice.checked) }, t('validate')), o); })();
  const raw = h('textarea', { class: 'code', rows: 12, spellcheck: 'false' }, JSON.stringify(draft, null, 2));
  const save = guard(async () => { const r = await api('PUT', '/system', draft); S.system = r; S.draft = structuredClone(r); toast(t('saved'), false); await loadState(); renderAll(); });
  const tierRows = Object.entries(draft.knowledgeTiers).map(([k, v]) => h('div', { class: 'line' }, t('tier'),
    h('input', { type: 'number', class: 'n', value: k, onchange: (e) => { delete draft.knowledgeTiers[k]; draft.knowledgeTiers[Number(e.target.value) || 1] = v; renderPanel(); } }), '→',
    h('input', { type: 'number', class: 'n', value: v, onchange: (e) => { draft.knowledgeTiers[k] = Number(e.target.value) || 0; } }),
    h('button', { class: 'x', onclick: () => { delete draft.knowledgeTiers[k]; renderPanel(); } }, '×')));
  return h('div', { class: 'pad' }, systemLibrary(),
    h('div', { class: 'line' }, h('button', { class: 'primary', onclick: save }, t('save')),
      h('button', { onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await api('POST', '/system/reset'); S.draft = null; await loadState(); renderAll(); }) }, t('reset')),
      h('button', { onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })), download: `${draft.id || 'system'}.json` }); a.click(); } }, t('export')),
      h('label', { class: 'filebtn' }, t('import'), h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: guard(async (e) => { S.draft = JSON.parse(await e.target.files[0].text()); renderPanel(); }) }))),
    sec(t('formulaTest'), tester),
    sec(t('statsEditor'), h('p', { class: 'hint' }, t('idHint')),
      draft.stats.map((s, i) => h('div', { class: 'formula-row' }, h('div', { class: 'line' }, txt(s, 'label', { class: 'grow' }), txt(s, 'id', { class: 'code idf' }), delBtn(draft.stats, i, draft.stats.length < 2)), aliasField(s))),
      addBtn(draft.stats, { id: 'new_stat', label: 'Stat', aliases: [] })),
    sec(t('charRules'), h('div', { class: 'line' }, h('label', {}, t('baseStat'), numf(draft.character, 'baseStat')), h('label', {}, t('startPoints'), numf(draft.character, 'startPoints')), h('label', {}, t('startMax'), numf(draft.character, 'startMaxStat'))),
      h('div', { class: 'line' }, t('spellStats'), txt(draft.spells, 'armedStat', { class: 'code idf' }), txt(draft.spells, 'unarmedStat', { class: 'code idf' }))),
    sec(t('derived'), draft.derived.map((d, i) => formulaRow(draft.derived, d, i, false, REQUIRED.includes(d.id))), addBtn(draft.derived, { id: 'new_value', label: 'Value', aliases: [], formula: '0' })),
    sec(t('quick'), draft.quickRolls.map((q, i) => formulaRow(draft.quickRolls, q, i, true, false)), addBtn(draft.quickRolls, { id: 'new_roll', label: 'Roll', formula: '1d20' })),
    sec(t('rollTypes'), draft.rollTypes.map((r, i) => h('div', { class: 'formula-row' },
      h('div', { class: 'line' }, txt(r, 'label', { class: 'grow' }), txt(r, 'id', { class: 'code idf' }), delBtn(draft.rollTypes, i, false)),
      h('div', { class: 'line' },
        (() => { const s = h('select', { onchange: (e) => { r.kind = e.target.value; if (r.kind === 'damage' && !r.dtype) r.dtype = 'physical'; renderPanel(); } }, ['damage', 'heal', 'theal', 'mana', 'generic'].map((k) => h('option', { value: k }, k))); s.value = r.kind; return s; })(),
        r.kind === 'damage' && (() => { const s = h('select', { onchange: (e) => { r.dtype = e.target.value; } }, ['physical', 'magical', 'true'].map((k) => h('option', { value: k }, k))); s.value = r.dtype ?? 'physical'; return s; })(),
        aliasField(r)))),
      addBtn(draft.rollTypes, { id: 'new_type', kind: 'generic', label: 'Roll', aliases: [] })),
    sec(t('tiers'), tierRows, h('button', { class: 'add', onclick: () => { draft.knowledgeTiers[Math.max(0, ...Object.keys(draft.knowledgeTiers).map(Number)) + 1] = -1; renderPanel(); } }, '+ ' + t('add'))),
    sec(t('rulesText'),
      draft.rules.map((r, i) => h('details', {}, h('summary', {}, r.title || '…'),
        h('input', { type: 'text', value: r.title, oninput: (e) => { r.title = e.target.value; } }),
        h('textarea', { rows: 8, oninput: (e) => { r.body = e.target.value; } }, r.body),
        h('button', { class: 'danger', onclick: () => { draft.rules.splice(i, 1); renderPanel(); } }, t('del')))),
      addBtn(draft.rules, { title: '…', body: '' })),
    sec(t('rawJson'), raw, h('button', { onclick: guard(() => { S.draft = JSON.parse(raw.value); renderPanel(); }) }, t('validate'))));
}

boot().catch((e) => { app.textContent = e.message; });
