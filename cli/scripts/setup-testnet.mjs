// Creates the demo accounts under a main testnet account, deploys the contract
// and initialises it. Keys are written to ~/.near-credentials/testnet in the
// near-cli format and are never printed.
//
// Usage (from the repo root, with .env filled in):
//   node --env-file=.env cli/scripts/setup-testnet.mjs

import { Account, JsonRpcProvider, KeyPair, parseNearAmount } from 'near-api-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RPC = process.env.KEYTURN_RPC || 'https://test.rpc.fastnear.com';
const main = process.env.KEYTURN_MAIN_ACCOUNT;
if (!main) throw new Error('set KEYTURN_MAIN_ACCOUNT in .env');

const credDir = path.join(homedir(), '.near-credentials', 'testnet');
const credFile = (id) => path.join(credDir, `${id}.json`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wasmPath = path.join(root, 'contract/target/wasm32-unknown-unknown/release/keyturn_contract.wasm');

const provider = new JsonRpcProvider({ url: RPC });

function loadKey(id) {
  return JSON.parse(readFileSync(credFile(id), 'utf8')).private_key;
}

async function exists(id) {
  try {
    await provider.viewAccount({ accountId: id });
    return true;
  } catch {
    return false;
  }
}

const mainAccount = new Account(main, provider, loadKey(main));

// name -> NEAR to fund
const plan = [
  ['contract', '4'],
  ['ada', '0.5'],
  ['bob', '0.5'],
  ['cy', '0.5'],
  ['ci', '0.3'],
  ['worker', '0.5'],
  ['watch', '0.6'],
];

mkdirSync(credDir, { recursive: true });
const ids = {};
for (const [name, near] of plan) {
  const id = `${name}.${main}`;
  ids[name] = id;
  if (await exists(id)) {
    console.log(`exists   ${id}`);
    continue;
  }
  if (existsSync(credFile(id))) throw new Error(`${id} has a key file but no account; remove the file and retry`);
  const key = KeyPair.fromRandom('ed25519');
  await mainAccount.createAccount({
    newAccountId: id,
    publicKey: key.getPublicKey().toString(),
    nearToTransfer: BigInt(parseNearAmount(near)),
  });
  writeFileSync(
    credFile(id),
    JSON.stringify({ account_id: id, public_key: key.getPublicKey().toString(), private_key: key.toString() }, null, 2),
  );
  console.log(`created  ${id}  (${near} NEAR)`);
}

// Deploy and initialise.
const contractId = ids.contract;
const contract = new Account(contractId, provider, loadKey(contractId));
let initialised = false;
try {
  await provider.callFunction({ contractId, method: 'get_worker', args: {} });
  initialised = true;
} catch {
  /* not deployed or not initialised yet */
}
if (initialised && process.argv.includes('--redeploy')) {
  // Upgrade the code and keep the state.
  const wasm = readFileSync(wasmPath);
  try {
    await contract.deployContract(wasm);
  } catch (e) {
    // Storage costs 1 NEAR per 100 KB. A bigger contract may need more balance.
    if (!String(e.name || e).includes('LackBalance')) throw e;
    console.log('contract account needs more balance for storage; sending 1.5 NEAR from the main account');
    await mainAccount.transfer({ receiverId: contractId, amount: BigInt(parseNearAmount('1.5')) });
    await contract.deployContract(wasm);
  }
  console.log(`redeployed ${wasm.length} bytes to ${contractId} (state kept)`);
  // New code may expect a newer state layout. If the old state cannot be read, migrate it.
  try {
    await provider.callFunction({ contractId, method: 'get_worker', args: {} });
    console.log('state is compatible, no migration needed');
  } catch {
    await contract.callFunction({ contractId, methodName: 'migrate', args: {}, gas: 100_000_000_000_000n });
    console.log('state migrated');
  }
} else if (initialised) {
  console.log(`contract already initialised at ${contractId}`);
} else {
  const wasm = readFileSync(wasmPath);
  await contract.deployContract(wasm);
  console.log(`deployed ${wasm.length} bytes to ${contractId}`);
  await contract.callFunction({ contractId, methodName: 'new', args: { worker: ids.worker }, gas: 100_000_000_000_000n });
  console.log(`initialised, worker = ${ids.worker}`);
}

// Record the public account names in .env (no keys).
const envPath = path.join(root, '.env');
let env = readFileSync(envPath, 'utf8');
const set = (k, v) => {
  env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : `${env}\n${k}=${v}\n`;
};
set('KEYTURN_CONTRACT', contractId);
set('KEYTURN_ACCOUNT', ids.ada);
set('KEYTURN_ACCT_ADA', ids.ada);
set('KEYTURN_ACCT_BOB', ids.bob);
set('KEYTURN_ACCT_CY', ids.cy);
set('KEYTURN_ACCT_CI', ids.ci);
set('KEYTURN_ACCT_WORKER', ids.worker);
set('KEYTURN_ACCT_WATCH', ids.watch);
writeFileSync(envPath, env);
console.log('\n.env updated with account names (no keys).');
console.log(JSON.stringify({ contract: contractId, ...ids }, null, 2));
