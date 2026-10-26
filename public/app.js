import { h, $, $$, api, upload, toast, debounce, t, setLang, getLang, inline, markdown, setKnownRollTypes } from './lib.js';
import { createMap } from './map.js';
import { createAudio } from './audio.js';

const S = {
  me: null, users: [], system: null, scene: null, scenes: [], tokens: [], actors: [], chat: [], invite: null,
  tab: 'chat', sheetId: null, selected: new Set(), rollMod: '', draft: null,
  sounds: [], playing: [], journals: [], compendium: [], timeOffset: 0, viewId: null, tool: { name: 'select', radius: 6 }, playerView: false,
  journalId: null, journalEdit: false, modal: null, audioBlocked: false,
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
let map, dockEl, panelEl, chatEl, chatList, chatInput, chatWho, inspectorEl, hudEl, topEl, footEl, audio, editQueue = Promise.resolve();

// ------------------------------------------------------------------ boot & auth
async function boot() {
  const me = await api('GET', '/me');
  if (!me.user) return showAuth(me.firstRun);
  S.me = me.user;
  await loadState();
  buildShell();
  connect();
}

function showAuth(firstRun) {
  let register = firstRun;
  const draw = () => {
    const name = h('input', { type: 'text', placeholder: t('name'), autocomplete: 'username' });
    const pw = h('input', { type: 'password', placeholder: t('password'), autocomplete: register ? 'new-password' : 'current-password' });
    const inv = h('input', { type: 'text', placeholder: t('invite') });
    const go = guard(async () => { await api('POST', register ? '/register' : '/login', { name: name.value, password: pw.value, invite: inv.value }); boot(); });
    app.replaceChildren(h('main', { class: 'auth' },
      h('h1', {}, 'Foxyverse VTT'),
      firstRun && h('p', { class: 'hint' }, t('firstRun')),
      h('div', { class: 'auth-form' }, name, pw, register && !firstRun && inv,
        h('button', { class: 'primary', onclick: go }, register ? t('create') : t('signIn')),
        !firstRun && h('button', { class: 'link', onclick: () => { register = !register; draw(); } }, register ? t('haveAccount') : t('needAccount'))),
    ));
    [name, pw, inv].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
    name.focus();
  };
  draw();
}

async function loadState() {
  const st = await api('GET', '/state');
  Object.assign(S, { me: st.me, users: st.users, system: st.system, scene: st.scene, scenes: st.scenes, tokens: st.tokens, actors: st.actors, chat: st.chat, invite: st.invite ?? null,
    sounds: st.sounds, playing: st.playing, journals: st.journals, compendium: st.compendium, timeOffset: st.serverTime - Date.now() });
  if (st.me.role === 'gm' && !S.scenes.some((x) => x.id === S.viewId)) S.viewId = st.scene?.id ?? S.scenes[0]?.id ?? null;
  if (audio) { audio.stopAll(); audio.sync(S.playing, S.sounds); }
  setKnownRollTypes(S.system);
  if (S.actorId && !actorById(S.actorId)) S.actorId = null;
  if (!S.actorId && S.actors.length === 1) S.actorId = S.actors[0].id;
  if (S.sheetId && !actorById(S.sheetId)) S.sheetId = null;
}

// ------------------------------------------------------------------ realtime
let opened = false;
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { if (opened) loadState().then(renderAll).catch(() => {}); opened = true; };
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
}
const pending = new Set(); // actor ids with unsaved local edits
function onEvent(ev) {
  const { type, op, data, by } = ev;
  if (type === 'refresh') return loadState().then(renderAll);
  if (type === 'user') { upsert(S.users, data); if (S.tab === 'table') renderPanel(); return; }
  if (type === 'scene') {
    if (editsPending) return; // our own queued edits are newer than this echo
    replaceScene(data); if (S.tab === 'table') renderPanel(); return;
  }
  if (type === 'token') {
    if (by === S.me.id) return; // we are the source; our local copy is authoritative
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
    if (S.tab === 'comp') renderPanel(); return;
  }
  if (type === 'actor') {
    if (op === 'delete') { remove(S.actors, data.id); if (S.sheetId === data.id) S.sheetId = null; renderAll(); return; }
    if (by === S.me.id && pending.has(data.id)) return;
    const had = actorById(data.id); upsert(S.actors, data);
    if (!had) { if (!S.actorId) S.actorId = data.id; renderAll(); return; }
    map.redraw(); renderChatWho();
    if (S.tab === 'sheets' && S.sheetId === data.id) { if (panelEl.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) patchComputed(data); else renderPanel(); }
    return;
  }
  if (type === 'chat') {
    if (op === 'delete') remove(S.chat, data.id); else upsert(S.chat, data);
    if (S.chat.length > 300) S.chat.splice(0, S.chat.length - 300);
    renderChat();
  }
}

