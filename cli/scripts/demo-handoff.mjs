// The contract hands the release to OutLayer itself. No CLI relay, no worker account:
//
//   propose -> two approvals -> public window -> execute_release
//   -> request_publish: the contract calls outlayer.testnet request_execution with the worker
//      request it builds from the approved hash
//   -> the worker (wasm in OutLayer, holds the npm token) publishes
//   -> OutLayer calls back on_publish_result, and the contract marks the release Released
//      only if the published hash equals the approved one.
//
//   node --env-file=.env cli/scripts/demo-handoff.mjs <version> <artifact-url>                dry run
//   node --env-file=.env cli/scripts/demo-handoff.mjs <version> <artifact-url> --yes          really publish
//   node --env-file=.env cli/scripts/demo-handoff.mjs <version> <artifact-url> --yes --tamper  propose a hash the artifact does not have (nothing is published)
//   ... --resume   the release is already Executing; only ask OutLayer (again)
//
// Needs: setup-testnet.mjs and setup-outlayer.mjs done, the worker deployed to OutLayer with its
// NPM_TOKEN secret, and the artifact at a public https URL (byte-identical to the tarball this
// script builds, unless --tamper).

import { NearChain } from '../src/chain.mjs';
import * as cmd from '../src/commands.mjs';
import { makePackage } from '../../mock/tarball.mjs';
import { sha256 } from '../src/util.mjs';

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is missing in .env`); })();
const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+/.test(a));
const artifactUrl = args.find((a) => /^https:\/\//.test(a));
if (!version || !artifactUrl) throw new Error('usage: demo-handoff.mjs <version> <https artifact url> [--yes] [--tamper] [--resume]');
const really = args.includes('--yes');
const tamper = args.includes('--tamper');
const resume = args.includes('--resume');
const WINDOW_SECONDS = 20;
const DEPOSIT = 80_000_000_000_000_000_000_000n; // 0.08 NEAR = four attempts at 0.02; what is not spent comes back
const GAS = 300_000_000_000_000n; // every retry reserves the gas of the next one

const name = need('KEYTURN_DEMO_PACKAGE');
const REGISTRY = (process.env.KEYTURN_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const contractId = need('KEYTURN_CONTRACT');
const as = (id) => new NearChain({ network: 'testnet', contractId, accountId: id, rpcUrl: process.env.KEYTURN_RPC });
const A = { ada: need('KEYTURN_ACCT_ADA'), bob: need('KEYTURN_ACCT_BOB'), cy: need('KEYTURN_ACCT_CY'), ci: need('KEYTURN_ACCT_CI'), watch: need('KEYTURN_ACCT_WATCH') };
const chain = Object.fromEntries(Object.entries(A).map(([k, id]) => [k, as(id)]));
const project = `npm:${name}`;
const say = (t) => console.log(t);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const tarball = makePackage(name, version, `module.exports = 'keyturn demo ${version}';\n`, {
  description: 'Demo package for Keyturn, a two-person rule for software releases',
  license: 'MIT',
});
const realHash = sha256(tarball);
const hash = tamper ? sha256(Buffer.from(`not the tarball ${version}`)) : realHash;

// Checks that change nothing.
const settings = await chain.ada.view('get_outlayer');
if (!settings) throw new Error('the contract has no OutLayer settings; run setup-outlayer.mjs first');
const got = await fetch(artifactUrl);
if (!got.ok) throw new Error(`artifact URL answered HTTP ${got.status}`);
const served = sha256(Buffer.from(await got.arrayBuffer()));
if (!tamper && served !== realHash) throw new Error(`the artifact at that URL is not the expected tarball (${served} instead of ${realHash})`);
say(`artifact      public, serves ${served}`);
say(`approved hash ${hash}${tamper ? '  (deliberately NOT the artifact)' : ''}`);
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
say(`contract      ${contractId}`);
say(`outlayer      ${settings.contract}, worker ${settings.project}`);
if (!really) {
  say('Dry run only. Add --yes to run it for real.');
  process.exit(0);
}

let failures = 0;
const check = (ok, text) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failures++; };
const statusOf = async () => (await chain.ada.view('get_release', { project_id: project, version }))?.status;

if (!resume && !registered) {
  say('\n1. Register the project (3 maintainers, 2 must approve, CI may only propose)');
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

say('\n4. Anyone calls request_publish once. The CONTRACT calls OutLayer, and calls it again by itself if the answer is lost.');
const res = await chain.watch.callRaw('request_publish', { project_id: project, version, artifact_url: artifactUrl }, { deposit: DEPOSIT, gas: GAS });
const tx = res.transaction?.hash || res.transaction_outcome?.id;
say(`   tx ${tx}`);
// The chain ends when the contract has cleared its hand-off record: released, a final answer, or out of attempts.
let seen = 0;
let events = [];
const started = Date.now();
for (let i = 0; i < 180; i++) {
  await sleep(10);
  events = (await chain.watch.events(tx, A.watch).catch(() => [])).filter((e) => ['publish_requested', 'publish_failed', 'publish_gave_up', 'release_published'].includes(e.event));
  for (const e of events.slice(seen)) {
    const d = e.data;
    say(`   +${Math.round((Date.now() - started) / 1000)}s ${e.event}${d.error ? ' ' + d.error : ''}${d.will_retry !== undefined ? (d.will_retry ? ' (the contract asks again, ' + d.attempts_left + ' left)' : ' (final)') : ''}${d.attempts ? ' (up to ' + d.attempts + ' attempts)' : ''}`);
  }
  seen = events.length;
  const handoff = await chain.ada.view('get_handoff', { project_id: project, version });
  if (!handoff && events.some((e) => e.event !== 'publish_requested')) break;
}
const failedAttempts = events.filter((e) => e.event === 'publish_failed');
const last = [...events].reverse().find((e) => e.event === 'release_published' || e.event === 'publish_failed');
const lost = failedAttempts.filter((e) => e.data.will_retry).length;
say(`   lost or pending answers the contract retried by itself: ${lost}`);
check(!(await chain.ada.view('get_handoff', { project_id: project, version })), 'the contract holds no money for this release any more');

if (tamper) {
  // The worker itself must have answered, with its own refusal. An OutLayer-side error
  // (for example an access rule) is not the thing this step is meant to show.
  check(last?.event === 'publish_failed' && last.data.error === 'hash_mismatch' && !last.data.will_retry, `the worker refused, and that was final: ${last?.data?.error}`);
  check((await statusOf()) === 'Executing', 'the release stays Executing, nothing was published');
  const now = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`);
  const versions = now.ok ? Object.keys((await now.json()).versions || {}) : [];
  check(!versions.includes(version), `npm still has no ${version}`);
} else {
  check(last?.event === 'release_published', 'OutLayer published and called the contract back');
  check((await statusOf()) === 'Released', 'release is Released on the contract');
  say('\n5. Anyone verifies what npm serves against the contract');
  const v = await cmd.verify(chain.ada, { project, version, registryUrl: REGISTRY });
  check(v.ok, `verify: ${v.reason}`);
  say(`\n   https://www.npmjs.com/package/${name}/v/${version}`);
}
say(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
