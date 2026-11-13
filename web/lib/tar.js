// Reading an already-unzipped npm tarball (the tar part of a .tgz). No Node APIs, so the
// CLI and the dashboard share this file. Gunzip happens outside: Node uses zlib, the browser
// uses DecompressionStream.

const decoder = new TextDecoder('utf-8');
const text = (buf, from, len) => decoder.decode(buf.subarray(from, from + len)).replace(/\0[\s\S]*$/, '');

/** Returns [{ path, mode, content: Uint8Array }] for every regular file. */
export function readTar(raw) {
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
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(content));
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

/** Gunzip in a browser. Refuses to inflate past maxTotal bytes. */
export async function gunzip(bytes, maxTotal = 64 * 1024 * 1024) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxTotal) {
      await reader.cancel();
      throw new Error('the archive is larger than the limit when unpacked');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
