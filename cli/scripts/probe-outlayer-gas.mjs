// How much gas does outlayer.testnet's request_execution need? Calls it directly with a request
// that the worker will refuse (the approved hash is made up), at several gas amounts, and reports
// whether the call itself ran out of gas. Nothing is published. A failed call returns the deposit.
//
//   node --env-file=.env cli/scripts/probe-outlayer-gas.mjs 40 50 60 70 80 100

import { NearChain } from '../src/chain.mjs';

const tgas = process.argv.slice(2).map(Number).filter(Boolean);
const caller = process.env.KEYTURN_ACCT_WATCH;
const chain = new NearChain({ network: 'testnet', contractId: process.env.KEYTURN_OUTLAYER_CONTRACT || 'outlayer.testnet', accountId: caller, rpcUrl: process.env.KEYTURN_RPC });
const project = process.env.KEYTURN_OUTLAYER_PROJECT || 'hudich-keyturn.testnet/keyturn-worker';
const ol = await chain.view('get_project', { project_id: project });
const args = {
  source: { Project: { project_id: project, version_key: ol.active_version } },
  resource_limits: { max_instructions: 20_000_000_000, max_memory_mb: 128, max_execution_seconds: 120 },
  input_data: JSON.stringify({ mode: 'publish', package: 'probe', version: '0.0.0', approved_hash: '0'.repeat(64), artifact_url: 'https://example.test/x.tgz' }),
  secrets_ref: { profile: 'default', account_id: project.split('/')[0] },
  response_format: 'Json',
  payer_account_id: caller,
};
for (const t of tgas) {
  try {
    const res = await chain.callRaw('request_execution', args, { deposit: 20_000_000_000_000_000_000_000n, gas: BigInt(t) * 10n ** 12n, waitUntil: 'EXECUTED_OPTIMISTIC' });
    const burnt = (res.receipts_outcome || []).reduce((n, o) => n + Number(o.outcome.gas_burnt), 0) / 1e12;
    console.log(`${String(t).padStart(3)} Tgas  ok       (burnt ${burnt.toFixed(1)} Tgas)`);
  } catch (e) {
    console.log(`${String(t).padStart(3)} Tgas  FAILED   ${String(e.message || e).slice(0, 100)}`);
  }
}
