// Inventory & equipment: item sections, the equipment silhouette (slots from the Foxyverse plugin), slot picker and expression editor.
import { h, t, getLang } from './lib.js';
import { evalEquipSlotsExpr, CANONICAL_SLOTS, slotLabel } from './slots.js';

const SECTIONS = [['weapon', 'invWeapons'], ['armor', 'invArmor'], ['consumable', 'invConsumable'], ['bag', 'invBag'], ['other', 'invOther']];
const WEAPON_SLOTS = ['weapon1', 'weapon2', 'weapon3'];

// ---------------------------------------------------------------- icons (plugin SVGs, recoloured to the theme)
const iconCache = new Map();
function iconText(name) {
  if (!iconCache.has(name)) iconCache.set(name, fetch(`/icons/Icons_${name}.svg`).then((r) => r.text()).then((x) => x.replace(/#4b002c|#ffdbff/gi, 'currentColor')).catch(() => ''));
  return iconCache.get(name);
}
function svgFrom(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  return doc.documentElement.nodeName === 'svg' ? document.importNode(doc.documentElement, true) : null;
}
/** An inline icon that fills itself in once the file is loaded. */
export function icon(name, cls = 'ico') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  iconText(name).then((txt) => { const svg = txt && svgFrom(txt); if (svg) { svg.removeAttribute('id'); span.replaceChildren(svg); } });
  return span;
}

// ---------------------------------------------------------------- tooltip + popover
let tip = null;
const hideTip = () => { if (tip) tip.style.display = 'none'; };
function showTip(e, text) {
  if (!tip) { tip = h('div', { class: 'slot-tip' }); document.body.append(tip); }
  tip.textContent = text; tip.style.display = 'block';
  tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14) + 'px'; tip.style.top = e.clientY + 16 + 'px';
}
let menuEl = null;
function closeMenu() { menuEl?.remove(); menuEl = null; }
function openMenu(e, title, entries) {
  closeMenu(); hideTip();
  menuEl = h('div', { class: 'slot-menu' }, h('div', { class: 'slot-menu-title' }, title),
    entries.length ? entries.map((en) => h('button', { onclick: () => { closeMenu(); en.run(); } }, en.label)) : h('div', { class: 'dim pad-s' }, t('noFit')));
  document.body.append(menuEl);
  menuEl.style.left = Math.min(window.innerWidth - menuEl.offsetWidth - 8, e.clientX) + 'px'; menuEl.style.top = Math.min(window.innerHeight - menuEl.offsetHeight - 8, e.clientY) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!menuEl?.contains(ev.target)) { closeMenu(); document.removeEventListener('pointerdown', off); } }), 0);
}

/**
 * env: { a, S, field(a,obj,key,kind,attrs), saveActor(a), rerender(), compBtn(kind,entry), compPick(kind,cb), isGM }
 * Returns the whole inventory block (equipment panel + item sections).
 */
