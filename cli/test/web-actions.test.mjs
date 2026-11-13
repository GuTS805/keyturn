import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../../web/keyturn.js';
import { availableActions, buildRequest, checkInput } from '../../web/actions.js';
import { createWallet, eventsFromOutcome } from '../../web/wallet.js';

const project = { id: 'npm:x', registry: 'Npm', members: ['ada.test', 'bob.test', 'cy.test'], proposers: ['ci.test'], threshold: 2 };
const release = (o = {}) => ({
  project_id: 'npm:x', version: '1.0.0', artifact_hash: 'a'.repeat(64), proposer: 'ci.test', status: 'Proposed',
  approvals: [], ready_at_ms: null, flag: null, dismiss_votes: [], reject_votes: [], recall_votes: [], ...o,
});
const sum = (o, now = 1000) => summarize(project, release(o), now);
const ids = (list) => list.map((a) => a.id);
const by = (list, id) => list.find((a) => a.id === id);

test('nothing to show for a version that does not exist', () => {
  assert.deepEqual(availableActions({ summary: summarize(project, null), account: 'ada.test' }), []);
});

test('Proposed: only a member who has not approved may approve', () => {
  const s = sum({ approvals: ['ada.test'] });
  const a = (account) => by(availableActions({ summary: s, account }), 'approve');
  assert.equal(a('ada.test').can, false);
  assert.match(a('ada.test').note, /already approved/);
  assert.equal(a('bob.test').can, true);
  assert.equal(a('mallory.test').can, false);
  assert.equal(a(null).can, false);
  assert.match(a(null).note, /Connect a wallet/);
});

test('Pending: anyone can flag while the window is open, and anyone can execute after it', () => {
  const s = sum({ status: 'Pending', ready_at_ms: 5000 }, 1000);
  const open = availableActions({ summary: s, account: 'mallory.test', nowMs: 1000 });
  assert.deepEqual(ids(open), ['flag', 'reject']);
  assert.equal(by(open, 'flag').can, true);
  assert.equal(by(open, 'reject').can, false, 'a stranger cannot vote');
  const closed = availableActions({ summary: s, account: 'mallory.test', nowMs: 5000 });
  assert.deepEqual(ids(closed), ['execute', 'reject']);
  assert.equal(by(closed, 'execute').can, true);
});

test('Flagged: members vote once', () => {
  const s = sum({ status: 'Flagged', flag: { by: 'w.test', reason: 'x' }, dismiss_votes: ['ada.test'], reject_votes: ['bob.test'] });
  const l = (account) => availableActions({ summary: s, account });
  assert.equal(by(l('ada.test'), 'dismiss').can, false);
  assert.equal(by(l('bob.test'), 'dismiss').can, true);
  assert.equal(by(l('bob.test'), 'reject').can, false);
  assert.equal(by(l('cy.test'), 'reject').can, true);
});

test('Executing: the hand-off is offered to anyone, but only when the contract has OutLayer settings', () => {
  const s = sum({ status: 'Executing' });
  const on = availableActions({ summary: s, account: 'mallory.test', handoffReady: true });
  assert.deepEqual(ids(on), ['handoff']);
  assert.equal(on[0].can, true);
  assert.equal(on[0].needs, 'artifactUrl');
  const off = availableActions({ summary: s, account: 'mallory.test', handoffReady: false });
  assert.equal(off[0].can, false);
  assert.match(off[0].note, /CLI relay/);
});

test('Released: members can vote to recall; Rejected and Recalled offer nothing', () => {
  assert.equal(by(availableActions({ summary: sum({ status: 'Released' }), account: 'ada.test' }), 'recall').can, true);
  assert.equal(by(availableActions({ summary: sum({ status: 'Released' }), account: 'zed.test' }), 'recall').can, false);
  assert.deepEqual(availableActions({ summary: sum({ status: 'Rejected' }), account: 'ada.test' }), []);
  assert.deepEqual(availableActions({ summary: sum({ status: 'Recalled' }), account: 'ada.test' }), []);
});

test('input rules mirror the contract', () => {
  const flag = { needs: 'reason' };
  assert.match(checkInput(flag, '  '), /reason/);
  assert.match(checkInput(flag, 'x'.repeat(501)), /500/);
  assert.equal(checkInput(flag, 'postinstall downloads a binary'), '');
  const url = { needs: 'artifactUrl' };
  assert.match(checkInput(url, 'http://a.test/x.tgz'), /https/);
  assert.match(checkInput(url, 'javascript:alert(1)'), /https/);
  assert.match(checkInput(url, 'https://a.test/has space'), /https/);
  assert.equal(checkInput(url, 'https://a.test/x.tgz'), '');
  assert.equal(checkInput({}, ''), '');
});

