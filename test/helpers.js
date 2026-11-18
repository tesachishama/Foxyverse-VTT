// Starts a throwaway server with its own data folder. Shared by the HTTP tests.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function startServer(env = {}, prepare) {
  const dataDir = mkdtempSync(join(tmpdir(), 'foxy-'));
  await prepare?.(dataDir);
  const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, ADMIN_SECRET: '', PORT: '0', DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', (d) => { logs += d; }); proc.stderr.on('data', (d) => { logs += d; });
  // PORT=0: the OS picks a free port and the server prints it, so test files running in parallel never share a server.
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + logs)), 15_000);
    const look = () => { const m = /listening on http:\/\/[^:]+:(\d+)/.exec(logs); if (m) { clearTimeout(timer); resolve(Number(m[1])); } };
    proc.stdout.on('data', look);
    proc.on('exit', () => { clearTimeout(timer); reject(new Error('server exited:\n' + logs)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, cookie, extra = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  /** A table with GM and player helpers: gm(method, path, body), join(slotId) -> player(method, path, body, extra). */
  const table = async (slug, opts = {}) => {
    const r = await call('POST', '/admin/api/tables', { name: opts.name ?? slug, slug, listed: opts.listed });
    if (r.status !== 200) throw new Error('table create failed: ' + JSON.stringify(r.body));
    const gm = (m, p, b, extra) => call(m, `/admin/api/t/${slug}${p}`, b, null, extra);
    const slot = async (name) => (await gm('POST', '/slots', { name })).body;
    const join = async (slotId, cookie) => {
      const j = await call('POST', `/api/t/${slug}/join`, { slotId }, cookie);
      if (j.status !== 200) throw new Error('join failed: ' + JSON.stringify(j.body));
      const c = j.cookie ?? cookie;
      const player = (m, p, b, extra) => call(m, `/api/t/${slug}${p}`, b, c, extra);
      player.cookie = c;
      return player;
    };
    return { gm, slot, join, slug };
  };
  /** Reads Server-Sent Events until one matches; returns { next(pred), close() }. */
  const events = async (path, cookie) => {
    const res = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    const next = async (pred = () => true) => {
      for (;;) {
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) { const ev = JSON.parse(line.slice(6)); if (pred(ev)) return ev; }
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buf += dec.decode(value);
      }
    };
    return { next, close: () => reader.cancel().catch(() => {}), status: res.status };
  };
  const stop = async () => {
    const gone = once(proc, 'exit'); proc.kill(); await gone; // wait so Windows releases the database file before we delete it
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { base, call, table, events, stop, logs: () => logs, dataDir };
}
