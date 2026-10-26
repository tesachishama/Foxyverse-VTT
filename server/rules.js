// Applies a system definition (system/foxyverse.json, editable in-app) to actors and rolls.
import { evaluate, evaluateStatic, parseFormula, parseCommand, hasDice, norm, FormulaError, defaultRng } from './engine.js';
import { randomBytes } from 'node:crypto';

const WORD = /^[a-z_]+$/;
const KINDS = ['damage', 'heal', 'theal', 'mana', 'generic'];
// Variable names the app itself provides to every formula.
const BUILTIN = {
  lvl: ['lvl', 'niv'], elemental: ['elemental'], bonact: ['bonact', 'actbon'], bonspe: ['bonspe', 'spebon', 'vitbon', 'bonvit'],
  pdef: ['pdef', 'defp'], mdef: ['mdef', 'defm'],
  curhp: ['curhp', 'hpcur', 'pvact', 'actpv'],
  temhp: ['temhp', 'hptem', 'pvtem', 'tempv', 'temphp', 'hptemp', 'temppv', 'pvtemp'],
  curmp: ['curmp', 'mpcur', 'pmact', 'actpm'], curfav: ['curfav', 'favcur', 'favact', 'actfav'],
};
const REQUIRED_DERIVED = ['maxhp', 'maxmp', 'maxfav', 'act'];
const newId = () => randomBytes(4).toString('hex');
const int = (v, lo = -1e6, hi = 1e6) => Math.min(hi, Math.max(lo, Math.trunc(Number(v)) || 0));
const str = (v, n = 200) => String(v ?? '').slice(0, n);
const setAll = (vars, names, v) => names.forEach((n) => { vars[n] = v; });

// ---------------------------------------------------------------- system
export function validateSystem(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('System must be a JSON object');
  if (JSON.stringify(raw).length > 300_000) throw new Error('System definition is too large');
  const used = new Map(); // variable name -> owner
  const claim = (name, owner) => {
    if (!WORD.test(name) || name === 'd') throw new Error(`"${name}" (${owner}): names use letters and underscores only, and cannot be "d"`);
    if (used.has(name)) throw new Error(`"${name}" is used by both ${used.get(name)} and ${owner}`);
    used.set(name, owner);
  };
  Object.values(BUILTIN).flat().forEach((n) => claim(n, 'built-in'));

  if (!Array.isArray(raw.stats) || !raw.stats.length || raw.stats.length > 30) throw new Error('stats: provide 1 to 30 stats');
  const stats = raw.stats.map((s) => {
    const id = norm(s.id ?? '');
    const aliases = (s.aliases ?? []).map(norm);
    [id, ...aliases].forEach((n) => claim(n, `stat ${id}`));
    return { id, label: str(s.label || id, 40), aliases };
  });

  const derived = (raw.derived ?? []).map((d) => {
    const id = norm(d.id ?? ''), aliases = (d.aliases ?? []).map(norm);
    [id, ...aliases].forEach((n) => claim(n, `derived ${id}`));
    return { id, label: str(d.label || id, 40), aliases, formula: str(d.formula, 500) };
  });
  for (const r of REQUIRED_DERIVED) if (!derived.some((d) => d.id === r)) throw new Error(`derived: "${r}" is required (the app uses it for resources and actions)`);
  const probe = {};
  stats.forEach((s) => setAll(probe, [s.id, ...s.aliases], 10));
  Object.values(BUILTIN).forEach((names) => setAll(probe, names, 1));
  for (const d of derived) {
    try { setAll(probe, [d.id, ...d.aliases], evaluateStatic(d.formula, probe)); }
    catch (e) { throw new Error(`derived ${d.id}: ${e.message}`); }
  }

  const quickRolls = (raw.quickRolls ?? []).map((q) => {
    const id = norm(q.id ?? ''); if (!WORD.test(id)) throw new Error(`quickRoll id "${id}" is invalid`);
    try { parseFormula(q.formula); } catch (e) { throw new Error(`quickRoll ${id}: ${e.message}`); }
    return { id, label: str(q.label || id, 40), formula: str(q.formula, 500) };
  });

  const rollTypes = (raw.rollTypes ?? []).map((t) => {
    if (!KINDS.includes(t.kind)) throw new Error(`rollType ${t.id}: kind must be one of ${KINDS.join(', ')}`);
    if (t.kind === 'damage' && !['physical', 'magical', 'true'].includes(t.dtype)) throw new Error(`rollType ${t.id}: dtype must be physical, magical or true`);
    return { id: norm(t.id), kind: t.kind, dtype: t.dtype, label: str(t.label || t.id, 40), aliases: (t.aliases ?? []).map(norm) };
  });

  const tiers = {};
  for (const [k, v] of Object.entries(raw.knowledgeTiers ?? {})) tiers[int(k, 1, 20)] = int(v, -100, 100);

  const character = {
    baseStat: int(raw.character?.baseStat ?? 5, 0, 100), startPoints: int(raw.character?.startPoints ?? 30, 0, 1000),
    startMaxStat: int(raw.character?.startMaxStat ?? 15, 1, 100), note: str(raw.character?.note, 400),
  };
  const statNames = new Set(stats.flatMap((x) => [x.id, ...x.aliases]));
  const spellStat = (v, fallback) => { const n = norm(v ?? fallback); if (!statNames.has(n)) throw new Error(`spells: "${n}" is not a stat id or alias`); return n; };
  const spells = { armedStat: spellStat(raw.spells?.armedStat, 'foc'), unarmedStat: spellStat(raw.spells?.unarmedStat, 'int') };
  const rules = (raw.rules ?? []).slice(0, 100).map((r) => ({ title: str(r.title, 100), body: str(r.body, 20000) }));
  return { id: norm(raw.id || 'custom'), name: str(raw.name || 'Custom system', 60), version: int(raw.version ?? 1, 0, 1e6), stats, character, spells, derived, quickRolls, rollTypes, knowledgeTiers: tiers, rules };
}