test('buildRequest produces the wallet format with exact deposits and gas', () => {
  const s = sum({ status: 'Pending', ready_at_ms: 5000 });
  const flag = by(availableActions({ summary: s, account: 'w.test', nowMs: 1000 }), 'flag');
  const r = buildRequest({ contract: 'k.test', project: 'npm:x', version: '1.0.0', action: flag, value: ' bad install script ' });
  assert.deepEqual(r, {
    receiverId: 'k.test',
    actions: [{ type: 'FunctionCall', params: { methodName: 'flag_release', args: { project_id: 'npm:x', version: '1.0.0', reason: 'bad install script' }, gas: '60000000000000', deposit: '100000000000000000000000' } }],
  });
  const hand = by(availableActions({ summary: sum({ status: 'Executing' }), account: 'w.test' }), 'handoff');
  const h = buildRequest({ contract: 'k.test', project: 'npm:x', version: '1.0.0', action: hand, value: 'https://a.test/x.tgz' });
  assert.equal(h.actions[0].params.methodName, 'request_publish');
  assert.deepEqual(h.actions[0].params.args, { project_id: 'npm:x', version: '1.0.0', artifact_url: 'https://a.test/x.tgz' });
  assert.equal(h.actions[0].params.deposit, '30000000000000000000000'); // 0.03 NEAR
  assert.equal(h.actions[0].params.gas, '250000000000000');
  const ap = by(availableActions({ summary: sum({}), account: 'ada.test' }), 'approve');
  const a = buildRequest({ contract: 'k.test', project: 'npm:x', version: '1.0.0', action: ap });
  assert.equal(a.actions[0].params.deposit, '0');
  assert.deepEqual(a.actions[0].params.args, { project_id: 'npm:x', version: '1.0.0' });
  assert.throws(() => buildRequest({ contract: 'k.test', project: 'npm:x', version: '1.0.0', action: flag, value: '' }), /reason/);
});

// A stand-in for @hot-labs/near-connect.
function fakeConnector({ account = 'ada.test', fail = false } = {}) {
  const handlers = {};
  const sent = [];
  class NearConnector {
    constructor(opts) {
      this.opts = opts;
      this.whenManifestLoaded = Promise.resolve();
    }
    on(name, fn) { handlers[name] = fn; }
    async connect() {
      const w = { signAndSendTransaction: async (req) => { sent.push(req); if (fail) throw new Error('User rejected'); return { transaction: { hash: 'HASH1' }, receipts_outcome: [] }; } };
      this.w = w;
      await handlers['wallet:signIn']({ accounts: [{ accountId: account }] });
      return w;
    }
    async wallet() { return this.w; }
    async getConnectedWallet() { if (!this.w) throw new Error('none'); return { wallet: this.w, accounts: [{ accountId: account }] }; }
    async disconnect() { this.w = null; handlers['wallet:signOut'](); }
  }
  return { load: async () => ({ NearConnector }), sent, handlers };
}

test('wallet: connect, send, disconnect', async () => {
  const f = fakeConnector();
  const seen = [];
  const w = createWallet({ network: 'testnet', load: f.load, onChange: (a) => seen.push(a) });
  assert.equal(w.account(), null);
  await assert.rejects(() => w.send({}), /Connect a wallet/);
  assert.equal(await w.connect(), 'ada.test');
  const out = await w.send({ receiverId: 'k.test', actions: [] });
  assert.equal(out.transaction.hash, 'HASH1');
  assert.equal(f.sent.length, 1);
  await w.disconnect();
  assert.equal(w.account(), null);
  assert.deepEqual(seen, ['ada.test', null]);
});

test('wallet: a rejected signature surfaces as an error and leaves the account connected', async () => {
  const f = fakeConnector({ fail: true });
  const w = createWallet({ load: f.load });
  await w.connect();
  await assert.rejects(() => w.send({ receiverId: 'k.test', actions: [] }), /User rejected/);
  assert.equal(w.account(), 'ada.test');
});

test('wallet: the connector is only loaded when asked, and a failed load is reported', async () => {
  let loads = 0;
  const w = createWallet({ load: async () => { loads++; throw new Error('CDN down'); } });
  assert.equal(loads, 0);
  await assert.rejects(() => w.connect(), /CDN down/);
  assert.equal(loads, 1);
});

test('events are read from a wallet outcome', () => {
  const outcome = { receipts_outcome: [
    { outcome: { logs: ['plain log', 'EVENT_JSON:{"standard":"near-outlayer","event":"x"}'] } },
    { outcome: { logs: ['EVENT_JSON:{"standard":"keyturn","event":"publish_failed","data":{"error":"pending"}}', 'EVENT_JSON:{broken'] } },
  ] };
  const e = eventsFromOutcome(outcome);
  assert.equal(e.length, 1);
  assert.equal(e[0].data.error, 'pending');
  assert.deepEqual(eventsFromOutcome(null), []);
});
