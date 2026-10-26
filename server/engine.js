// Formula engine: dice, arithmetic, variables, comparators and clamps.
// Grammar follows the Foxyverse Owlbear plugin docs (docs/rolls-and-inline.md):
//   XdY (X, Y can be expressions)   + - * ^ ( )
//   /  divide, round to nearest     \  divide, round down     %  divide, round up (NOT modulo)
//   a < b  means a <= b    a > b  means a >= b
//   expr !<bound / !>bound  clamp the final total (floor / ceiling)
// Extensions: functions min() max() floor() ceil() round() abs(); unary minus.
import { randomInt } from 'node:crypto';

export class FormulaError extends Error {}

export const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const defaultRng = (faces) => randomInt(1, Math.min(Math.max(1, Math.trunc(faces)), 2 ** 48 - 1) + 1);

const MAX_DICE = 1000;
const FUNCS = {
  min: (a) => Math.min(...a), max: (a) => Math.max(...a), abs: (a) => Math.abs(a[0] ?? 0),
  floor: (a) => Math.floor(a[0] ?? 0), ceil: (a) => Math.ceil(a[0] ?? 0), round: (a) => Math.round(a[0] ?? 0),
};

function lex(src) {
  const s = norm(src), out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[\d.]/.test(c)) {
      let j = i; while (j < s.length && /[\d.]/.test(s[j])) j++;
      const v = parseFloat(s.slice(i, j));
      if (Number.isNaN(v)) throw new FormulaError(`Bad number "${s.slice(i, j)}"`);
      out.push({ t: 'num', v }); i = j; continue;
    }
    if (/[a-z_]/.test(c)) {
      let j = i; while (j < s.length && /[a-z_]/.test(s[j])) j++;
      const w = s.slice(i, j);
      out.push(w === 'd' ? { t: 'd' } : { t: 'id', v: w }); i = j; continue;
    }
    if (c === '!' && (s[i + 1] === '<' || s[i + 1] === '>')) { out.push({ t: s[i + 1] === '<' ? '!<' : '!>' }); i += 2; continue; }
    if ('+-*/\\%^(),<>'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new FormulaError(`Unexpected "${src[i]}"`);
  }
  return out;
}

// ---- parser: add > mul > unary > pow > dice > atom ----
function parseTokens(tokens) {
  let p = 0;
  const peek = () => tokens[p]?.t;
  const eat = (t) => { if (peek() !== t) throw new FormulaError(`Expected "${t}"`); return tokens[p++]; };

  function add() {
    let l = mul();
    while (peek() === '+' || peek() === '-') { const op = tokens[p++].t; l = { k: 'bin', op, l, r: mul() }; }
    return l;
  }
  function mul() {
    let l = unary();
    while (['*', '/', '\\', '%'].includes(peek())) { const op = tokens[p++].t; l = { k: 'bin', op, l, r: unary() }; }
    return l;
  }
  function unary() {
    if (peek() === '-') { p++; return { k: 'neg', e: unary() }; }
    if (peek() === '+') { p++; return unary(); }
    return pow();
  }
  function pow() {
    const base = dice();
    if (peek() === '^') { p++; return { k: 'bin', op: '^', l: base, r: unary() }; }
    return base;
  }
  function dice() {
    let l = peek() === 'd' ? { k: 'num', v: 1 } : atom();
    while (peek() === 'd') { p++; l = { k: 'dice', n: l, f: atom() }; }
    return l;
  }
  function atom() {
    const t = tokens[p];
    if (!t) throw new FormulaError('Formula ends unexpectedly');
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === '(') { p++; const e = add(); eat(')'); return e; }
    if (t.t === 'id') {
      p++;
      if (peek() === '(') {
        if (!FUNCS[t.v]) throw new FormulaError(`Unknown function "${t.v}"`);
        p++; const args = [];
        if (peek() !== ')') { do { args.push(add()); } while (peek() === ',' && p++); }
        eat(')');
        return { k: 'fn', name: t.v, args };
      }
      return { k: 'var', name: t.v };
    }
    throw new FormulaError(`Unexpected "${t.t}"`);
  }

  const main = add();
  let cmp = null;
  if (peek() === '<' || peek() === '>') { const op = tokens[p++].t; cmp = { op, rhs: add() }; }
  const clamps = [];
  while (peek() === '!<' || peek() === '!>') { const op = tokens[p++].t; clamps.push({ op, e: add() }); }
  if (p < tokens.length) throw new FormulaError(`Unexpected "${tokens[p].t}"`);
  return { main, cmp, clamps };
}