// ---------------------------------------------------------------- actors
export function defaultActorData(sys) {
  const stats = {};
  sys.stats.forEach((s) => { stats[s.id] = { base: sys.character.baseStat, passive: 0 }; });
  const data = { bio: { class: '', element: '', level: 1 }, stats, hp: { cur: 0, temp: 0 }, mp: { cur: 0 }, fav: { cur: 0 },
    bonact: 0, bonspe: 0, elemental: false, talents: [], spells: [], items: [], currency: { pc: 0, pa: 0, po: 0 }, notes: '' };
  const c = actorContext(sys, data);
  data.hp.cur = c.derived.maxhp; data.mp.cur = c.derived.maxmp; data.fav.cur = c.derived.maxfav;
  return data;
}

export function sanitizeActorData(raw, sys) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const stats = {};
  sys.stats.forEach((s) => { stats[s.id] = { base: int(r.stats?.[s.id]?.base ?? sys.character.baseStat, 0, 999), passive: int(r.stats?.[s.id]?.passive, -999, 999) }; });
  const list = (a, fn) => (Array.isArray(a) ? a.slice(0, 200).map(fn) : []);
  const statIds = new Set(sys.stats.map((s) => s.id));
  return {
    bio: { class: str(r.bio?.class, 60), element: str(r.bio?.element, 60), level: int(r.bio?.level ?? 1, 1, 999) },
    portrait: /^\/uploads\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(r.portrait ?? '') ? r.portrait : '',
    stats,
    hp: { cur: int(r.hp?.cur, -9999, 999999), temp: int(r.hp?.temp, 0, 999999) },
    mp: { cur: int(r.mp?.cur, 0, 999999) },
    fav: { cur: int(r.fav?.cur, 0, 999) },
    bonact: int(r.bonact, -99, 99), bonspe: int(r.bonspe, -999, 999), elemental: !!r.elemental,
    talents: list(r.talents, (t) => ({ id: str(t?.id, 16) || newId(), name: str(t?.name, 80), tier: int(t?.tier ?? 1, 1, 20), enabled: t?.enabled !== false })),
    spells: list(r.spells, (s) => ({ id: str(s?.id, 16) || newId(), name: str(s?.name, 80), effect: str(s?.effect, 2000), cost: int(s?.cost, 0, 99999),
      costType: s?.costType === 'hp' ? 'hp' : 'mp', armed: !!s?.armed, continuous: !!s?.continuous })),
    items: list(r.items, (i) => {
      const bonuses = {};
      for (const k of Object.keys(i?.bonuses ?? {})) if (statIds.has(k)) bonuses[k] = int(i.bonuses[k], -999, 999);
      return { id: str(i?.id, 16) || newId(), name: str(i?.name, 80), type: ['weapon', 'armor', 'consumable', 'bag', 'other'].includes(i?.type) ? i.type : 'other',
        equipped: !!i?.equipped, qty: int(i?.qty ?? 1, 0, 99999), bonuses, pdef: int(i?.pdef, 0, 9999), mdef: int(i?.mdef, 0, 9999), notes: str(i?.notes, 2000) };
    }),
    currency: { pc: int(r.currency?.pc, 0, 1e12), pa: int(r.currency?.pa, 0, 1e12), po: int(r.currency?.po, 0, 1e12) },
    notes: str(r.notes, 20000),
  };
}

