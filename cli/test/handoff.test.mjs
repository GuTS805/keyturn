import test from 'node:test';
import assert from 'node:assert/strict';
import { handoff } from '../src/commands.mjs';

// A chain whose release becomes Released on a chosen request_publish round, and whose rounds end
// with the given worker errors until then.
function fakeChain({ answers, status = 'Executing' }) {
  let round = 0;
  let running = 0; // polls during which a hand-off record exists
  let current = status;
  const calls = [];
  return {
    accountId: 'caller.test',
    calls,
    async view(method) {
      if (method === 'get_release') return { status: current };
      if (method === 'get_handoff') return running-- > 0 ? { attempts_left: 1 } : null;
      throw new Error(method);
    },
    async callRaw(method, args, opts) {
      calls.push({ method, args, opts });
      const a = answers[round++];
      if (a === 'released') current = 'Released';
      running = 2;
      this.last = a;
      return { transaction: { hash: `TX${round}` } };
    },
    async events() {
      const a = this.last;
      return a && a !== 'released' ? [{ event: 'publish_failed', data: { error: a } }] : [];
    },
  };
}
const quick = { pollMs: 0, sleep: async () => {}, artifactUrl: 'https://a.test/x.tgz', project: 'npm:x', version: '1.0.0' };

test('asks again after lost answers until the release is Released', async () => {
  const chain = fakeChain({ answers: ['outlayer_call_failed', 'unreadable_answer', 'pending', 'released'] });
  const r = await handoff(chain, quick);
  assert.equal(r.ok, true);
  assert.equal(r.rounds, 4);
  assert.equal(chain.calls.length, 4);
  assert.equal(chain.calls[0].method, 'request_publish');
  assert.deepEqual(chain.calls[0].args, { project_id: 'npm:x', version: '1.0.0', artifact_url: 'https://a.test/x.tgz' });
  assert.equal(chain.calls[0].opts.gas, 300_000_000_000_000n);
  assert.equal(chain.calls[0].opts.deposit, 80_000_000_000_000_000_000_000n);
});

test('after a pending answer it waits before asking again', async () => {
  const waits = [];
  const chain = fakeChain({ answers: ['pending', 'released'] });
  const r = await handoff(chain, { ...quick, pendingWaitMs: 60000, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r.ok, true);
  assert.ok(waits.includes(60000), 'it waited a minute after pending');
});

test('a final answer from the worker stops it, and says why', async () => {
  const chain = fakeChain({ answers: ['unreadable_answer', 'hash_mismatch'] });
  const r = await handoff(chain, quick);
  assert.equal(r.ok, false);
  assert.match(r.reason, /hash_mismatch/);
  assert.equal(chain.calls.length, 2);
});

test('an already released or not executing release is not touched', async () => {
  assert.deepEqual(await handoff(fakeChain({ answers: [], status: 'Released' }), quick), { ok: true, rounds: 0 });
  const r = await handoff(fakeChain({ answers: [], status: 'Pending' }), quick);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Pending/);
});

test('it gives up when the time is up', async () => {
  let t = 0;
  const chain = fakeChain({ answers: Array(50).fill('pending') });
  const r = await handoff(chain, { ...quick, maxMinutes: 1, now: () => (t += 20000), sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not released after 1 minutes/);
});
