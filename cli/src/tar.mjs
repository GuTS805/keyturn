// Reading an npm tarball (.tgz) without dependencies.
import { gunzipSync } from 'node:zlib';

const text = (buf, from, len) => buf.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '');

/** Returns [{ path, mode, content: Buffer }] for every regular file. */
export function readTarball(tgz, { maxTotal = 64 * 1024 * 1024 } = {}) {
  const raw = gunzipSync(tgz, { maxOutputLength: maxTotal });
  const files = [];
  let pos = 0;
  let paxPath = null;
  while (pos + 512 <= raw.length) {
    const header = raw.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(text(header, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('broken tar header');
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(header, 345, 155);
    let name = text(header, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const start = pos + 512;
    const content = raw.subarray(start, start + size);
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content.toString('utf8'));
      paxPath = m ? m[1] : null;
    } else if (type === 'g') {
      // global pax header: nothing we need
    } else if (type === '0') {
      files.push({ path: (paxPath || name).replace(/^package\//, ''), mode: parseInt(text(header, 100, 8).trim() || '0', 8), content });
      paxPath = null;
    } else {
      paxPath = null;
    }
    pos = start + Math.ceil(size / 512) * 512;
  }
  return files;
}