/** Stat totals, defenses, derived values and the variable table formulas run against. */
export function actorContext(sys, data) {
  const vars = {}, stats = {}, equipped = (data.items ?? []).filter((i) => i.equipped);
  for (const s of sys.stats) {
    const base = Number(data.stats?.[s.id]?.base) || 0, passive = Number(data.stats?.[s.id]?.passive) || 0;
    const item = equipped.reduce((a, i) => a + (Number(i.bonuses?.[s.id]) || 0), 0);
    stats[s.id] = { base, passive, item, total: base + passive + item };
    setAll(vars, [s.id, ...s.aliases], stats[s.id].total);
  }
  const pdef = equipped.reduce((a, i) => a + (Number(i.pdef) || 0), 0);
  const mdef = equipped.reduce((a, i) => a + (Number(i.mdef) || 0), 0);
  setAll(vars, BUILTIN.lvl, Number(data.bio?.level) || 1);
  setAll(vars, BUILTIN.elemental, data.elemental ? 1 : 0);
  setAll(vars, BUILTIN.bonact, Number(data.bonact) || 0);
  setAll(vars, BUILTIN.bonspe, Number(data.bonspe) || 0);
  setAll(vars, BUILTIN.pdef, pdef); setAll(vars, BUILTIN.mdef, mdef);
  const derived = {}, errors = {};
  for (const d of sys.derived) {
    let v = 0;
    try { v = evaluateStatic(d.formula, vars); } catch (e) { errors[d.id] = e.message; }
    derived[d.id] = v; setAll(vars, [d.id, ...d.aliases], v);
  }
  setAll(vars, BUILTIN.curhp, Number(data.hp?.cur) || 0);
  setAll(vars, BUILTIN.temhp, Number(data.hp?.temp) || 0);
  setAll(vars, BUILTIN.curmp, Number(data.mp?.cur) || 0);
  setAll(vars, BUILTIN.curfav, Number(data.fav?.cur) || 0);
  return { vars, stats, derived, errors, pdef, mdef };
}

/** Points a character should have spent, vs. have spent (see system.character). */
export function pointBudget(sys, data) {
  const lvl = Number(data.bio?.level) || 1;
  const budget = sys.character.startPoints + (lvl * (lvl - 1)) / 2;
  const step = (v) => Math.max(1, Math.floor((v - 1) / 10)); // 1 up to 20, 2 for 21-30, 3 for 31-40...
  let spent = 0;
  for (const s of sys.stats) for (let v = sys.character.baseStat + 1; v <= (Number(data.stats?.[s.id]?.base) || 0); v++) spent += step(v);
  return { budget, spent };
}

// ---------------------------------------------------------------- rolls
export function resolveType(sys, typeName) {
  const t = norm(typeName);
  for (const s of sys.stats) if (s.id === t || s.aliases.includes(t)) return { kind: 'stat', stat: s, label: s.label, id: s.id };
  for (const r of sys.rollTypes) if (r.id === t || r.aliases.includes(t)) return { ...r };
  const q = sys.quickRolls.find((x) => x.id === t);
  if (q) return { kind: 'generic', id: q.id, label: q.label, preset: q.formula };
  return null;
}

/**
 * Run a parsed command. Returns a chat body or throws Error with a user-facing message.
 * actorData may be null for rolls that do not need a character.
 */
