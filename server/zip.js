// A minimal ZIP writer and reader (ROADMAP 3 §5), no dependency: node:zlib does the compression and the CRC-32.
// Files go through in streams, so a big map or sound never sits whole in memory.
//
// Writer: deflate only, sizes and CRC in a data descriptor after each entry (so nothing is read twice), UTF-8 names.
// Reader: reads the central directory at the end of the file, then each entry on demand; checks sizes and CRC.
// Limits: no ZIP64 (an archive and each entry stay under 4 GB), no encryption, no multi-disk archives. Any standard tool opens what
// the writer makes; the reader is meant for our own archives (it refuses what it does not understand, cleanly).
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createDeflateRaw, createInflateRaw, crc32 } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export class ZipError extends Error {}
const MAX32 = 0xffffffff;
const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
/** A name inside our archives: relative, forward slashes, no "..", printable. */
export const safeName = (n) => typeof n === 'string' && n.length > 0 && n.length < 300 && !n.startsWith('/') && !n.includes('\\') && !n.split('/').includes('..') && !/[\0-\x1f]/.test(n);

/** Write a ZIP into a writable stream. add*() one after another, then finish(). */
export function zipWriter(out) {
  const entries = []; let offset = 0, closed = false;
  const write = (buf) => new Promise((resolve, reject) => {
    if (closed) return reject(new ZipError('The download was interrupted'));
    offset += buf.length;
    if (out.write(buf)) resolve(); else { out.once('drain', resolve); out.once('close', () => reject(new ZipError('The download was interrupted'))); }
  });
  out.on?.('close', () => { closed = true; });
  /** Add one entry from a readable stream (or a buffer). level: 1 for media (already compressed), 6 for text. */
  async function add(name, source, { level = 6 } = {}) {
    if (!safeName(name)) throw new ZipError(`Bad entry name: ${name}`);
    if (offset > MAX32) throw new ZipError('Archive too large (over 4 GB)');
    const nameBuf = Buffer.from(name, 'utf8'), now = new Date(), start = offset;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0808, 6); // bit 3: data descriptor, bit 11: UTF-8
    head.writeUInt16LE(8, 8); head.writeUInt16LE(dosTime(now), 10); head.writeUInt16LE(dosDate(now), 12);
    head.writeUInt16LE(nameBuf.length, 26);
    await write(head); await write(nameBuf);
    let crc = 0, size = 0, csize = 0;
    const deflate = createDeflateRaw({ level });
    const src = Buffer.isBuffer(source) ? [source] : source;
    const counter = new Transform({ transform(chunk, _, cb) { crc = crc32(chunk, crc); size += chunk.length; cb(null, chunk); } });
    const sink = new Transform({ async transform(chunk, _, cb) { try { csize += chunk.length; await write(chunk); cb(); } catch (e) { cb(e); } } });
    await pipeline(src, counter, deflate, sink, async function* (s) { for await (const _ of s); }); // eslint-disable-line no-unused-vars
    if (size > MAX32 || csize > MAX32) throw new ZipError(`${name}: over 4 GB`);
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc >>> 0, 4); desc.writeUInt32LE(csize, 8); desc.writeUInt32LE(size, 12);
    await write(desc);
    entries.push({ nameBuf, crc: crc >>> 0, size, csize, start, time: dosTime(now), date: dosDate(now) });
  }
  async function finish() {
    const cdStart = offset;
    for (const e of entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.start, 42);
      await write(c); await write(e.nameBuf);
    }
    if (offset > MAX32 || entries.length > 0xffff) throw new ZipError('Archive too large');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    await write(end);
  }
  return { add, addFile: (name, path, opts) => add(name, createReadStream(path), opts), finish };
}

/** Open a ZIP file: { names, has(name), size(name), buffer(name, max), extract(name, path, { max, onChunk }), close() }. Throws ZipError when it is not a (sound) ZIP. */
export async function openZip(path) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size < 22) throw new ZipError('Not a ZIP file');
    const tailLen = Math.min(size, 22 + 0xffff), tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ZipError('Not a ZIP file (or a damaged one)');
    const count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff + cdSize > size || cdSize > 64 * 1024 * 1024) throw new ZipError('Damaged ZIP file (directory)');
    const cd = Buffer.alloc(cdSize); await fh.read(cd, 0, cdSize, cdOff);
    const entries = new Map();
    for (let p = 0, i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('Damaged ZIP file (entry)');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), k = cd.readUInt16LE(p + 32);
      const name = cd.toString('utf8', p + 46, p + 46 + n);
      if (flags & 1) throw new ZipError('Encrypted ZIP files are not supported');
      if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression in ${name}`);
      entries.set(name, { method, crc: cd.readUInt32LE(p + 16), csize: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24), local: cd.readUInt32LE(p + 42) });
      p += 46 + n + x + k;
    }
    async function dataStart(e) {
      const lh = Buffer.alloc(30); await fh.read(lh, 0, 30, e.local);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new ZipError('Damaged ZIP file (local header)');
      const start = e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (start + e.csize > size) throw new ZipError('Damaged ZIP file (truncated)');
      return start;
    }
    /** Stream one entry into a writable; checks the size (never more than max) and the CRC. */
    async function pipeTo(name, dest, { max = Infinity, onChunk } = {}) {
      const e = entries.get(name); if (!e) throw new ZipError(`Missing in the archive: ${name}`);
      if (e.size > max) throw new ZipError(`${name} is too large`);
      const start = await dataStart(e);
      let crc = 0, got = 0;
      const check = new Transform({ transform(chunk, _, cb) {
        got += chunk.length; if (got > e.size || got > max) return cb(new ZipError(`${name}: more data than announced`));
        crc = crc32(chunk, crc); onChunk?.(chunk); cb(null, chunk);
      } });
      const raw = e.csize ? createReadStream(null, { fd: fh.fd, start, end: start + e.csize - 1, autoClose: false }) : [Buffer.alloc(0)];
      try { await pipeline(raw, ...(e.method === 8 ? [createInflateRaw()] : []), check, dest); }
      catch (err) { throw err instanceof ZipError ? err : new ZipError(`${name}: damaged data (${err.code || err.message})`); }
      if (got !== e.size || (crc >>> 0) !== e.crc) throw new ZipError(`${name}: damaged data (checksum)`);
    }
    return {
      names: [...entries.keys()],
      has: (name) => entries.has(name),
      size: (name) => entries.get(name)?.size ?? 0,
      async buffer(name, max = 256 * 1024 * 1024) {
        const parts = [];
        await pipeTo(name, async function* (s) { for await (const c of s) parts.push(c); }, { max });
        return Buffer.concat(parts);
      },
      extract: (name, path, opts) => pipeTo(name, createWriteStream(path), opts),
      close: () => fh.close(),
    };
  } catch (e) { await fh.close(); throw e; }
}
