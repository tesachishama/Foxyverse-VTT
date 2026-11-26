// ROADMAP 3 §5: the minimal ZIP writer / reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { zipWriter, openZip, ZipError, safeName } from '../server/zip.js';

const dir = mkdtempSync(join(tmpdir(), 'foxy-zip-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const writeZip = async (path, fill) => {
  const out = createWriteStream(path), z = zipWriter(out);
  await fill(z); await z.finish();
  await new Promise((r) => out.end(r));
};

test('5 a ZIP written in streams reads back exactly (text, a big binary file, an empty entry, UTF-8 names)', async () => {
  const big = randomBytes(3 * 1024 * 1024); writeFileSync(join(dir, 'big.bin'), big);
  const path = join(dir, 'a.zip');
  await writeZip(path, async (z) => {
    await z.add('manifest.json', Buffer.from('{"é":1}'));
    await z.addFile('files/big.bin', join(dir, 'big.bin'), { level: 1 });
    await z.add('empty.txt', Buffer.alloc(0));
  });
  const zip = await openZip(path);
  try {
    assert.deepEqual(zip.names, ['manifest.json', 'files/big.bin', 'empty.txt']);
    assert.equal((await zip.buffer('manifest.json')).toString(), '{"é":1}');
    await zip.extract('files/big.bin', join(dir, 'out.bin'));
    assert.ok(readFileSync(join(dir, 'out.bin')).equals(big));
    assert.equal((await zip.buffer('empty.txt')).length, 0);
    await assert.rejects(zip.buffer('manifest.json', 3), ZipError); // over the size we accept
    await assert.rejects(zip.buffer('nope.json'), /Missing/);
  } finally { await zip.close(); }
});

test('5 a damaged or foreign file is refused cleanly (ZipError), never a crash', async () => {
  writeFileSync(join(dir, 'junk.zip'), 'definitely not a zip');
  await assert.rejects(openZip(join(dir, 'junk.zip')), ZipError);
  const path = join(dir, 'b.zip');
  await writeZip(path, (z) => z.add('data.json', Buffer.from('x'.repeat(5000))));
  const bytes = readFileSync(path); bytes[60] ^= 0xff; writeFileSync(join(dir, 'bad.zip'), bytes); // flip a byte inside the data
  const zip = await openZip(join(dir, 'bad.zip'));
  try { await assert.rejects(zip.buffer('data.json'), ZipError); } finally { await zip.close(); }
  writeFileSync(join(dir, 'cut.zip'), bytes.subarray(0, bytes.length - 30)); // cut off
  await assert.rejects(openZip(join(dir, 'cut.zip')), ZipError);
  for (const n of ['../x', '/abs', 'a\b', 'a/../../b', '']) assert.equal(safeName(n), false, n);
  assert.equal(safeName('files/abc.png'), true);
});
