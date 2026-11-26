// Sound organisation (ROADMAP 3 §4.2): groups and sub-groups (two levels), free tags, search, sort.
// Pure (no DOM): shared by the page, the server and the tests. A sound with no group is in "No group" (the empty group).

/** A group or sub-group name: trimmed, single spaces, 40 characters. */
export const cleanGroup = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
/** Tags from a list or a comma-separated text: trimmed, 30 characters each, no duplicates (whatever the case), 20 at most. */
export function cleanTags(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = [], seen = new Set();
  for (const raw of list) {
    const tag = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 30), key = tag.toLowerCase();
    if (tag && !seen.has(key)) { seen.add(key); out.push(tag); }
    if (out.length >= 20) break;
  }
  return out;
}
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Sounds whose name, group, sub-group or a tag contains every word of the search (accents and case ignored). */
export function searchSounds(sounds, q) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [...sounds];
  return sounds.filter((s) => { const hay = fold([s.name, s.group, s.subgroup, ...(s.tags ?? [])].join(' ')); return words.every((w) => hay.includes(w)); });
}
/** "name" (A to Z) or "date" (last added first). */
export function sortSounds(sounds, sort = 'name') {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });
  return [...sounds].sort(sort === 'date' ? (a, b) => (b.created ?? 0) - (a.created ?? 0) || b.id - a.id : byName);
}
/** [{ group, subgroups: [{ subgroup, sounds }] }]: "No group" first, then groups by name; inside, sounds without sub-group first. */
export function groupSounds(sounds) {
  const groups = new Map();
  for (const s of sounds) {
    const g = s.group || '', sg = g ? s.subgroup || '' : '';
    if (!groups.has(g)) groups.set(g, new Map());
    const subs = groups.get(g); if (!subs.has(sg)) subs.set(sg, []);
    subs.get(sg).push(s);
  }
  const order = (a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return [...groups.keys()].sort(order).map((group) => ({ group, subgroups: [...groups.get(group).keys()].sort(order).map((subgroup) => ({ subgroup, sounds: groups.get(group).get(subgroup) })) }));
}
