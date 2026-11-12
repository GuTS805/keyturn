import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cmd from '../src/commands.mjs';

class StubChain {
  constructor() { this.calls = []; }
  async view() { return { status: 'Executing', artifact_hash: 'a'.repeat(64) }; }
  async call(method, args) { this.calls.push({ method, args }); }
}

const pending = { ok: false, published_hash: null, error: 'pending', detail: 'wait' };
const done = { ok: true, published_hash: 'a'.repeat(64), error: null, detail: null };

test('relay asks again while the registry has not shown the version, then confirms once', async () => {
  const chain = new StubChain();
  const answers = [pending, pending, done];
  let runs = 0;
  const r = await cmd.relay(chain, {
    project: 'npm:x', version: '1.0.0', artifactUrl: 'https://a.test/x.tgz',
    runWorker: async () => answers[runs++], pendingRetries: 5, pendingDelayMs: 1,
  });
  assert.equal(r.confirmed, true);
  assert.equal(runs, 3);
  assert.equal(chain.calls.length, 1);
});

test('relay gives up after the retries and confirms nothing', async () => {
  const chain = new StubChain();
  let runs = 0;
  const r = await cmd.relay(chain, {
    project: 'npm:x', version: '1.0.0', artifactUrl: 'https://a.test/x.tgz',
    runWorker: async () => { runs++; return pending; }, pendingRetries: 2, pendingDelayMs: 1,
  });
  assert.equal(r.confirmed, false);
  assert.equal(runs, 3);
  assert.equal(chain.calls.length, 0);
});

test('relay does not retry a real failure', async () => {
  const chain = new StubChain();
  let runs = 0;
  const r = await cmd.relay(chain, {
    project: 'npm:x', version: '1.0.0', artifactUrl: 'https://a.test/x.tgz',
    runWorker: async () => { runs++; return { ok: false, error: 'hash_mismatch' }; }, pendingRetries: 5, pendingDelayMs: 1,
  });
  assert.equal(r.confirmed, false);
  assert.equal(runs, 1);
});