export function executeRoll(sys, cmd, actorData, rng = defaultRng) {
  const type = resolveType(sys, cmd.type);
  if (!type) throw new Error(`Unknown roll type "${cmd.type}"`);
  const ctx = actorData ? actorContext(sys, actorData) : { vars: {}, stats: {} };
  let formula = cmd.formula || type.preset || '';
  if (type.kind === 'stat') {
    if (!actorData) throw new Error('Pick a character first to roll a stat');
    if (!formula) formula = '1d20';
    else if (!hasDice(parseFormula(formula).main)) formula = /^[+-]/.test(formula) ? `1d20${formula}` : `1d20+${formula}`;
  }
  if (!formula) throw new Error('Formula is empty');
  parseFormula(formula); // surface syntax errors before rolling

  const results = [];
  for (let i = 0; i < cmd.count; i++) {
    const r = evaluate(formula, ctx.vars, rng);
    const out = { total: r.total, dice: r.dice };
    if (type.kind === 'stat') {
      const target = ctx.stats[type.id].total;
      const d20 = r.dice.find((d) => d.faces === 20 && d.count >= 1)?.results[0];
      const pass = r.total <= target;
      out.target = target; out.margin = target - r.total; out.nat = d20;
      if (d20 === 1) out.outcome = pass ? 'critSuccess' : 'success';
      else if (d20 === 20) out.outcome = pass ? 'failure' : 'critFailure';
      else out.outcome = pass ? 'success' : 'failure';
    } else if (r.success !== undefined) {
      out.target = r.target; out.outcome = r.success ? 'success' : 'failure';
    }
    results.push(out);
  }
  return {
    kind: type.kind, type: type.id, label: cmd.label || '', title: type.label, dtype: type.dtype, formula,
    count: cmd.count, results, sum: results.reduce((a, r) => a + r.total, 0),
    cmd: { type: cmd.type, formula: cmd.formula, count: cmd.count, label: cmd.label },
  };
}

/** Apply the effect of a roll body (damage/heal/...) to actor data. Returns { data, report }. */
export function applyRoll(sys, data, body) {
  const next = structuredClone(data);
  const c = actorContext(sys, next);
  const maxhp = c.derived.maxhp, maxmp = c.derived.maxmp;
  const amounts = body.results.map((r) => Math.max(0, r.total));
  const report = { kind: body.kind };

  if (body.kind === 'damage') {
    let dealt = 0;
    for (const a of amounts) {
      if (body.dtype === 'physical') dealt += next.elemental ? 0 : Math.max(0, a - c.pdef);
      else if (body.dtype === 'magical') dealt += Math.max(0, a - c.mdef);
      else dealt += a;
    }
    const tempLost = Math.min(next.hp.temp, dealt); next.hp.temp -= tempLost;
    let rest = dealt - tempLost, hpLost = 0, mpLost = 0;
    if (next.elemental) { mpLost = Math.min(next.mp.cur, rest); next.mp.cur -= mpLost; }
    else { hpLost = Math.min(Math.max(0, next.hp.cur), rest); next.hp.cur = Math.max(0, next.hp.cur - rest); }
    Object.assign(report, { dealt, tempLost, hpLost, mpLost, hp: next.hp.cur, ko: !next.elemental && next.hp.cur <= 0 });
  } else if (body.kind === 'heal') {
    const before = next.hp.cur; next.hp.cur = Math.min(maxhp, next.hp.cur + body.sum);
    Object.assign(report, { healed: next.hp.cur - before, hp: next.hp.cur });
  } else if (body.kind === 'theal') {
    next.hp.temp += body.sum; report.temp = next.hp.temp;
  } else if (body.kind === 'mana') {
    const before = next.mp.cur; next.mp.cur = Math.min(maxmp, next.mp.cur + body.sum);
    Object.assign(report, { restored: next.mp.cur - before, mp: next.mp.cur });
  } else throw new Error('This roll has nothing to apply');
  return { data: next, report };
}

/** Spend a spell's cost. At 0 mana the remainder comes out of HP (heals cast this way cannot refund it). */
export function castSpell(sys, data, spellId) {
  const sp = data.spells.find((s) => s.id === spellId);
  if (!sp) throw new Error('Unknown spell');
  const next = structuredClone(data);
  let mpSpent = 0, hpSpent = 0;
  if (sp.costType === 'hp') { hpSpent = sp.cost; next.hp.cur = Math.max(0, next.hp.cur - hpSpent); }
  else { mpSpent = Math.min(next.mp.cur, sp.cost); next.mp.cur -= mpSpent; hpSpent = sp.cost - mpSpent; next.hp.cur = Math.max(0, next.hp.cur - hpSpent); }
  return { data: next, spell: sp, mpSpent, hpSpent };
}

export { FormulaError, parseCommand };