// ------------------------------------------------------------------ shell
// The GM can look at (and prepare) any scene; players only ever see the active one.
const viewScene = () => (isGM() ? S.scenes.find((s) => s.id === S.viewId) ?? S.scene : S.scene);
const viewTokens = () => { const sc = viewScene(); return sc ? S.tokens.filter((t) => t.sceneId === sc.id) : []; };
const isPlayerToken = (tok) => {
  const a = tok.actorId && actorById(tok.actorId);
  if (!a) return false;
  return isGM() ? userById(a.ownerId)?.role === 'player' : a.ownerId === S.me.id;
};
let editsPending = 0;
function replaceScene(r) {
  if (isGM()) upsert(S.scenes, r);
  if (r.active || S.scene?.id === r.id) S.scene = r;
  map.redraw(); renderHud();
}
/** Optimistic scene edit: consecutive wall clicks must see each other, so apply locally first and queue the saves in order. */
function sceneEdit(patch) {
  const sc = viewScene(); if (!sc) return Promise.resolve();
  Object.assign(sc, patch); map.redraw(); editsPending++;
  editQueue = editQueue
    .then(() => api('PATCH', '/scenes/' + sc.id, patch))
    .then((r) => { if (--editsPending === 0) replaceScene(r); })
    .catch((e) => { editsPending = Math.max(0, editsPending - 1); toast(e.message); });
  return editQueue;
}

function buildShell() {
  const canvas = h('canvas', { id: 'map' });
  inspectorEl = h('div', { class: 'inspector hidden' });
  hudEl = h('div', { class: 'hud' }); topEl = h('div', { class: 'hud-top' });
  const stage = h('div', { id: 'stage' }, canvas, inspectorEl, topEl, hudEl);
  dockEl = h('aside', { id: 'dock' });
  panelEl = h('section', { id: 'panel' });
  footEl = h('div', { class: 'dock-foot' });
  app.replaceChildren(h('div', { id: 'layout' }, stage, dockEl));
  audio = createAudio({ getOffset: () => S.timeOffset, onBlocked: () => { if (!S.audioBlocked) { S.audioBlocked = true; renderFoot(); } } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modal) { S.modal = null; renderModal(); } });
  document.addEventListener('click', () => { if (S.audioBlocked) { S.audioBlocked = false; audio.unlock(); renderFoot(); } });
  map = createMap(canvas, {
    state: () => {
      const sc = viewScene(), tokens = viewTokens();
      return {
        scene: sc, tokens, selected: S.selected, tool: S.tool, gm: isGM(), playerView: S.playerView,
        viewers: tokens.filter(isPlayerToken).map((x) => ({ x: x.x, y: x.y, vision: x.vision })),
        lights: [...(sc?.lights ?? []), ...tokens.filter((x) => x.light > 0 && !x.hidden).map((x) => ({ x: x.x, y: x.y, radius: x.light }))],
      };
    },
    canMove: (tok) => isGM() || (!!tok.actorId && actorById(tok.actorId)?.ownerId === S.me.id),
    isPlayerToken,
    hpRatio: (tok) => { const a = tok.actorId && actorById(tok.actorId); const max = a?.computed.derived.maxhp; return max ? a.data.hp.cur / max : null; },
    onSelect: (set) => { S.selected = set; renderInspector(); renderChat(); },
    onMove: (tok, x, y) => { api('PATCH', '/tokens/' + tok.id, { x, y }).catch(() => {}); },
    onOpen: (tok) => { if (tok.actorId && actorById(tok.actorId)) { S.tab = 'sheets'; S.sheetId = tok.actorId; renderAll(); } },
    onSceneEdit: sceneEdit,
  });
  buildChat();
  renderAll();
  audio.sync(S.playing, S.sounds);
}
function renderAll() { renderDock(); renderChat(); renderChatWho(); renderInspector(); renderHud(); map?.redraw(); }

