// Reading an npm tarball (.tgz) without dependencies. The tar parsing is shared with the
// dashboard (web/lib/tar.js); only gunzip is Node specific.
import { gunzipSync } from 'node:zlib';
import { readTar } from '../../web/lib/tar.js';

/** Returns [{ path, mode, content: Buffer }] for every regular file. */
export function readTarball(tgz, { maxTotal = 64 * 1024 * 1024 } = {}) {
  return readTar(gunzipSync(tgz, { maxOutputLength: maxTotal }));
}
