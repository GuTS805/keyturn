// The transactions the dashboard builds, executed for real on testnet.
//
// The dashboard (web/actions.js) decides which buttons an account gets and builds the request that
// a NEAR wallet signs. A wallet popup cannot be driven from a script, so this does everything else
// for real: for every step it asks the dashboard's own code what the account may do, builds the
// dashboard's own request, signs it with the account's real testnet key and sends it to the real
// contract, then checks the chain. If a button were offered to the wrong account, or a request had
// wrong arguments, a deposit that is too small or too little gas, this fails.
//
//   node --env-file=.env cli/scripts/dashboard-tx-check.mjs <https artifact url>
//
// Uses two new releases of the demo package. Nothing is published to npm (the second release has a
// deliberately wrong approved hash, so the worker refuses it). The 0.1 NEAR flag bond is refunded
// when the members reject the release.

import { NearChain } from '../src/chain.mjs';
import { sha256 } from '../src/util.mjs';
import { summarize } from '../../web/keyturn.js';
import { availableActions, buildRequest } from '../../web/actions.js';

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is missing in .env`); })();
const artifactUrl = process.argv.find((a) => a.startsWith('https://'));
if (!artifactUrl) throw new Error('usage: dashboard-tx-check.mjs <https artifact url>');
const contractId = need('KEYTURN_CONTRACT');
const project = `npm:${need('KEYTURN_DEMO_PACKAGE')}`;
const as = (id) => new NearChain({ network: 'testnet', contractId, accountId: id, rpcUrl: process.env.KEYTURN_RPC });
const A = { ada: need('KEYTURN_ACCT_ADA'), bob: need('KEYTURN_ACCT_BOB'), ci: need('KEYTURN_ACCT_CI'), watch: need('KEYTURN_ACCT_WATCH') };
const chain = Object.fromEntries(Object.entries(A).map(([k, id]) => [k, as(id)]));
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const stamp = Date.now().toString(36);

let failures = 0;
const check = (ok, text) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failures++; };

async function view(version) {
  const [proj, rel, outlayer] = await Promise.all([
    chain.ada.view('get_project', { project_id: project }),
    chain.ada.view('get_release', { project_id: project, version }),
    chain.ada.view('get_outlayer'),
  ]);
  return { summary: summarize(proj, rel), handoffReady: Boolean(outlayer) };
}

/** What the dashboard would offer this account now, and the action with this id. */
async function offered(who, version, id) {
  const { summary, handoffReady } = await view(version);
  const list = availableActions({ summary, account: A[who], handoffReady });
  return { list, action: list.find((a) => a.id === id), summary };
}

/** Send the dashboard's request exactly as a wallet would sign it. */
async function press(who, version, id, value) {
  const { action } = await offered(who, version, id);
  if (!action) throw new Error(`the dashboard offers ${who} no "${id}" button on ${version}`);
  if (!action.can) throw new Error(`the "${id}" button is disabled for ${who}: ${action.note}`);
  const req = buildRequest({ contract: contractId, project, version, action, value });
  const p = req.actions[0].params;
  return chain[who].callRaw(p.methodName, p.args, { deposit: BigInt(p.deposit), gas: BigInt(p.gas), waitUntil: 'FINAL' });
}

const balance = async (id) => BigInt((await chain.ada.provider.viewAccount({ accountId: id })).amount);

// ---- Release 1: approve, flag, reject ----------------------------------------------------
const v1 = `0.0.7-ui-${stamp}-a`;
console.log(`\nRelease ${v1}: approve, flag, reject`);
await chain.ci.call('propose_release', { project_id: project, version: v1, artifact_hash: sha256(Buffer.from(`ui check ${v1}`)) });
let o = await offered('ada', v1, 'approve');
check(o.action?.can === true, 'a member is offered "Approve this hash"');
o = await offered('watch', v1, 'approve');
check(o.action?.can === false, 'a non-member sees the approve button disabled');
await press('ada', v1, 'approve');
o = await offered('ada', v1, 'approve');
check(o.action?.can === false && /already approved/.test(o.action.note), 'after approving, the same member cannot approve again');
await press('bob', v1, 'approve');
check((await view(v1)).summary.status === 'Pending', 'two approvals: the release is Pending, its public window is open');
o = await offered('watch', v1, 'flag');
check(o.action?.can === true && Boolean(o.action), 'anyone with a wallet is offered "Flag it" during the window');
const before = await balance(A.watch);
await press('watch', v1, 'flag', 'ui check: the dashboard flag button');
let s = (await view(v1)).summary;
check(s.status === 'Flagged' && s.flag?.reason === 'ui check: the dashboard flag button', 'the flag blocked the release, with the reason given');
await press('ada', v1, 'reject');
await press('bob', v1, 'reject');
s = (await view(v1)).summary;
check(s.status === 'Rejected', 'two members voted to reject: the release is Rejected');
const net = (await balance(A.watch)) - before;
// The flagger paid 0.1 NEAR as a bond and got it back: over the whole round the account lost only gas.
check(net > -20_000_000_000_000_000_000_000n, `the 0.1 NEAR flag bond came back to the flagger (net ${(Number(net) / 1e24).toFixed(4)} NEAR over bond, refund and gas)`);

// ---- Release 2: approve, execute, hand to OutLayer ---------------------------------------
const v2 = `0.0.7-ui-${stamp}-b`;
console.log(`\nRelease ${v2}: approve, execute, hand to OutLayer`);
await chain.ci.call('propose_release', { project_id: project, version: v2, artifact_hash: sha256(Buffer.from(`ui check ${v2} (not the tarball)`)) });
await press('ada', v2, 'approve');
await press('bob', v2, 'approve');
o = await offered('watch', v2, 'execute');
check(!o.action, 'no "Start execution" button while the public window is still open');
await sleep(24);
o = await offered('watch', v2, 'execute');
check(o.action?.can === true, 'after the window, "Start execution" is offered to anyone');
await press('watch', v2, 'execute');
check((await view(v2)).summary.status === 'Executing', 'the release is Executing');
o = await offered('watch', v2, 'handoff');
check(o.action?.can === true, '"Hand to OutLayer" is offered (the contract has OutLayer settings)');
const bad = await press('watch', v2, 'handoff', 'http://example.test/x.tgz').then(() => 'sent', (e) => e.message);
check(bad !== 'sent', 'a plain http URL is refused by the dashboard before anything is sent');
await press('watch', v2, 'handoff', artifactUrl);
let answer;
for (let i = 0; i < 60 && !answer; i++) {
  await sleep(10);
  const h = await chain.ada.view('get_handoff', { project_id: project, version: v2 });
  if (!h) answer = true;
}
check(Boolean(answer), 'the contract finished the hand-off and holds no money for it');
s = (await view(v2)).summary;
check(s.status === 'Executing', 'the worker refused the wrong hash, so the release stays Executing (nothing published)');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
