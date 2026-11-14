// Read-only: what a mainnet deployment of Keyturn would need, checked against the real mainnet.
// It sends no transaction and needs no key.
//
//   node cli/scripts/mainnet-preflight.mjs [path/to/keyturn_contract.wasm]

import { readFileSync, existsSync } from 'node:fs';
import { JsonRpcProvider } from 'near-api-js';

const RPC = process.env.KEYTURN_MAINNET_RPC || 'https://free.rpc.fastnear.com';
const provider = new JsonRpcProvider({ url: RPC });
const wasmPath = process.argv[2] || new URL('../../contract/target/wasm32-unknown-unknown/release/keyturn_contract.wasm', import.meta.url);
const NEAR = 1e24;
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
const say = (ok, text) => console.log(`  ${ok === null ? 'INFO' : ok ? 'OK  ' : 'FAIL'}  ${text}`);

console.log(`mainnet RPC ${RPC}`);
const status = await provider.viewBlock({ finality: 'final' });
say(true, `reachable, block ${status.header.height}`);

// 1. OutLayer on mainnet.
const ol = 'outlayer.near';
try {
  const cost = await view(ol, 'estimate_execution_cost', {
    resource_limits: { max_instructions: 20_000_000_000, max_memory_mb: 128, max_execution_seconds: 120 },
    input_len: 400,
  });
  say(true, `${ol} answers; one run with Keyturn's limits is estimated at ${(Number(BigInt(cost)) / NEAR).toFixed(4)} NEAR (the contract sends 0.02 per attempt, the rest is refunded)`);
} catch (e) {
  say(false, `${ol} did not answer estimate_execution_cost: ${String(e.message).slice(0, 100)}`);
}
try {
  const w = 'worker.outlayer.near';
  const approved = await view(w, 'get_approved_measurements');
  say(true, `${w} lists ${Array.isArray(approved) ? approved.length : '?'} approved worker measurements (the TEE identity check reads this list)`);
} catch (e) {
  say(null, `could not read the approved measurements (${String(e.message).slice(0, 80)})`);
}

// 2. What the contract costs to store.
const bytes = existsSync(wasmPath) ? readFileSync(wasmPath).length : null;
if (bytes) {
  const params = await provider.viewProtocolConfig?.({ finality: 'final' }).catch(() => null);
  const perByte = Number(params?.runtime_config?.storage_amount_per_byte ?? 1e19);
  say(null, `contract wasm ${bytes} bytes: about ${((bytes * perByte) / NEAR).toFixed(2)} NEAR must stay locked for storage, plus a little for state`);
} else {
  say(null, 'build the contract first (npm run build:contract) to see its storage cost');
}

// 3. Names you would need.
for (const id of ['keyturn.near', 'keyturn-worker.near']) {
  try {
    await provider.viewAccount({ accountId: id });
    say(null, `${id} already exists`);
  } catch {
    say(null, `${id} is free`);
  }
}
console.log('\nSee docs/MAINNET.md for the steps. Nothing was sent.');
