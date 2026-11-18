// Readable differences between two systems, shown to the GM before a saved system overwrites a table's rules.
// Lists of things that have an id (stats, derived values, roll types...) are compared entry by entry, not by position.
const KEYED = { stats: 'id', derived: 'id', quickRolls: 'id', rollTypes: 'id', rules: 'title' };
const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** [{ path, op: 'added' | 'removed' | 'changed', before?, after? }], from `current` to `next`. */
export function diffSystems(current, next) {
  const out = [];
  const walk = (path, a, b) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a === undefined) { out.push({ path, op: 'added', after: b }); return; }
    if (b === undefined) { out.push({ path, op: 'removed', before: a }); return; }
    const key = KEYED[path];
    if (key && Array.isArray(a) && Array.isArray(b)) {
      const ma = new Map(a.map((x) => [x?.[key], x])), mb = new Map(b.map((x) => [x?.[key], x]));
      for (const k of new Set([...ma.keys(), ...mb.keys()])) walk(`${path}.${k}`, ma.get(k), mb.get(k));
      return;
    }
    if (plain(a) && plain(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(path ? `${path}.${k}` : k, a[k], b[k]);
      return;
    }
    out.push({ path, op: 'changed', before: a, after: b });
  };
  walk('', current, next);
  return out;
}
