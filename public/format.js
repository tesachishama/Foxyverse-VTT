// Small display rules shared by the page and the tests. Pure: no DOM, no storage.

/** A modifier as it acts on the die: "-3", "+1", and "-0" for zero (talent tiers are maluses on a roll-under d20). */
export const signed = (n) => (Number(n) > 0 ? '+' : '-') + Math.abs(Number(n) || 0);

/** "T2 -3": a talent tier with its modifier, signed as it acts on the die. Display only, the server does the maths. */
export const tierLabel = (tiers, n) => `T${n} ${signed(tiers?.[n] ?? 0)}`;

/** Damage rolls of one application, e.g. "20−5 + 15−5". Empty when there is nothing to explain (one roll, no armor). */
export function damageDetail(rolls) {
  if (!Array.isArray(rolls) || !rolls.length) return '';
  if (rolls.length === 1 && !rolls[0].armor) return '';
  return rolls.map((r) => (r.armor ? `${r.raw}−${r.armor}` : String(r.raw))).join(' + ');
}
/** "took 25 damage (20−5 + 15−5)": the total received, then how it was made. tookWord(n) gives the words around the number. */
export const damageText = (a, tookWord) => { const d = damageDetail(a.rolls); return tookWord(a.dealt) + (d ? ` (${d})` : ''); };

/** Compendium search: entries whose name contains the query (case and accents ignored). */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const matchesSearch = (name, query) => !query?.trim() || fold(name).includes(fold(query.trim()));
