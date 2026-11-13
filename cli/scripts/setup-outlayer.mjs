// One-time: tells the Keyturn contract which OutLayer worker project may publish for it.
// Only the contract account itself can call set_outlayer, and only once, so nobody can later
// point the contract at a worker that merely echoes the approved hash.
//
//   node --env-file=.env cli/scripts/setup-outlayer.mjs
//
// Optional in .env: KEYTURN_OUTLAYER_PROJECT (default hudich-keyturn.testnet/keyturn-worker),
// KEYTURN_OUTLAYER_CONTRACT (default outlayer.testnet).

import { NearChain } from '../src/chain.mjs';

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is missing in .env`); })();
const contractId = need('KEYTURN_CONTRACT');
const project = process.env.KEYTURN_OUTLAYER_PROJECT || 'hudich-keyturn.testnet/keyturn-worker';
const outlayerContract = process.env.KEYTURN_OUTLAYER_CONTRACT || 'outlayer.testnet';
const owner = project.split('/')[0];

const chain = new NearChain({ network: 'testnet', contractId, accountId: contractId, rpcUrl: process.env.KEYTURN_RPC });
const current = await chain.view('get_outlayer');
if (current) {
  console.log('already set:', JSON.stringify(current));
  process.exit(0);
}
const config = { contract: outlayerContract, project, secrets_profile: 'default', secrets_account: owner };
await chain.call('set_outlayer', { config });
console.log('set:', JSON.stringify(await chain.view('get_outlayer')));
