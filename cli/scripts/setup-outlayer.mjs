// One-time: tells the Keyturn contract which OutLayer worker BUILD may publish for it.
// Only the contract account itself can call set_outlayer, and only once, so nobody can later
// point the contract at a worker that merely echoes the approved hash. The build is pinned by
// the SHA-256 of its wasm: if the project owner activates another version on OutLayer, the
// contract still asks for this one.
//
//   node --env-file=.env cli/scripts/setup-outlayer.mjs                   pin the version that is active now
//   node --env-file=.env cli/scripts/setup-outlayer.mjs --version-key <sha256>   pin this build
//
// Optional in .env: KEYTURN_OUTLAYER_PROJECT (default hudich-keyturn.testnet/keyturn-worker),
// KEYTURN_OUTLAYER_CONTRACT (default outlayer.testnet).

import { NearChain } from '../src/chain.mjs';

const need = (k) => process.env[k] || (() => { throw new Error(`${k} is missing in .env`); })();
const contractId = need('KEYTURN_CONTRACT');
const project = process.env.KEYTURN_OUTLAYER_PROJECT || 'hudich-keyturn.testnet/keyturn-worker';
const outlayerContract = process.env.KEYTURN_OUTLAYER_CONTRACT || 'outlayer.testnet';
const owner = project.split('/')[0];
const flag = process.argv.indexOf('--version-key');

const chain = new NearChain({ network: 'testnet', contractId, accountId: contractId, rpcUrl: process.env.KEYTURN_RPC });
const current = await chain.view('get_outlayer');
if (current) {
  console.log('already set:', JSON.stringify(current));
  process.exit(0);
}

// What OutLayer says about the project, read from its own contract.
const ol = new NearChain({ network: 'testnet', contractId: outlayerContract, rpcUrl: process.env.KEYTURN_RPC });
const info = await ol.view('get_project', { project_id: project });
if (!info) throw new Error(`OutLayer has no project ${project}`);
const versionKey = flag > 0 ? process.argv[flag + 1] : info.active_version;
const versions = await ol.view('list_versions', { project_id: project });
if (!versions.some((v) => v.wasm_hash === versionKey)) throw new Error(`${versionKey} is not a version of ${project}`);
console.log(`worker build  ${versionKey}${versionKey === info.active_version ? '  (the active version)' : ''}`);

const config = { contract: outlayerContract, project, version_key: versionKey, secrets_profile: 'default', secrets_account: owner };
await chain.call('set_outlayer', { config });
console.log('set:', JSON.stringify(await chain.view('get_outlayer')));