const TOOL_HINT = {
  fr: { wall: 'Clic : poser un point · clic droit ou Échap : finir · Alt : sans aimant', door: 'Clic : poser une porte · clic sur une porte : ouvrir / fermer', light: 'Clic : poser une lumière', reveal: 'Glisser : révéler une zone en permanence', erase: 'Clic : supprimer mur, lumière ou zone' },
  en: { wall: 'Click to add points · right-click or Esc to finish · Alt: no snapping', door: 'Click to place a door · click a door to open / close it', light: 'Click to place a light', reveal: 'Drag to permanently reveal an area', erase: 'Click to delete a wall, light or area' },
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
  add(topEl, S.scenes.length ? sel : null,
    sc && !sc.active && h('button', { class: 'primary', onclick: guard(() => api('POST', `/scenes/${sc.id}/activate`)) }, t('activate')),
    sc && flag(t('fog'), sc.fog, (v) => { sceneEdit({ fog: v }); renderHud(); }),
    sc && flag(t('dark'), sc.dark, (v) => sceneEdit({ dark: v })),
    sc?.fog && flag(t('playerView'), S.playerView, (v) => { S.playerView = v; map.redraw(); }));
  if (!sc) return;
  const tools = [['select', 'toolSelect'], ['wall', 'toolWall'], ['door', 'toolDoor'], ['light', 'toolLight'], ['reveal', 'toolReveal'], ['erase', 'toolErase']];
  add(hudEl, h('div', { class: 'tools' },
    tools.map(([id, key]) => h('button', { class: S.tool.name === id ? 'on' : '', onclick: () => { S.tool.name = id; map.cancel(); renderHud(); } }, t(key))),
    S.tool.name === 'light' && h('label', {}, t('radius'), h('input', { type: 'number', class: 'n', min: 1, max: 100, value: S.tool.radius, oninput: (e) => { S.tool.radius = Number(e.target.value) || 6; } }))),
    TOOL_HINT[getLang()]?.[S.tool.name] && h('div', { class: 'hint tool-hint' }, TOOL_HINT[getLang()][S.tool.name]));
}

function renderFoot() {
  fill(footEl,
    h('button', { class: 'quiet' + (audio.isMuted() ? ' on' : ''), title: t('mute'), onclick: () => { audio.setMuted(!audio.isMuted()); renderFoot(); } }, audio.isMuted() ? t('mute') : '♪'),
    h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: audio.getMaster(), title: t('volume'), oninput: (e) => audio.setMaster(Number(e.target.value)) }),
    S.audioBlocked && h('button', { class: 'primary', onclick: () => { S.audioBlocked = false; audio.unlock(); renderFoot(); } }, t('unlock')),
    h('span', { class: 'spacer' }),
    h('button', { class: 'quiet', title: 'FR / EN', onclick: () => { setLang(getLang() === 'fr' ? 'en' : 'fr'); location.reload(); } }, getLang().toUpperCase()),
    h('button', { class: 'quiet', title: S.me.name, onclick: guard(async () => { await api('POST', '/logout'); location.reload(); }) }, t('logout')));
}

function renderDock() {
  const tabs = [['chat', t('chat')], ['sheets', t('sheets')], ['journal', t('journal')], ['rules', t('rules')],
    ...(isGM() ? [['table', t('table')], ['sound', t('sound')], ['comp', t('compendium')], ['system', t('system')]] : [])];
  fill(dockEl,
    h('nav', { class: 'tabs' }, tabs.map(([id, label]) => h('button', { class: S.tab === id ? 'on' : '', onclick: () => { S.tab = id; if (id === 'system') S.draft = structuredClone(S.system); renderDock(); } }, label))),
    panelEl, footEl);
  renderPanel(); renderFoot();
}
function renderPanel() {
  const panels = { chat: () => chatEl, sheets: sheetsPanel, journal: journalPanel, rules: rulesPanel, table: tablePanel, sound: soundPanel, comp: compPanel, system: systemPanel };
  panelEl.className = 'panel-' + S.tab;
  panelEl.replaceChildren((panels[S.tab] ?? panels.chat)());
  if (S.tab === 'chat') { chatList.scrollTop = chatList.scrollHeight; }
}

