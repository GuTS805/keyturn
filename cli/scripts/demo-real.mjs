// The whole chain with nothing mocked: the testnet contract decides, the real
// worker binary publishes, and the package lands on the real npm registry.
//
//   node --env-file=.env cli/scripts/demo-real.mjs [version]          dry run: checks only
//   node --env-file=.env cli/scripts/demo-real.mjs [version] --yes    really publish
//   ... --yes --resume                                                confirm a release that is Executing and already on npm
//
// Needs .env from setup-testnet.mjs plus NPM_TOKEN and KEYTURN_DEMO_PACKAGE,
// and the worker built (npm run build:worker). The artifact is served from a
// local http server, so the worker runs with KEYTURN_ALLOW_HTTP=1.

import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NearChain } from '../src/chain.mjs';
import * as cmd from '../src/commands.mjs';
import { makePackage } from '../../mock/tarball.mjs';
import { sha256, encodePackageName } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerBin = path.join(root, 'worker/target/debug/keyturn-worker' + (process.platform === 'win32' ? '.exe' : ''));
if (!existsSync(workerBin)) throw new Error('build the worker first: npm run build:worker');

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is missing in .env`); })();
const REGISTRY = (process.env.KEYTURN_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const name = need('KEYTURN_DEMO_PACKAGE');
const token = need('NPM_TOKEN');
const version = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+/.test(a));
if (!version) throw new Error('give a version that is not published yet, for example 0.0.2');
const really = process.argv.includes('--yes');
const resume = process.argv.includes('--resume');
const WINDOW_SECONDS = 20;

const contractId = need('KEYTURN_CONTRACT');
const as = (id) => new NearChain({ network: 'testnet', contractId, accountId: id, rpcUrl: process.env.KEYTURN_RPC });
const A = { ada: need('KEYTURN_ACCT_ADA'), bob: need('KEYTURN_ACCT_BOB'), cy: need('KEYTURN_ACCT_CY'), ci: need('KEYTURN_ACCT_CI'), worker: need('KEYTURN_ACCT_WORKER'), watch: need('KEYTURN_ACCT_WATCH') };
const chain = Object.fromEntries(Object.entries(A).map(([k, id]) => [k, as(id)]));
const project = `npm:${name}`;

const say = (t) => console.log(t);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const tarball = makePackage(name, version, `module.exports = 'keyturn demo ${version}';\n`, {
  description: 'Demo package for Keyturn, a two-person rule for software releases',
  license: 'MIT',
});
const hash = sha256(tarball);

// Checks that change nothing.
const who = await fetch(`${REGISTRY}/-/whoami`, { headers: { authorization: `Bearer ${token}` } });
if (!who.ok) throw new Error(`npm rejected the token (HTTP ${who.status})`);
say(`npm token     valid for "${(await who.json()).username}"`);
const existing = await fetch(`${REGISTRY}/${encodePackageName(name)}`, { headers: { authorization: `Bearer ${token}` } });
const published = existing.ok ? Object.keys((await existing.json()).versions || {}) : [];
say(`package       ${name}, published versions: ${published.join(', ') || 'none'}`);
if (published.includes(version) && !resume) throw new Error(`${name}@${version} is already published; pick another version`);
const registered = await chain.ada.view('get_project', { project_id: project });
const onChain = await chain.ada.view('get_release', { project_id: project, version });
if (onChain && !resume) throw new Error(`${project}@${version} was already proposed on the contract; pick another version`);
if (resume) {
  if (!onChain || onChain.status !== 'Executing' || onChain.artifact_hash !== hash) {
    throw new Error('--resume needs a release that is Executing on the contract with this exact hash');
  }
  say('resuming     the release is Executing; the worker will confirm what npm serves');
}
say(`contract      ${contractId}, project ${registered ? 'already registered' : 'will be registered'}`);
say(`will publish  ${name}@${version}  hash ${hash}`);
if (!really) {
  say('Dry run only. Add --yes to publish for real.');
  process.exit(0);
}

let failures = 0;
const check = (ok, text) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failures++; };
const statusOf = async () => (await chain.ada.view('get_release', { project_id: project, version }))?.status;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tarball.length });
  res.end(tarball);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const artifactUrl = `http://127.0.0.1:${server.address().port}/artifact.tgz`;
const runWorker = cmd.runWorkerBinary(workerBin, { NPM_TOKEN: token, KEYTURN_NPM_REGISTRY: REGISTRY, KEYTURN_ALLOW_HTTP: '1' });

try {
  if (!resume && !registered) {
    say('\n1. Register the project on the contract (3 maintainers, 2 must approve, CI may only propose)');
    await cmd.register(chain.ada, { project, registry: 'npm', members: [A.ada, A.bob, A.cy].join(','), proposers: A.ci, threshold: 2, windowHours: WINDOW_SECONDS / 3600 });
  }
  if (!resume) {
    say('\n2. CI proposes the hash; two maintainers approve');
    await chain.ci.call('propose_release', { project_id: project, version, artifact_hash: hash });
    await cmd.approve(chain.ada, { project, version });
    await cmd.approve(chain.bob, { project, version });
    check((await statusOf()) === 'Pending', 'quorum reached, the public window is open');

    say(`\n3. Wait ${WINDOW_SECONDS + 4}s for the window, then anyone starts execution`);
    await sleep(WINDOW_SECONDS + 4);
    await cmd.execute(chain.watch, { project, version });
    check((await statusOf()) === 'Executing', 'release is Executing');
  }

  say('\n4. The worker publishes to the real npm registry (npm shows a new version after a few minutes, so it asks again until it appears)');
  const r = await cmd.relay(chain.worker, { project, version, artifactUrl, runWorker, pendingRetries: 30, pendingDelayMs: 15000 });
  say(`   worker result: ${JSON.stringify(r.result)}`);
  check(r.confirmed, 'the worker published and the contract recorded it');
  check((await statusOf()) === 'Released', 'release is Released on the contract');

  say('\n5. Anyone verifies what npm serves against the contract');
  const v = await cmd.verify(chain.ada, { project, version, registryUrl: REGISTRY });
  check(v.ok, `verify: ${v.reason}`);
  say(`\n   https://www.npmjs.com/package/${name}/v/${version}`);
} finally {
  server.close();
}
say(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
