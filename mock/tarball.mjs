// Tiny helpers to build and read npm style tarballs without dependencies.
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

function header(path, size) {
  const h = Buffer.alloc(512);
  h.write(path, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148); // checksum placeholder
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** files: { 'package/index.js': 'source', ... } */
export function makeTgz(files) {
  const parts = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    parts.push(header(path, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
}

export function makePackage(name, version, source = 'module.exports = 1;\n', extra = {}) {
  return makeTgz({
    'package/package.json': JSON.stringify({ name, version, main: 'index.js', ...extra }, null, 2),
    'package/index.js': source,
  });
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Returns { path: Buffer } for every file in the tarball. */
export function readTgz(buf) {
  const raw = gunzipSync(buf);
  const out = {};
  let off = 0;
  while (off + 512 <= raw.length) {
    const block = raw.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const path = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(block.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    out[path] = raw.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