// ------------------------------------------------------------------ chat
function buildChat() {
  chatList = h('div', { class: 'chat-list' });
  chatWho = h('select', { class: 'who', title: t('speakingAs'), onchange: (e) => { S.actorId = Number(e.target.value) || null; localStorage.setItem('speakAs', S.actorId ?? ''); } });
  chatInput = h('input', { type: 'text', class: 'chat-input', placeholder: t('chatHint'), maxlength: 2000 });
  const hist = []; let hi = 0;
  chatInput.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowUp' && hist.length) { hi = Math.max(0, hi - 1); chatInput.value = hist[hi]; e.preventDefault(); }
    if (e.key !== 'Enter' || !chatInput.value.trim()) return;
    const text = chatInput.value.trim(); hist.push(text); hi = hist.length; chatInput.value = '';
    await doRoll(text);
  });
  chatEl = h('div', { class: 'chat' }, chatList, h('div', { class: 'chat-bar' }, chatWho, chatInput));
}
function renderChatWho() {
  chatWho.replaceChildren(h('option', { value: '' }, t('noChar')), ...S.actors.map((a) => h('option', { value: a.id }, a.name)));
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
function msgNode(m) {
  const b = m.body, u = userById(m.userId), del = isGM() && h('button', { class: 'x', title: t('del'), onclick: guard(() => api('DELETE', '/chat/' + m.id)) }, '×');
  if (b.t === 'info') return h('div', { class: 'msg info' }, b.text, del);
  if (b.t === 'text') return h('div', { class: 'msg' }, h('b', { style: `color:${u?.color ?? '#eba5ff'}` }, m.userName), m.whisper && h('em', { class: 'whisper' }, ' → ' + t('gm')), ' ', inline(b.text, (c) => doRoll(c)), del);
  return rollCard(m, b, del);
}
function rollCard(m, b, del) {
  const mine = m.userId === S.me.id, ownsActor = m.actorId && actorById(m.actorId)?.ownerId === S.me.id;
  const check = b.kind === 'stat';
  return h('div', { class: 'msg roll' },
    h('div', { class: 'roll-head' },
      h('span', {}, h('b', {}, b.actorName), ' · ', b.label || b.title, m.whisper && h('em', { class: 'whisper' }, ' → ' + t('gm'))),
      del),
    h('div', { class: 'formula' }, `${b.count > 1 ? b.count + '× ' : ''}${b.formula}${b.rerolls ? ` · ↻${b.rerolls}` : ''}`),
    b.results.map((r) => h('div', { class: 'res ' + (r.outcome ?? '') },
      h('span', { class: 'dice' }, r.dice.filter((d) => d.results.length).map((d) => h('span', { class: 'dgroup', title: `${d.count}d${d.faces}` }, d.results.map((v) => h('span', { class: 'die' + (d.faces === 20 && (v === 1 || v === 20) ? (v === 1 ? ' nat1' : ' nat20') : '') }, v))))),
      h('span', { class: 'total' }, r.total),
      r.target != null && h('span', { class: 'target' }, (check ? '≤ ' : '/ ') + r.target),
      r.outcome && h('span', { class: 'badge ' + r.outcome }, t(r.outcome)))),
    b.count > 1 && h('div', { class: 'sum' }, 'Σ ', b.sum),
    h('div', { class: 'roll-actions' },
      (mine || isGM()) && h('button', { onclick: guard(() => api('POST', `/chat/${m.id}/reroll`)) }, '↻ ' + t('reroll')),
      ['damage', 'heal', 'theal', 'mana'].includes(b.kind) && (isGM() || (ownsActor && b.kind !== 'damage')) && h('button', { class: 'primary', onclick: applyRoll(m) }, t('apply') + (S.selected.size && isGM() ? ` (${S.selected.size})` : ''))),
    (b.applied ?? []).map((a) => h('div', { class: 'applied' }, `${a.name}: `, appliedText(a))));
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
const saveActor = (a) => { pending.add(a.id); clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow(a), 350); };
const saveNow = guard(async (a) => {
  clearTimeout(saveTimer);
  const res = await api('PATCH', '/actors/' + a.id, { name: a.name, data: a.data });
  for (const k of ['talents', 'spells', 'items']) a.data[k].forEach((x, i) => { if (!x.id) x.id = res.data[k][i]?.id ?? ''; });
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
    h('button', { class: 'primary wide', onclick: guard(async () => { const r = await api('POST', '/actors', { name: t('newChar') }); upsert(S.actors, r); S.actorId = r.id; S.sheetId = r.id; renderAll(); }) }, '+ ' + t('newChar')),
    !S.actors.length && h('p', { class: 'hint' }, t('empty')),
    h('ul', { class: 'list' }, S.actors.map((x) => h('li', {}, h('button', { class: 'row', onclick: () => { S.sheetId = x.id; renderPanel(); } },
      h('b', {}, x.name), h('span', { class: 'dim' }, ` ${t('level')} ${x.data.bio.level}${isGM() ? ' · ' + (userById(x.ownerId)?.name ?? '—') : ''}`),
      h('span', { class: 'dim right' }, `${x.data.hp.cur}/${x.computed.derived.maxhp} ${t('hp')}`))))));
}

const compBtn = (kind, entry) => isGM() && h('button', { class: 'x', title: t('toComp'), onclick: guard(async () => { await api('POST', '/compendium', { kind, name: entry.name || '…', data: entry }); toast(t('saved'), false); }) }, '⇪');
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
      h('label', { class: 'avatar', title: t('portrait') }, d.portrait ? h('img', { src: d.portrait, alt: '' }) : '+',
        h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async (e) => { const f = e.target.files[0]; if (!f) return; d.portrait = await upload(f); saveActor(a); renderPanel(); }) })),
      field(a, a, 'name', 'text', { class: 'title grow' })),
    h('div', { class: 'grid2' },
      h('label', {}, t('cls'), field(a, d.bio, 'class')), h('label', {}, t('element'), field(a, d.bio, 'element')),
      h('label', {}, t('level'), field(a, d.bio, 'level', 'int', { min: 1, class: 'n' })),
      h('label', { class: 'check' }, field(a, d, 'elemental', 'bool'), t('elemental'))));

  const res = section(t('hp') + ' / ' + t('mp') + ' / ' + t('fav'), h('div', { class: 'res-grid' },
    h('label', {}, t('hp'), num(d.hp, 'cur', -9999), ' / ', C(a, 'derived.maxhp')),
    h('label', {}, t('temp'), num(d.hp, 'temp')),
    h('label', {}, t('mp'), num(d.mp, 'cur'), ' / ', C(a, 'derived.maxmp')),
    h('label', {}, t('fav'), num(d.fav, 'cur'), ' / ', C(a, 'derived.maxfav')),
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

  const tierText = (n) => { const v = sys.knowledgeTiers[n]; return v == null ? '' : v > 0 ? `+${v}` : String(v); };
  const talents = section(t('talents'), h('div', {}, d.talents.map((tl, i) => h('div', { class: 'line' },
    field(a, tl, 'name', 'text', { class: 'grow' }),
    (() => { const sel = h('select', { onchange: (e) => { tl.tier = Number(e.target.value); saveActor(a); renderPanel(); } }, Object.keys(sys.knowledgeTiers).map((k) => h('option', { value: k }, `${t('tier')} ${k} (${tierText(k)})`))); sel.value = tl.tier; return sel; })(),
    field(a, tl, 'enabled', 'bool'),
    h('button', { title: t('use'), onclick: () => { S.rollMod = tierText(tl.tier); modInput.value = S.rollMod; } }, t('use')),
    compBtn('talent', tl), h('button', { class: 'x', onclick: () => { d.talents.splice(i, 1); saveActor(a); renderPanel(); } }, '×'))),
  h('p', { class: 'hint' }, d.talents.length >= 4 ? '4 max.' : '')),
  h('div', { class: 'addrow' }, h('button', { class: 'add', onclick: () => { d.talents.push({ id: '', name: '', tier: 1, enabled: true }); saveActor(a); renderPanel(); } }, '+ ' + t('add')), compPick('talent', (e) => { d.talents.push({ ...e, id: '' }); saveActor(a); renderPanel(); })));

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
    field(a, sp, 'effect', 'area', { rows: 2, placeholder: t('effect') })))),
  h('div', { class: 'addrow' }, h('button', { class: 'add', onclick: () => { d.spells.push({ id: '', name: '', effect: '', cost: 1, costType: 'mp', armed: false, continuous: false }); saveActor(a); renderPanel(); } }, '+ ' + t('add')), compPick('spell', (e) => { d.spells.push({ ...e, id: '' }); saveActor(a); renderPanel(); })));

  const bonusText = (b) => Object.entries(b).map(([id, v]) => `${sys.stats.find((s) => s.id === id)?.aliases[0] ?? id}${v >= 0 ? '+' : ''}${v}`).join(' ');
  const items = section(t('items'), h('div', {}, d.items.map((it, i) => h('div', { class: 'item' },
    h('div', { class: 'line' }, field(a, it, 'name', 'text', { class: 'grow' }),
      (() => { const sel = h('select', { onchange: (e) => { it.type = e.target.value; saveActor(a); } }, ['weapon', 'armor', 'consumable', 'bag', 'other'].map((k) => h('option', { value: k }, k))); sel.value = it.type; return sel; })(),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: it.equipped, onchange: (e) => { it.equipped = e.target.checked; saveActor(a); } }), t('equipped')),
      compBtn('item', it), h('button', { class: 'x', onclick: () => { d.items.splice(i, 1); saveActor(a); renderPanel(); } }, '×')),
    h('div', { class: 'line' }, h('label', {}, t('qty'), field(a, it, 'qty', 'int', { min: 0, class: 'n' })), h('label', {}, t('defP'), field(a, it, 'pdef', 'int', { min: 0, class: 'n' })), h('label', {}, t('defM'), field(a, it, 'mdef', 'int', { min: 0, class: 'n' })),
      h('input', { type: 'text', class: 'grow', placeholder: t('bonuses'), value: bonusText(it.bonuses), onchange: (e) => {
        const next = {}; for (const m of e.target.value.matchAll(/([\p{L}_]+)\s*([+-]\s*\d+)/gu)) { const id = idx.get(m[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()); if (id) next[id] = Number(m[2].replace(/\s/g, '')); }
        it.bonuses = next; e.target.value = bonusText(next); saveActor(a);
      } }))))),
  h('div', { class: 'addrow' }, h('button', { class: 'add', onclick: () => { d.items.push({ id: '', name: '', type: 'other', equipped: false, qty: 1, bonuses: {}, pdef: 0, mdef: 0, notes: '' }); saveActor(a); renderPanel(); } }, '+ ' + t('add')), compPick('item', (e) => { d.items.push({ ...e, id: '' }); saveActor(a); renderPanel(); })));

  const money = section(t('currency'), h('div', { class: 'line' }, ['pc', 'pa', 'po'].map((k) => h('label', {}, k.toUpperCase(), field(a, d.currency, k, 'int', { min: 0, class: 'n wide' })))));
  const notes = section(t('notes'), field(a, d, 'notes', 'area', { rows: 6 }));
  const gm = isGM() && section('GM', h('div', { class: 'line' },
    (() => { const sel = h('select', { onchange: guard(async (e) => { const r = await api('PATCH', '/actors/' + a.id, { ownerId: e.target.value ? Number(e.target.value) : null }); upsert(S.actors, r); }) }, h('option', { value: '' }, t('none')), S.users.map((u) => h('option', { value: u.id }, u.name))); sel.value = a.ownerId ?? ''; return sel; })(),
    viewScene() && h('button', { onclick: guard(async () => { const c = map.viewCenter(); await api('POST', '/tokens', { sceneId: viewScene().id, actorId: a.id, name: a.name, x: Math.round(c.x), y: Math.round(c.y) }); toast(t('saved'), false); await loadState(); map.redraw(); }) }, t('placeToken')),
    h('button', { onclick: guard(async () => { await api('POST', '/compendium', { kind: 'actor', name: a.name, data: a.data }); toast(t('saved'), false); }) }, t('template')),
    h('button', { class: 'danger', onclick: guard(async () => { if (!confirm(t('confirmDel'))) return; await api('DELETE', '/actors/' + a.id); }) }, t('del'))));
  return h('div', { class: 'sheet pad' }, head, res, stats, talents, spells, items, money, notes, gm);
}

