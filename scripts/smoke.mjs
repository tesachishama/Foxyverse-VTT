// End-to-end smoke test against a running server (used by CI against the built container, and runnable by hand):
//   node scripts/smoke.mjs http://localhost:3000
// If the server has ADMIN_SECRET set, pass it as SMOKE_ADMIN_SECRET. It creates (or reuses) a table "smoke".
const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const fail = (m) => { console.error('SMOKE FAIL:', m); process.exit(1); };
const ADMIN = process.env.SMOKE_ADMIN_SECRET ? { 'X-Admin-Secret': process.env.SMOKE_ADMIN_SECRET } : {};
const call = async (method, path, body, cookie) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(path.startsWith('/admin') ? ADMIN : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

for (let i = 0; ; i++) { // wait for the server to come up (up to 30 s)
  try { if ((await fetch(BASE + '/api/tables')).ok) break; } catch { /* not yet */ }
  if (i >= 60) fail('server did not become reachable');
  await new Promise((r) => setTimeout(r, 500));
}
for (const page of ['/', '/smoke']) {
  const index = await fetch(BASE + page);
  if (!index.ok || !(await index.text()).includes('Foxyverse VTT')) fail(`page ${page} not served`);
}
for (const f of ['/app.js', '/map.js', '/vision.js', '/audio.js', '/lib.js', '/inventory.js', '/slots.js', '/tokencrop.js', '/style.css', '/icons/Icons_equipmentSlots.svg', '/icons/Icons_weapon.svg']) if (!(await fetch(BASE + f)).ok) fail(`static file ${f} missing`);

const made = await call('POST', '/admin/api/tables', { name: 'Smoke', slug: 'smoke' });
if (made.status === 403) fail('GM area refused: set SMOKE_ADMIN_SECRET to the server ADMIN_SECRET');
if (made.status !== 200 && !/taken/.test(made.body?.error ?? '')) fail('table create failed: ' + JSON.stringify(made.body));
const gm = (m, p, b) => call(m, '/admin/api/t/smoke' + p, b);
const st = (await gm('GET', '/state')).body;
if (!st?.system?.stats?.length) fail('system definition not loaded');
if ((await gm('POST', '/scenes', { name: 'Smoke', width: 800, height: 600 })).status !== 200) fail('scene create failed');
const hero = await gm('POST', '/actors', { name: 'Smoke hero' });
if (hero.body.computed.derived.maxhp !== 10) fail('derived stats wrong (expected 10 HP at level 1, CON 5)');
const slot = (await gm('POST', '/slots', { name: 'Smoke player' })).body;
await gm('PUT', `/actors/${hero.body.id}/perms`, { perms: { [slot.id]: 'edit' } });
const joined = await call('POST', '/api/t/smoke/join', { slotId: slot.id });
if (joined.status !== 200 || !joined.cookie) fail('joining as a player failed: ' + JSON.stringify(joined.body));
const player = (m, p, b) => call(m, '/api/t/smoke' + p, b, joined.cookie);
const gear = hero.body.data; gear.items = [{ name: 'Smoke helm', type: 'armor', equipExpr: '[head]', usedSlots: ['hat'], pdef: 2 }];
const geared = await player('PATCH', `/actors/${hero.body.id}`, { data: gear });
if (geared.body?.computed?.pdef !== 2) fail('equipment slots / defenses wrong');
const roll = await player('POST', '/chat', { text: '/con +0', actorId: hero.body.id });
if (roll.status !== 200 || !roll.body.body.results?.length) fail('roll failed');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const up = await fetch(BASE + '/api/t/smoke/upload', { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: joined.cookie }, body: png });
const upj = await up.json();
if (!up.ok || !(await fetch(BASE + upj.url)).ok) fail('upload round-trip failed (is the data volume writable?)');
await gm('DELETE', `/slots/${slot.id}`);
console.log('SMOKE OK:', BASE);