export function inventoryView(env) {
  const { a, S, field, saveActor, rerender, compBtn, compPick } = env;
  const d = a.data, sys = S.system, lang = getLang(), items = d.items;
  const label = (sl) => slotLabel(sl, lang);
  const ik = (it) => it._k || it.id;
  const owner = new Map(); // slot -> item currently using it
  for (const it of items) for (const sl of it.usedSlots || []) if (sl !== 'other') owner.set(sl, it);
  const optionsOf = (it) => evalEquipSlotsExpr(it.equipExpr || '').options;
  const free = (it, opt) => opt.every((sl) => !owner.has(sl) || owner.get(sl) === it);
  const equipTo = (it, slots) => { it.usedSlots = slots; saveActor(a); rerender(); };

  // ------------------------------------------------ equipment panel
  const weaponBtn = (sl) => {
    const it = owner.get(sl);
    return h('button', { type: 'button', class: 'weapon-slot' + (it ? ' equipped' : ''), 'data-slot': sl, 'aria-label': label(sl) }, icon('weapon', 'ico weapon-ico'));
  };
  const silhouette = h('div', { class: 'silhouette' });
  iconText('equipmentSlots').then((txt) => {
    const svg = txt && svgFrom(txt); if (!svg) return;
    svg.removeAttribute('id'); svg.setAttribute('class', 'sil-svg');
    for (const el of svg.querySelectorAll('[id]')) {
      const id = el.getAttribute('id'); if (!CANONICAL_SLOTS.includes(id)) continue;
      el.removeAttribute('id'); el.setAttribute('class', 'slot-part' + (owner.has(id) ? ' equipped' : '')); el.setAttribute('data-slot', id);
    }
    silhouette.replaceChildren(svg);
  });
  const others = items.filter((it) => (it.usedSlots || []).includes('other'));
  const equipPanel = h('section', { class: 'sec equip-panel' }, h('h3', {}, t('equipSlots')),
    h('div', { class: 'equip-wrap' }, h('div', { class: 'weapon-col' }, WEAPON_SLOTS.map(weaponBtn)), silhouette),
    others.length ? h('div', { class: 'other-chips' }, h('span', { class: 'dim' }, label('other') + ': '), others.map((it) => h('span', { class: 'chip', onclick: () => open(it) }, it.name || '…'))) : null);
  const tipText = (sl) => { const it = owner.get(sl); return it ? `${label(sl)} — ${it.name || '…'}` : `${label(sl)} (${t('emptySlot')})`; };
  equipPanel.addEventListener('pointermove', (e) => { const el = e.target.closest('[data-slot]'); if (el) showTip(e, tipText(el.dataset.slot)); else hideTip(); });
  equipPanel.addEventListener('pointerleave', hideTip);
  equipPanel.addEventListener('click', (e) => {
    const el = e.target.closest('[data-slot]'); if (!el) return;
    const sl = el.dataset.slot, it = owner.get(sl);
    if (it) return open(it);
    // empty slot: offer the unequipped items that can go there (smallest option containing the slot)
    const entries = [];
    for (const cand of items) {
      if ((cand.usedSlots || []).length) continue;
      const opt = optionsOf(cand).filter((o) => o.includes(sl) && free(cand, o)).sort((x, y) => x.length - y.length)[0];
      if (opt) entries.push({ label: `${cand.name || '…'} (${opt.map(label).join(' + ')})`, run: () => equipTo(cand, opt) });
    }
    openMenu(e, label(sl), entries);
  });
  function open(it) { S.openItems.add(ik(it)); rerender(); setTimeout(() => document.getElementById('inv-' + ik(it))?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30); }

  // ------------------------------------------------ item card
  const picker = (it) => {
    const opts = optionsOf(it), cur = (it.usedSlots || []).join('+');
    const optionEls = opts.map((o) => h('option', { value: o.join('+'), disabled: !free(it, o) }, o.map(label).join(' + ')));
    const extra = cur && cur !== 'other' && !opts.some((o) => o.join('+') === cur) ? [h('option', { value: cur }, it.usedSlots.map(label).join(' + '))] : []; // expression changed after equipping
    const sel = h('select', { class: 'slotpick', title: t('slots'), onchange: (e) => { const v = e.target.value; equipTo(it, v === '' ? [] : v.split('+')); } },
      h('option', { value: '' }, t('unequipped')), optionEls, extra, h('option', { value: 'other' }, label('other')));
    sel.value = cur;
    return sel;
  };
  const qty = (it) => h('span', { class: 'qty' },
    h('button', { class: 'x', type: 'button', onclick: () => { it.qty = Math.max(0, (it.qty || 0) - 1); saveActor(a); rerender(); } }, '−'),
    h('b', {}, it.qty ?? 1),
    h('button', { class: 'x', type: 'button', onclick: () => { it.qty = (it.qty || 0) + 1; saveActor(a); rerender(); } }, '+'));
  const statStrip = (it) => h('div', { class: 'strip' }, sys.stats.map((s) => h('label', {}, h('span', { class: 'dim' }, (s.aliases[0] || s.label.slice(0, 3)).toUpperCase()),
    h('input', { type: 'number', class: 'n', value: it.bonuses?.[s.id] ?? 0, oninput: (e) => { const v = Number(e.target.value) || 0; it.bonuses ??= {}; if (v) it.bonuses[s.id] = v; else delete it.bonuses[s.id]; saveActor(a); } }))));
  const exprRow = (it) => {
    const msg = h('div', { class: 'expr-msg' });
    const check = () => {
      const { options, errors } = evalEquipSlotsExpr(it.equipExpr || '');
      msg.className = 'expr-msg ' + (errors.length ? 'err' : 'ok');
      msg.textContent = errors.length ? errors.join(' · ') : (it.equipExpr || '').trim() ? `${options.length} ${t('slotChoices')}` : t('noExpr');
    };
    check();
    return h('div', { class: 'expr' }, h('label', {}, t('slotsExpr'), h('input', { type: 'text', class: 'code grow', placeholder: '[weapons] | [head] | torso + belt', value: it.equipExpr ?? '',
      oninput: (e) => { it.equipExpr = e.target.value; check(); saveActor(a); }, onchange: () => rerender() })), msg);
  };
  const card = (it) => {
    const key = ik(it), isOpen = S.openItems.has(key);
    const typeSel = h('select', { onchange: (e) => { it.type = e.target.value; if (it.type === 'weapon' && !it.equipExpr) it.equipExpr = '[weapons]'; saveActor(a); rerender(); } },
      SECTIONS.map(([k, lbl]) => h('option', { value: k }, t(lbl))));
    typeSel.value = it.type;
    return h('div', { class: 'inv-item' + (isOpen ? ' open' : '') + ((it.usedSlots || []).length ? ' on' : ''), id: 'inv-' + key },
      h('div', { class: 'inv-head' },
        h('button', { class: 'chev' + (isOpen ? ' open' : ''), type: 'button', title: t('toggle'), onclick: () => { if (isOpen) S.openItems.delete(key); else S.openItems.add(key); rerender(); } }, '›'),
        field(a, it, 'name', 'text', { class: 'grow', placeholder: t('name') }), qty(it), picker(it)),
      isOpen && h('div', { class: 'inv-body' },
        field(a, it, 'notes', 'area', { rows: 2, placeholder: t('effect') }),
        (it.type === 'weapon' || it.type === 'armor') ? statStrip(it) : null,
        it.type === 'armor' ? h('div', { class: 'line' }, h('label', {}, t('defP'), field(a, it, 'pdef', 'int', { min: 0, class: 'n' })), h('label', {}, t('defM'), field(a, it, 'mdef', 'int', { min: 0, class: 'n' }))) : null,
        exprRow(it),
        h('div', { class: 'line' }, typeSel, compBtn('item', it), h('span', { class: 'grow' }),
          h('button', { class: 'danger', type: 'button', onclick: () => { items.splice(items.indexOf(it), 1); saveActor(a); rerender(); } }, t('del')))));
  };

  // ------------------------------------------------ sections
  const section = ([type, titleKey]) => {
    const list = items.filter((it) => it.type === type);
    const add = () => { const it = { id: '', _k: 'n' + Math.random().toString(36).slice(2, 8), name: '', type, qty: 1, bonuses: {}, pdef: 0, mdef: 0, notes: '', equipExpr: type === 'weapon' ? '[weapons]' : '', usedSlots: [] }; items.push(it); S.openItems.add(ik(it)); saveActor(a); rerender(); };
    return h('section', { class: 'sec inv-sec' }, h('h3', {}, t(titleKey), h('span', { class: 'sec-actions' },
      compPick('item', (e) => { const it = { ...e, id: '', _k: 'n' + Math.random().toString(36).slice(2, 8), type, usedSlots: [] }; items.push(it); saveActor(a); rerender(); }),
      h('button', { class: 'icon-btn', type: 'button', title: t('add'), onclick: add }, icon('add')))),
      list.map(card), list.length ? null : h('p', { class: 'hint' }, t('empty')));
  };
  return h('div', { class: 'inventory' }, equipPanel, SECTIONS.map(section));
}
