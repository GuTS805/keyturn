// What the dashboard does with a dropped package: unpack it, find the version it follows on
// the registry, and run the Watchtower rules on what changed. Nothing is uploaded anywhere
// except a read-only GET to the public registry.

import { readTar, gunzip } from './tar.js';
import { analyzeFiles } from './watchtower.js';

/** Which published version should this one be compared with? */
export function pickPrevious(meta, version) {
  const times = meta?.time || {};
  const stamp = (v) => Date.parse(times[v] || '') || 0;
  const target = stamp(version);
  const names = Object.keys(meta?.versions || {}).filter((v) => v !== version && v !== '0.0.0-stage' && !v.endsWith('-stage'));
  // If the version is already published, compare with what came before it; otherwise with the latest.
  const candidates = target ? names.filter((v) => stamp(v) < target) : names;
  candidates.sort((a, b) => stamp(b) - stamp(a));
  return candidates[0] || null;
}

const encodeName = (name) => name.replace('/', '%2f');

/** Fetch the previous version's tarball from the registry. Returns { version, bytes } or null. */
export async function fetchPrevious({ registry = 'https://registry.npmjs.org', name, version, fetchImpl = fetch }) {
  const res = await fetchImpl(`${registry}/${encodeName(name)}`);
  if (!res.ok) return null;
  const meta = await res.json();
  const prev = pickPrevious(meta, version);
  const url = prev && meta.versions[prev]?.dist?.tarball;
  if (!url) return null;
  const tar = await fetchImpl(url);
  if (!tar.ok) return null;
  return { version: prev, bytes: new Uint8Array(await tar.arrayBuffer()) };
}

/** Run the rules on a dropped .tgz, with the previous version when there is one. */
export async function reviewPackage(newBytes, previous = null) {
  const next = readTar(await gunzip(newBytes));
  const prev = previous ? readTar(await gunzip(previous.bytes)) : null;
  return { report: analyzeFiles(next, prev), comparedWith: previous ? previous.version : null };
}
