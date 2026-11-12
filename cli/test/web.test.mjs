import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rpcView, summarize, sha256Hex, formatDuration } from '../../web/keyturn.js';

const project = { threshold: 2, members: ['a.test', 'b.test', 'c.test'], registry: 'Npm' };
const release = (over = {}) => ({
  status: 'Pending', artifact_hash: 'ab'.repeat(32), approvals: ['a.test', 'b.test'], proposer: 'ci.test',
  ready_at_ms: 10_000_000, flag: null, ...over,
});

test('rpcView sends a call_function query and decodes the bytes', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    const bytes = [...new TextEncoder().encode(JSON.stringify({ status: 'Released' }))];
    return { ok: true, json: async () => ({ result: { result: bytes } }) };
  };
  const r = await rpcView({ rpc: 'https://rpc.test', contract: 'k.test', method: 'get_release', args: { project_id: 'npm:x', version: '1.0.0' }, fetchImpl });
  assert.deepEqual(r, { status: 'Released' });
  assert.equal(seen.body.params.method_name, 'get_release');
  assert.equal(seen.body.params.account_id, 'k.test');
  assert.deepEqual(JSON.parse(Buffer.from(seen.body.params.args_base64, 'base64').toString()), { project_id: 'npm:x', version: '1.0.0' });
});

test('rpcView turns RPC and contract errors into exceptions', async () => {
  await assert.rejects(() => rpcView({ rpc: 'x', contract: 'k', method: 'm', fetchImpl: async () => ({ ok: false, status: 502 }) }), /HTTP 502/);
  await assert.rejects(
    () => rpcView({ rpc: 'x', contract: 'k', method: 'm', fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: 'bad' } }) }) }),
    /bad/,
  );
  await assert.rejects(
    () => rpcView({ rpc: 'x', contract: 'k', method: 'm', fetchImpl: async () => ({ ok: true, json: async () => ({ result: { error: 'account does not exist' } }) }) }),
    /does not exist/,
  );
  const empty = await rpcView({ rpc: 'x', contract: 'k', method: 'm', fetchImpl: async () => ({ ok: true, json: async () => ({ result: { result: [] } }) }) });
  assert.equal(empty, null);
});

test('summarize reports the window, approvals and flags', () => {
  const open = summarize(project, release(), 10_000_000 - 90 * 60_000);
  assert.equal(open.windowOpen, true);
  assert.equal(open.windowRemainingMs, 90 * 60_000);
  assert.equal(open.needed, 2);
  const closed = summarize(project, release(), 10_000_000 + 1);
  assert.equal(closed.windowOpen, false);
  assert.equal(summarize(project, release({ status: 'Flagged', flag: { by: 'w.test', reason: 'x' } })).flag.by, 'w.test');
  assert.equal(summarize(null, null).found, false);
  assert.equal(summarize(project, null).message, 'This version has not been proposed.');
});

test('hashing and durations', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(formatDuration(30 * 60_000), '30 min');
  assert.equal(formatDuration(90 * 60_000), '1 h 30 min');
  assert.equal(formatDuration(3 * 24 * 3_600_000), '3 days 0 h');
});