// ------------------------------------------------------------------ rules
function rulesPanel() {
  return h('div', { class: 'pad' }, S.system.rules.map((r, i) => h('details', { open: i === 0 }, h('summary', {}, r.title), markdown(r.body, (c) => { S.tab = 'chat'; renderDock(); doRoll(c); }))));
}

// ------------------------------------------------------------------ table (GM)
function imageSize(file) {
  return new Promise((res, rej) => { const u = URL.createObjectURL(file), i = new Image(); i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(u); }; i.onerror = rej; i.src = u; });
}
function tablePanel() {
  const sc = viewScene();
  const nameIn = h('input', { type: 'text', placeholder: t('newScene') });
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  const create = guard(async () => {
    const f = fileIn.files[0]; let body = { name: nameIn.value || t('newScene') };
    if (f) { const [url, dim] = await Promise.all([upload(f), imageSize(f)]); body = { ...body, image: url, width: dim.w, height: dim.h }; }
    const r = await api('POST', '/scenes', body);
    S.viewId = r.id; await loadState(); renderAll();
  });
  const sceneField = (key, label) => h('label', {}, label, h('input', { type: 'number', class: 'n', value: sc[key], onchange: (e) => sceneEdit({ [key]: Number(e.target.value) }) }));
  const tokName = h('input', { type: 'text', placeholder: t('tokenName') });
  return h('div', { class: 'pad' },
    h('section', { class: 'sec' }, h('h3', {}, t('scenes')),
      h('ul', { class: 'list' }, S.scenes.map((s) => h('li', { class: 'line' },
        h('button', { class: 'row grow' + (s.id === S.viewId ? ' on' : ''), title: t('view'), onclick: () => { S.viewId = s.id; S.selected = new Set(); renderAll(); } }, h('b', {}, s.name)),
        s.active ? h('span', { class: 'badge success' }, t('active')) : h('button', { onclick: guard(() => api('POST', `/scenes/${s.id}/activate`)) }, t('activate')),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (confirm(t('confirmDel'))) await api('DELETE', '/scenes/' + s.id); }) }, '×')))),
      h('div', { class: 'line' }, nameIn, fileIn), h('button', { class: 'primary', onclick: create }, '+ ' + t('newScene'))),
    sc && h('section', { class: 'sec' }, h('h3', {}, sc.name),
      h('div', { class: 'line' }, sceneField('grid', t('grid')), sceneField('ox', 'X'), sceneField('oy', 'Y')),
      h('div', { class: 'line' },
        h('button', { onclick: () => confirm(t('confirmDel')) && sceneEdit({ walls: [] }) }, t('clearWalls')),
        h('button', { onclick: () => confirm(t('confirmDel')) && sceneEdit({ lights: [] }) }, t('clearLights')),
        h('button', { onclick: () => sceneEdit({ reveal: [] }) }, t('clearReveal'))),
      h('label', {}, t('mapImage'), h('input', { type: 'file', accept: 'image/*', onchange: guard(async (e) => { const f = e.target.files[0]; if (!f) return; const [url, dim] = await Promise.all([upload(f), imageSize(f)]); sceneEdit({ image: url, width: dim.w, height: dim.h }); }) })),
      h('div', { class: 'line' }, tokName, h('button', { onclick: guard(async () => { const c = map.viewCenter(); await api('POST', '/tokens', { sceneId: sc.id, name: tokName.value || 'Token', x: Math.round(c.x), y: Math.round(c.y) }); await loadState(); map.redraw(); }) }, t('addToken')))),
    h('section', { class: 'sec' }, h('h3', {}, t('players')),
      S.users.map((u) => h('div', { class: 'line' }, h('b', { style: `color:${u.color}`, class: 'grow' }, u.name),
        (() => { const sel = h('select', { onchange: guard(async (e) => { await api('PATCH', '/users/' + u.id, { role: e.target.value }); }) }, h('option', { value: 'gm' }, t('gm')), h('option', { value: 'player' }, t('player'))); sel.value = u.role; return sel; })())),
      S.invite && h('div', { class: 'line' }, h('span', {}, t('inviteCode') + ': '), h('code', {}, S.invite.code),
        !S.invite.fromEnv && h('button', { onclick: guard(async () => { S.invite = { ...S.invite, ...(await api('POST', '/invite/regenerate')) }; renderPanel(); }) }, t('regen')))));
}

