import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { LocalNet } from '../src/localchain.mjs';
import * as cmd from '../src/commands.mjs';

const H = 'a'.repeat(64);
const HOUR = 3_600_000;
let net;
before(() => {
  net = new LocalNet({ worker: 'worker.local' });
});
after(() => net.close());

test('the real contract runs locally: quorum, window and worker-only confirm', async () => {
  const ada = net.as('ada.local'), bob = net.as('bob.local'), ci = net.as('ci.local'), worker = net.as('worker.local');
  await cmd.register(ada, { project: 'npm:t1', registry: 'npm', members: 'ada.local,bob.local,cy.local', proposers: 'ci.local', threshold: 2, windowHours: 1 });
  await ci.call('propose_release', { project_id: 'npm:t1', version: '1.0.0', artifact_hash: H });
  await assert.rejects(() => ci.call('approve_release', { project_id: 'npm:t1', version: '1.0.0' }), /only members can approve/);
  await ada.call('approve_release', { project_id: 'npm:t1', version: '1.0.0' });
  await assert.rejects(() => ada.call('execute_release', { project_id: 'npm:t1', version: '1.0.0' }), /not pending/);
  await bob.call('approve_release', { project_id: 'npm:t1', version: '1.0.0' });
  await assert.rejects(() => ada.call('execute_release', { project_id: 'npm:t1', version: '1.0.0' }), /window is still open/);
  net.advance(HOUR + 1000);
  await ada.call('execute_release', { project_id: 'npm:t1', version: '1.0.0' });
  await assert.rejects(() => ada.call('confirm_published', { project_id: 'npm:t1', version: '1.0.0', published_hash: H }), /only the worker/);
  await assert.rejects(() => worker.call('confirm_published', { project_id: 'npm:t1', version: '1.0.0', published_hash: 'b'.repeat(64) }), /differs/);
  await worker.call('confirm_published', { project_id: 'npm:t1', version: '1.0.0', published_hash: H });
  assert.equal(await ada.view('is_released', { project_id: 'npm:t1', version: '1.0.0', artifact_hash: H }), true);
});

test('a refused call changes nothing, and a bonded flag blocks execution', async () => {
  const ada = net.as('ada.local'), bob = net.as('bob.local'), ci = net.as('ci.local'), watch = net.as('watch.local');
  await cmd.register(ada, { project: 'npm:t2', registry: 'npm', members: 'ada.local,bob.local,cy.local', proposers: 'ci.local', threshold: 2, windowHours: 1 });
  await ci.call('propose_release', { project_id: 'npm:t2', version: '1.0.0', artifact_hash: H });
  await ada.call('approve_release', { project_id: 'npm:t2', version: '1.0.0' });
  await assert.rejects(() => ada.call('approve_release', { project_id: 'npm:t2', version: '1.0.0' }), /already approved/);
  assert.deepEqual((await ada.view('get_release', { project_id: 'npm:t2', version: '1.0.0' })).approvals, ['ada.local']);
  await bob.call('approve_release', { project_id: 'npm:t2', version: '1.0.0' });
  await assert.rejects(() => cmd.flag(watch, { project: 'npm:t2', version: '1.0.0', reason: 'x', bond: '0.01' }), /at least 0.1 NEAR/);
  await cmd.flag(watch, { project: 'npm:t2', version: '1.0.0', reason: 'new install script', bond: '0.1' });
  net.advance(2 * HOUR);
  await assert.rejects(() => ada.call('execute_release', { project_id: 'npm:t2', version: '1.0.0' }), /not pending/);
  assert.equal((await ada.view('get_release', { project_id: 'npm:t2', version: '1.0.0' })).status, 'Flagged');
});
