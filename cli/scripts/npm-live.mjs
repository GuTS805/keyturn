// Publishes a tiny demo package to the REAL npm registry through the worker,
// to check the real request format. Without --yes it only checks and prints.
//
//   node --env-file=.env cli/scripts/npm-live.mjs [version]          dry run
//   node --env-file=.env cli/scripts/npm-live.mjs [version] --yes    really publish
//
// The artifact is served from a local http server, so the worker needs
// KEYTURN_ALLOW_HTTP=1 (set here). The registry is the real one.

import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePackage, sha256 } from '../../mock/tarball.mjs';
import { runWorkerBinary } from '../src/commands.mjs';
import { encodePackageName } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerBin = path.join(root, 'worker/target/debug/keyturn-worker' + (process.platform === 'win32' ? '.exe' : ''));
const REGISTRY = (process.env.KEYTURN_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const name = process.env.KEYTURN_DEMO_PACKAGE;
const token = process.env.NPM_TOKEN;
const version = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+/.test(a)) || '0.0.1';
const really = process.argv.includes('--yes');

if (!name || !token) throw new Error('set KEYTURN_DEMO_PACKAGE and NPM_TOKEN in .env');
if (!existsSync(workerBin)) throw new Error('build the worker first: npm run build:worker');

const tarball = makePackage(
  name,
  version,
  "module.exports = 'keyturn demo package';\n",
  {
    description: 'Demo package for Keyturn, a two-person rule for software releases',
    license: 'MIT',
  },
);
const hash = sha256(tarball);

const who = await fetch(`${REGISTRY}/-/whoami`, { headers: { authorization: `Bearer ${token}` } });
console.log(`token        ${who.ok ? `valid for "${(await who.json()).username}"` : `rejected (HTTP ${who.status})`}`);
const existing = await fetch(`${REGISTRY}/${encodePackageName(name)}`, { headers: { authorization: `Bearer ${token}` } });
let taken = false;
if (existing.status === 404) console.log(`package      ${name} does not exist yet`);
else if (existing.ok) {
  const doc = await existing.json();
  taken = Object.keys(doc.versions || {}).includes(version);
  console.log(`package      ${name} exists, versions: ${Object.keys(doc.versions || {}).join(', ') || 'none'}`);
} else console.log(`package      lookup answered HTTP ${existing.status}`);
console.log(`will publish ${name}@${version}`);
console.log(`hash         ${hash}`);
console.log(`registry     ${REGISTRY}`);
if (taken) throw new Error(`${name}@${version} is already published; pick another version`);
if (!who.ok) throw new Error('the token is not accepted');

if (!really) {
  console.log('Dry run only. Add --yes to publish for real.');
} else {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tarball.length });
    res.end(tarball);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/artifact.tgz`;

  const run = runWorkerBinary(workerBin, { NPM_TOKEN: token, KEYTURN_NPM_REGISTRY: REGISTRY, KEYTURN_ALLOW_HTTP: '1' });
  const out = await run({ mode: 'publish', package: name, version, approved_hash: hash, artifact_url: url });
  server.close();
  console.log('worker result:', JSON.stringify(out));
  process.exitCode = out.ok ? 0 : 2;
}
