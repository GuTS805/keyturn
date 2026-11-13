import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attest, eventsOf } from '../src/attest.mjs';

// A real transaction from testnet: request_publish for @scammerop08/keyturn-demo@0.0.4, saved with
// only its logs. It is the one in which the contract called OutLayer and recorded the release.
const REAL = JSON.parse(readFileSync(new URL('./fixtures/attest-tx.json', import.meta.url), 'utf8'));
const CONTRACT = 'contract.hudich-keyturn.testnet';
const PIN = 'f52458e9a998f1c5bb9802b61bca50c22cbc6bc60507e7e045631e32a444facd';
const HASH = 'af1f043c8b4f0e29a7c7907140ce822c7dc172dcce12c90e00f8ce2cc01ecf14';

const config = { contract: 'outlayer.testnet', project: 'hudich-keyturn.testnet/keyturn-worker', version_key: PIN, secrets_profile: 'default', secrets_account: 'hudich-keyturn.testnet' };
const release = { status: 'Released', artifact_hash: HASH };
const chainWith = ({ cfg = config, rel = release } = {}) => ({
  contractId: CONTRACT,
  async view(method) {
    return method === 'get_outlayer' ? cfg : method === 'get_release' ? rel : null;
  },
});
const clone = () => JSON.parse(JSON.stringify(REAL));
const missing = async () => ({ status: 'missing', text: '' });
const by = (r, re) => r.checks.find((c) => re.test(c.text));

test('a real OutLayer release passes every chain check; the TEE quote is reported as not checked', async () => {
  const r = await attest(chainWith(), { tx: REAL, verifier: missing });
  assert.equal(r.ok, true);
  assert.equal(r.teeChecked, false);
  assert.deepEqual(r.checks.filter((c) => c.ok === false), []);
  assert.equal(r.checks.filter((c) => c.ok === true).length, 9);
  assert.equal(by(r, /TEE quote/).ok, null);
  assert.match(by(r, /TEE quote/).text, /NOT CHECKED/);
});

test('the TEE verdict of outlayer-verify is passed through', async () => {
  const proven = await attest(chainWith(), { tx: REAL, verifier: async () => ({ status: 'proven', text: 'PROVEN task 1' }) });
  assert.equal(proven.teeChecked, true);
  assert.equal(by(proven, /TEE quote/).ok, true);
  const failed = await attest(chainWith(), { tx: REAL, verifier: async () => ({ status: 'failed', text: 'Binding FAIL' }) });
  assert.equal(failed.ok, false);
  const unproven = await attest(chainWith(), { tx: REAL, verifier: async () => ({ status: 'unproven', text: 'no collateral' }) });
  assert.equal(unproven.ok, true);
  assert.equal(unproven.teeChecked, false);
});

test('a different build than the pinned one is caught', async () => {
  const r = await attest(chainWith({ cfg: { ...config, version_key: 'e'.repeat(64) } }), { tx: REAL, verifier: missing });
  assert.equal(r.ok, false);
  assert.equal(by(r, /pins/).ok, false);
});

test('a request that did not carry the approved hash is caught', async () => {
  const r = await attest(chainWith({ rel: { ...release, artifact_hash: 'b'.repeat(64) } }), { tx: REAL, verifier: missing });
  assert.equal(r.ok, false);
  assert.equal(by(r, /carried the approved hash/).ok, false);
  assert.equal(by(r, /recorded Released/).ok, false);
});

test('a call that OutLayer received from someone else is caught', async () => {
  const tx = clone();
  for (const o of tx.receipts_outcome) {
    o.outcome.logs = o.outcome.logs.map((l) => l.replace(/predecessor_id\\":\\"contract\.hudich-keyturn\.testnet/, 'predecessor_id\\":\\"mallory.testnet'));
  }
  const r = await attest(chainWith(), { tx, verifier: missing });
  assert.equal(by(r, /called by the contract itself/).ok, false);
  assert.equal(r.ok, false);
});

test('a run that failed, or a transaction to another contract, is caught', async () => {
  const failedRun = clone();
  for (const o of failedRun.receipts_outcome) o.outcome.logs = o.outcome.logs.map((l) => l.replace('"success": true', '"success": false').replace('"success":true', '"success":false'));
  assert.equal(by(await attest(chainWith(), { tx: failedRun, verifier: missing }), /run succeeded/).ok, false);
  const other = clone();
  other.transaction.receiver_id = 'someone.testnet';
  const r = await attest(chainWith(), { tx: other, verifier: missing });
  assert.equal(r.checks[0].ok, false);
});

test('a contract without OutLayer settings stops early', async () => {
  const r = await attest(chainWith({ cfg: null }), { tx: REAL, verifier: missing });
  assert.equal(r.ok, false);
  assert.equal(r.checks.length, 2);
});

test('events are read by executor', () => {
  assert.ok(eventsOf(REAL, 'outlayer').some((e) => e.event === 'execution_requested'));
  assert.ok(eventsOf(REAL, CONTRACT).some((e) => e.event === 'release_published'));
});