// ------------------------------------------------------------------ token inspector (GM)
function renderInspector() {
  const tok = isGM() && S.selected.size === 1 ? S.tokens.find((x) => x.id === [...S.selected][0]) : null;
  inspectorEl.classList.toggle('hidden', !tok);
  if (!tok) return inspectorEl.replaceChildren();
  const patch = guard(async (body) => { const r = await api('PATCH', '/tokens/' + tok.id, body); Object.assign(tok, r); map.redraw(); });
  const sizeSel = h('select', { onchange: (e) => patch({ size: Number(e.target.value) }) }, [0.5, 1, 2, 3, 4, 6].map((v) => h('option', { value: v }, v))); sizeSel.value = tok.size;
  const actorSel = h('select', { onchange: (e) => patch({ actorId: e.target.value ? Number(e.target.value) : null }) }, h('option', { value: '' }, t('none')), S.actors.map((a) => h('option', { value: a.id }, a.name))); actorSel.value = tok.actorId ?? '';
  const cells = (key, label) => h('label', {}, label, h('input', { type: 'number', class: 'n', min: 0, step: 0.5, value: tok[key], onchange: (e) => patch({ [key]: Number(e.target.value) || 0 }) }));
  fill(inspectorEl,
    h('input', { type: 'text', value: tok.name, onchange: (e) => patch({ name: e.target.value }) }),
    h('label', {}, t('size'), sizeSel), h('label', {}, t('linked'), actorSel), cells('vision', t('vision')), cells('light', t('light')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: tok.hidden, onchange: (e) => patch({ hidden: e.target.checked }) }), t('hidden')),
    h('input', { type: 'color', value: tok.color, onchange: (e) => patch({ color: e.target.value }) }),
    h('label', {}, t('tokenImage'), h('input', { type: 'file', accept: 'image/*', onchange: guard(async (e) => { const f = e.target.files[0]; if (f) patch({ image: await upload(f) }); }) })),
    h('button', { class: 'danger', onclick: guard(async () => { await api('DELETE', '/tokens/' + tok.id); remove(S.tokens, tok.id); S.selected = new Set(); renderInspector(); map.redraw(); }) }, t('del')));
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
    markdown(j.body, (c) => { S.modal = null; renderModal(); S.tab = 'chat'; renderDock(); doRoll(c); }));
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
const KIND_LABEL = () => ({ item: t('items'), spell: t('spells'), talent: t('talents'), actor: 'NPC' });
function compPanel() {
  const labels = KIND_LABEL();
  return h('div', { class: 'pad' }, h('p', { class: 'hint' }, getLang() === 'fr' ? 'Ajoutez des entrées depuis une fiche (⇪) ; les joueurs peuvent les copier sur leur fiche.' : 'Add entries from a sheet (⇪); players can copy them onto their sheets.'),
    Object.keys(labels).map((kind) => h('section', { class: 'sec' }, h('h3', {}, labels[kind]),
      S.compendium.filter((c) => c.kind === kind).map((c) => h('div', { class: 'line' },
        h('input', { type: 'text', class: 'grow', value: c.name, onchange: guard((e) => api('PATCH', '/compendium/' + c.id, { name: e.target.value })) }),
        kind === 'actor' && h('button', { class: 'primary', onclick: guard(async () => { const sc = viewScene(), ctr = map.viewCenter(); await api('POST', `/compendium/${c.id}/instantiate`, { sceneId: sc?.id, x: Math.round(ctr.x), y: Math.round(ctr.y) }); await loadState(); renderAll(); toast(t('saved'), false); }) }, t('instantiate')),
        h('button', { class: 'x', title: t('del'), onclick: guard(async () => { if (confirm(t('confirmDel'))) await api('DELETE', '/compendium/' + c.id); }) }, '×'))))));
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
  return h('div', { class: 'pad' },
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
