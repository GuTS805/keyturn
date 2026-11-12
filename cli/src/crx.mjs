// Reading CRX3 files and ZIP archives, without dependencies.
import { inflateRawSync } from 'node:zlib';

/** The ZIP inside a CRX3 file. Does not check the signature. */
export function crxZip(crx) {
  if (crx.length < 12 || crx.subarray(0, 4).toString('latin1') !== 'Cr24') throw new Error('not a CRX file');
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX version ${version} is not supported`);
  const start = 12 + crx.readUInt32LE(8);
  if (start > crx.length) throw new Error('CRX header is longer than the file');
  return crx.subarray(start);
}

/** Contents of one file in a ZIP, found through the central directory. */
export function zipFile(zip, wanted) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('broken ZIP directory');
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === wanted) {
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(dataStart, dataStart + size);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`ZIP compression method ${method} is not supported`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} is not in the ZIP`);
}

export function zipManifestVersion(zip) {
  const text = zipFile(zip, 'manifest.json').toString('utf8').replace(/^﻿/, '');
  const v = JSON.parse(text).version;
  if (typeof v !== 'string') throw new Error('manifest.json has no version');
  return v;
}