export function parseFormula(src) {
  const tokens = lex(String(src ?? ''));
  if (!tokens.length) throw new FormulaError('Empty formula');
  return parseTokens(tokens);
}

export function hasDice(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.k === 'dice') return true;
  return Object.values(node).some((v) => (Array.isArray(v) ? v.some(hasDice) : hasDice(v)));
}

const safe = (n) => (Number.isFinite(n) ? n : 0);

function evalNode(n, ctx, rng, log) {
  switch (n.k) {
    case 'num': return n.v;
    case 'var': return Number(ctx[n.name]) || 0; // unknown names resolve to 0
    case 'neg': return -evalNode(n.e, ctx, rng, log);
    case 'fn': return safe(FUNCS[n.name](n.args.map((a) => evalNode(a, ctx, rng, log))));
    case 'dice': {
      const count = Math.min(MAX_DICE, Math.max(0, Math.trunc(evalNode(n.n, ctx, rng, log))));
      const faces = Math.trunc(evalNode(n.f, ctx, rng, log));
      const results = [];
      if (faces >= 1) for (let i = 0; i < count; i++) results.push(rng(faces));
      log.push({ count, faces, results });
      return results.reduce((a, b) => a + b, 0);
    }
    case 'bin': {
      const a = evalNode(n.l, ctx, rng, log), b = evalNode(n.r, ctx, rng, log);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return safe(a * b);
        case '/': return b === 0 ? 0 : Math.round(a / b);
        case '\\': return b === 0 ? 0 : Math.floor(a / b);
        case '%': return b === 0 ? 0 : Math.ceil(a / b);
        case '^': return safe(Math.pow(a, Math.max(-32, Math.min(32, Math.trunc(b)))));
      }
    }
  }
  throw new FormulaError('Bad expression');
}

/** Evaluate a formula string (or a pre-parsed one). Returns { total, dice[], success?, target? }. */
export function evaluate(formula, ctx = {}, rng = defaultRng) {
  const parsed = typeof formula === 'string' ? parseFormula(formula) : formula;
  const dice = [];
  let total = evalNode(parsed.main, ctx, rng, dice);
  for (const c of [...parsed.clamps].reverse()) { // rightmost clamp is applied first
    const bound = Math.trunc(evalNode(c.e, ctx, rng, dice));
    total = c.op === '!<' ? Math.max(total, bound) : Math.min(total, bound);
  }
  total = Math.trunc(total);
  const out = { total, dice };
  if (parsed.cmp) {
    const target = Math.trunc(evalNode(parsed.cmp.rhs, ctx, rng, dice));
    out.target = target;
    out.success = parsed.cmp.op === '<' ? total <= target : total >= target;
  }
  return out;
}

/** Evaluate with no randomness allowed; used for derived stats. */
export function evaluateStatic(formula, ctx) {
  const parsed = typeof formula === 'string' ? parseFormula(formula) : formula;
  if (hasDice(parsed.main) || parsed.clamps.some((c) => hasDice(c.e))) throw new FormulaError('Dice are not allowed here');
  return evaluate(parsed, ctx).total;
}

/** Split "/type 5 formula|label" into parts. */
export function parseCommand(line) {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim());
  if (!m) return null;
  let rest = m[2], label = '';
  const bar = rest.indexOf('|');
  if (bar >= 0) { label = rest.slice(bar + 1).trim().slice(0, 80); rest = rest.slice(0, bar); }
  rest = rest.trim();
  let count = 1;
  const c = /^(\d+)\s+(\S[\s\S]*)$/.exec(rest);
  if (c) { count = Math.min(100, Math.max(1, parseInt(c[1], 10))); rest = c[2].trim(); }
  return { type: norm(m[1]), formula: rest, count, label };
}
