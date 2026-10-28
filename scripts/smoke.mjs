// End-to-end smoke test against a running server (used by CI against the built container, and runnable by hand):
//   node scripts/smoke.mjs http://localhost:3000
const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const fail = (m) => { console.error('SMOKE FAIL:', m); process.exit(1); };
const call = async (method, path, body, cookie) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] };
};

for (let i = 0; ; i++) { // wait for the server to come up (up to 30 s)
  try { if ((await fetch(BASE + '/api/me')).ok) break; } catch { /* not yet */ }
  if (i >= 60) fail('server did not become reachable');
  await new Promise((r) => setTimeout(r, 500));
}
const index = await fetch(BASE + '/');
if (!index.ok || !(await index.text()).includes('Foxyverse VTT')) fail('index page not served');
for (const f of ['/app.js', '/map.js', '/vision.js', '/audio.js', '/lib.js', '/inventory.js', '/slots.js', '/style.css', '/icons/Icons_equipmentSlots.svg', '/icons/Icons_weapon.svg']) if (!(await fetch(BASE + f)).ok) fail(`static file ${f} missing`);

const name = 'smoke' + Date.now() % 100000;
const reg = await call('POST', '/api/register', { name, password: 'smoke-test-password', invite: process.env.SMOKE_INVITE });
if (reg.status !== 200 || !reg.cookie) fail('register failed: ' + JSON.stringify(reg.body));
const st = (await call('GET', '/api/state', null, reg.cookie)).body;
if (!st?.system?.stats?.length) fail('system definition not loaded');
const scene = await call('POST', '/api/scenes', { name: 'Smoke', width: 800, height: 600 }, reg.cookie);
if (scene.status !== 200) fail('scene create failed');
const hero = await call('POST', '/api/actors', { name: 'Smoke hero' }, reg.cookie);
if (hero.body.computed.derived.maxhp !== 10) fail('derived stats wrong (expected 10 HP at level 1, CON 5)');
const gear = hero.body.data; gear.items = [{ name: 'Smoke helm', type: 'armor', equipExpr: '[head]', usedSlots: ['hat'], pdef: 2 }];
const geared = await call('PATCH', `/api/actors/${hero.body.id}`, { data: gear }, reg.cookie);
if (geared.body?.computed?.pdef !== 2) fail('equipment slots / defenses wrong');
const roll = await call('POST', '/api/chat', { text: '/con +0', actorId: hero.body.id }, reg.cookie);
if (roll.status !== 200 || !roll.body.body.results?.length) fail('roll failed');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const up = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: reg.cookie }, body: png });
const upj = await up.json();
if (!up.ok || !(await fetch(BASE + upj.url)).ok) fail('upload round-trip failed (is the data volume writable?)');
console.log('SMOKE OK:', BASE);
