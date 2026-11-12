import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { LocalNet } from '../src/localchain.mjs';
import * as cmd from '../src/commands.mjs';

const DAY = 24 * 3_600_000;
let net;
before(() => {
  net = new LocalNet({ worker: 'worker.local' });
});
after(() => net.close());

async function project(name) {
  const ada = net.as('ada.local');
  await cmd.register(ada, { project: name, registry: 'npm', members: 'ada.local,bob.local,cy.local', proposers: 'ci.local', threshold: 2, windowHours: 1 });
  await cmd.proposeGuardians(ada, { project: name, guardians: 'g1.local,g2.local,g3.local', threshold: 2 });
  await cmd.proposeGuardians(net.as('bob.local'), { project: name, guardians: 'g3.local, g2.local,g1.local', threshold: 2 });
}

test('guardians recover a project whose members lost their keys', async () => {
  await project('npm:lost');
  const status = await cmd.recoveryStatus(net.as('ada.local'), { project: 'npm:lost' });
  assert.match(status, /guardians {2}2 of /);
  for (const g of ['g1.local', 'g2.local', 'g3.local']) assert.ok(status.includes(g));

  await cmd.startRecovery(net.as('g1.local'), { project: 'npm:lost', members: 'dan.local,eve.local', threshold: 2 });
  await cmd.approveRecovery(net.as('g2.local'), { project: 'npm:lost' });
  await assert.rejects(() => cmd.finishRecovery(net.as('watch.local'), { project: 'npm:lost' }), /wait is not over/);
  net.advance(7 * DAY + 1000);
  await cmd.finishRecovery(net.as('watch.local'), { project: 'npm:lost' });

  const p = await net.as('dan.local').view('get_project', { project_id: 'npm:lost' });
  assert.deepEqual(p.members, ['dan.local', 'eve.local']);
  // The new members can now work, and the old ones can not.
  await net.as('ci.local').call('propose_release', { project_id: 'npm:lost', version: '1.0.0', artifact_hash: 'a'.repeat(64) });
  await net.as('dan.local').call('approve_release', { project_id: 'npm:lost', version: '1.0.0' });
  await assert.rejects(() => net.as('ada.local').call('approve_release', { project_id: 'npm:lost', version: '1.0.0' }), /only members can approve/);
});

test('a live member vetoes a recovery that guardians started', async () => {
  await project('npm:hostile');
  await cmd.startRecovery(net.as('g1.local'), { project: 'npm:hostile', members: 'x.local,y.local', threshold: 2 });
  await cmd.approveRecovery(net.as('g2.local'), { project: 'npm:hostile' });
  await assert.rejects(() => cmd.cancelRecovery(net.as('g3.local'), { project: 'npm:hostile' }), /only members can cancel/);
  await cmd.cancelRecovery(net.as('cy.local'), { project: 'npm:hostile' });
  net.advance(8 * DAY);
  await assert.rejects(() => cmd.finishRecovery(net.as('watch.local'), { project: 'npm:hostile' }), /no recovery in progress/);
  const p = await net.as('ada.local').view('get_project', { project_id: 'npm:hostile' });
  assert.deepEqual(p.members, ['ada.local', 'bob.local', 'cy.local']);
});
