import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attest, eventsOf } from '../src/attest.mjs';

// A real transaction from testnet: request_publish for @scammerop08/keyturn-demo@0.0.5, saved with
// only its logs, and OutLayer's public record and attestation of that run (job 98626). It is the
// run in which the contract called OutLayer, the worker published and the contract recorded it.
const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const REAL = read('attest-tx.json');
const RECORD = read('attest-record.json');
const CONTRACT = 'contract.hudich-keyturn.testnet';
const SIGNER = 'watch.hudich-keyturn.testnet';
const PIN = 'f52458e9a998f1c5bb9802b61bca50c22cbc6bc60507e7e045631e32a444facd';
const HASH = '59a6a416eaa98dd0172042c59d6ca74219a29d1e05103b51099fe8e0c62efa1d';

const config = { contract: 'outlayer.testnet', project: 'hudich-keyturn.testnet/keyturn-worker', version_key: PIN, secrets_profile: 'default', secrets_account: 'hudich-keyturn.testnet' };
const release = { status: 'Released', artifact_hash: HASH };
const chainWith = ({ cfg = config, rel = release } = {}) => ({
  contractId: CONTRACT,
  network: 'testnet',
  async view(method) {
    return method === 'get_outlayer' ? cfg : method === 'get_release' ? rel : null;
  },
});
const copy = (x) => JSON.parse(JSON.stringify(x));
const missing = async () => ({ status: 'missing', text: '' });
// No network in tests: the transaction and OutLayer's record are given.
const run = (over = {}, chain = chainWith()) => attest(chain, { tx: REAL, record: RECORD, signer: SIGNER, verifier: missing, ...over });
const by = (r, re) => r.checks.find((c) => re.test(c.text));

test('a real OutLayer release passes every chain and record check; the TEE quote is reported as not checked here', async () => {
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.teeChecked, false);
  assert.equal(r.jobId, 98626);
  assert.deepEqual(r.checks.filter((c) => c.ok === false), []);
  assert.equal(r.checks.filter((c) => c.ok === true).length, 14);
  assert.equal(by(r, /TEE quote/).ok, null);
  assert.match(by(r, /TEE quote/).text, /NOT CHECKED HERE/);
  assert.match(by(r, /TEE quote/).text, /attestation\/98626/);
});

test('the TEE verdict of outlayer-verify is passed through', async () => {
  const proven = await run({ verifier: async (job) => ({ status: 'proven', text: `PROVEN task ${job}` }) });
  assert.equal(proven.teeChecked, true);
  assert.equal(by(proven, /TEE quote/).ok, true);
  assert.match(by(proven, /TEE quote/).text, /task 98626/);
  const failed = await run({ verifier: async () => ({ status: 'failed', text: 'Binding FAIL' }) });
  assert.equal(failed.ok, false);
  const unproven = await run({ verifier: async () => ({ status: 'unproven', text: 'no collateral' }) });
  assert.equal(unproven.ok, true);
  assert.equal(unproven.teeChecked, false);
});

test('a different build than the pinned one is caught', async () => {
  const r = await run({}, chainWith({ cfg: { ...config, version_key: 'e'.repeat(64) } }));
  assert.equal(r.ok, false);
  assert.equal(by(r, /pins/).ok, false);
  assert.equal(by(r, /pinned build, and the executed binary/).ok, false);
});

test('a request that did not carry the approved hash is caught', async () => {
  const r = await run({}, chainWith({ rel: { ...release, artifact_hash: 'b'.repeat(64) } }));
  assert.equal(r.ok, false);
  assert.equal(by(r, /carried the approved hash/).ok, false);
  assert.equal(by(r, /recorded Released/).ok, false);
});

test('a call that OutLayer received from someone else is caught', async () => {
  const tx = copy(REAL);
  for (const o of tx.receipts_outcome) {
    o.outcome.logs = o.outcome.logs.map((l) => l.replace(/predecessor_id\\":\\"contract\.hudich-keyturn\.testnet/, 'predecessor_id\\":\\"mallory.testnet'));
  }
  const r = await run({ tx });
  assert.equal(by(r, /called by the contract itself/).ok, false);
  assert.equal(r.ok, false);
});

test('a run that failed, or a transaction to another contract, is caught', async () => {
  const failedRun = copy(REAL);
  for (const o of failedRun.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l) => l.replace('"success": true', '"success": false').replace('"success":true', '"success":false'));
  assert.equal(by(await run({ tx: failedRun }), /run succeeded/).ok, false);
  const other = copy(REAL);
  other.transaction.receiver_id = 'someone.testnet';
  assert.equal((await run({ tx: other })).checks[0].ok, false);
});

test('a contract without OutLayer settings stops early', async () => {
  const r = await run({}, chainWith({ cfg: null }));
  assert.equal(r.ok, false);
  assert.equal(r.checks.length, 2);
});

test("OutLayer's record is checked against the chain, not trusted", async () => {
  const badInput = copy(RECORD);
  badInput.attestation.input_hash = 'c'.repeat(64);
  assert.equal(by(await run({ record: badInput }), /input hash/).ok, false);
  const otherBuild = copy(RECORD);
  otherBuild.attestation.executed_wasm_sha256 = 'd'.repeat(64);
  assert.equal(by(await run({ record: otherBuild }), /pinned build, and the executed binary/).ok, false);
  const wrongTx = copy(RECORD);
  wrongTx.attestation.transaction_hash = 'X'.repeat(44);
  assert.equal(by(await run({ record: wrongTx }), /names this transaction/).ok, false);
  assert.equal((await run({ record: { job: null, attestation: null } })).ok, false);
  assert.equal(by(await run({ record: { job: RECORD.job, attestation: null } }), /no attestation/).ok, false);
});

test("the record is looked up through OutLayer's public API by signer and transaction hash", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('/public/jobs')) return { ok: true, json: async () => [{ job_id: 1, transaction_hash: 'other' }, RECORD.job] };
    return { ok: true, json: async () => RECORD.attestation };
  };
  const r = await attest(chainWith(), { tx: REAL, signer: SIGNER, fetchImpl, verifier: missing });
  assert.equal(r.ok, true);
  assert.equal(r.jobId, 98626);
  assert.match(seen[0], /testnet-api\.outlayer\.ai\/public\/jobs\?user_account_id=watch\.hudich-keyturn\.testnet/);
  assert.match(seen[1], /testnet-api\.outlayer\.ai\/attestations\/98626$/);
});

test('events are read by executor', () => {
  assert.ok(eventsOf(REAL, 'outlayer').some((e) => e.event === 'execution_requested'));
  assert.ok(eventsOf(REAL, CONTRACT).some((e) => e.event === 'release_published'));
});
