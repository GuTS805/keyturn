// The real chain with the worker running inside OutLayer: the testnet contract decides,
// the worker (wasm, secrets held by OutLayer) publishes to the real npm registry.
//
//   node --env-file=.env cli/scripts/demo-outlayer.mjs <version> <artifact-url>          dry run
//   node --env-file=.env cli/scripts/demo-outlayer.mjs <version> <artifact-url> --yes    really publish
//   ... --yes --resume                                                                    release is already Executing
//
// Needs: .env from setup-testnet.mjs, the `outlayer` CLI logged in, the project deployed with
// its NPM_TOKEN secret (profile "default"), and the artifact at a public https URL. The
// artifact must be byte-identical to the one this script builds; it is checked before anything
// is proposed.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NearChain } from '../src/chain.mjs';
import * as cmd from '../src/commands.mjs';
import { makePackage } from '../../mock/tarball.mjs';
import { sha256 } from '../src/util.mjs';

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is missing in .env`); })();
const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+/.test(a));
const artifactUrl = args.find((a) => /^https:\/\//.test(a));
if (!version || !artifactUrl) throw new Error('usage: demo-outlayer.mjs <version> <https artifact url> [--yes] [--resume]');
const really = args.includes('--yes');
const resume = args.includes('--resume');
const OL_PROJECT = process.env.KEYTURN_OUTLAYER_PROJECT || 'hudich-keyturn.testnet/keyturn-worker';
const OL_ACCOUNT = OL_PROJECT.split('/')[0];
const WINDOW_SECONDS = 20;

const name = need('KEYTURN_DEMO_PACKAGE');
const REGISTRY = (process.env.KEYTURN_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const contractId = need('KEYTURN_CONTRACT');
const as = (id) => new NearChain({ network: 'testnet', contractId, accountId: id, rpcUrl: process.env.KEYTURN_RPC });
const A = { ada: need('KEYTURN_ACCT_ADA'), bob: need('KEYTURN_ACCT_BOB'), cy: need('KEYTURN_ACCT_CY'), ci: need('KEYTURN_ACCT_CI'), worker: need('KEYTURN_ACCT_WORKER'), watch: need('KEYTURN_ACCT_WATCH') };
const chain = Object.fromEntries(Object.entries(A).map(([k, id]) => [k, as(id)]));
const project = `npm:${name}`;
const say = (t) => console.log(t);

const tarball = makePackage(name, version, `module.exports = 'keyturn demo ${version}';\n`, {
  description: 'Demo package for Keyturn, a two-person rule for software releases',
  license: 'MIT',
});
const hash = sha256(tarball);

// Checks that change nothing.
const got = await fetch(artifactUrl);
if (!got.ok) throw new Error(`artifact URL answered HTTP ${got.status}`);
const served = sha256(Buffer.from(await got.arrayBuffer()));
if (served !== hash) throw new Error(`the artifact at that URL is not the expected tarball (${served} instead of ${hash})`);
say(`artifact      public, ${hash}`);
const existing = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`);
const published = existing.ok ? Object.keys((await existing.json()).versions || {}) : [];
say(`package       ${name}, published versions: ${published.join(', ') || 'none'}`);
if (published.includes(version) && !resume) throw new Error(`${name}@${version} is already published; pick another version`);
const registered = await chain.ada.view('get_project', { project_id: project });
const onChain = await chain.ada.view('get_release', { project_id: project, version });
if (onChain && !resume) throw new Error(`${project}@${version} was already proposed on the contract; pick another version`);
if (resume && (!onChain || onChain.status !== 'Executing' || onChain.artifact_hash !== hash)) {
  throw new Error('--resume needs a release that is Executing on the contract with this exact hash');
}
say(`contract      ${contractId}, project ${registered ? 'already registered' : 'will be registered'}`);
say(`outlayer      ${OL_PROJECT}`);
if (!really) {
  say('Dry run only. Add --yes to publish for real.');
  process.exit(0);
}

let failures = 0;
const check = (ok, text) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failures++; };
const statusOf = async () => (await chain.ada.view('get_release', { project_id: project, version }))?.status;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const dir = mkdtempSync(path.join(tmpdir(), 'keyturn-ol-'));

// One OutLayer run. The CLI prints a "Tx:" line and then the worker's JSON. A transport
// timeout is retried: asking again is safe because the worker never publishes twice.
function outlayerRun(input) {
  const file = path.join(dir, 'request.json');
  writeFileSync(file, JSON.stringify(input));
  const argv = ['run', OL_PROJECT, '--input', file, '--secrets-profile', 'default', '--secrets-account', OL_ACCOUNT];
  return new Promise((resolve, reject) => {
    const child = spawn('outlayer', argv, { shell: process.platform === 'win32' });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      const tx = /Tx:\s*(\S+)/.exec(out)?.[1];
      if (tx) say(`   outlayer tx ${tx}`);
      const start = out.indexOf('{');
      try {
        resolve(JSON.parse(out.slice(start)));
      } catch {
        reject(new Error(`no JSON from outlayer: ${out.trim().slice(-300)}`));
      }
    });
  });
}
async function runWorker(input) {
  for (let i = 0; ; i++) {
    try {
      return await outlayerRun(input);
    } catch (e) {
      if (i >= 3) throw e;
      say(`   ${e.message.split('\n')[0]} - asking again`);
      await sleep(20);
    }
  }
}

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

say('\n4. The worker inside OutLayer publishes to the real npm registry (npm shows it after a few minutes, so it asks again until it appears)');
const r = await cmd.relay(chain.worker, { project, version, artifactUrl, runWorker, pendingRetries: 30, pendingDelayMs: 15000 });
say(`   worker result: ${JSON.stringify(r.result)}`);
check(r.confirmed, 'the worker published and the contract recorded it');
check((await statusOf()) === 'Released', 'release is Released on the contract');

say('\n5. Anyone verifies what npm serves against the contract');
const v = await cmd.verify(chain.ada, { project, version, registryUrl: REGISTRY });
check(v.ok, `verify: ${v.reason}`);
say(`\n   https://www.npmjs.com/package/${name}/v/${version}`);
say(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
