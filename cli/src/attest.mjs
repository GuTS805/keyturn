// `keyturn attest <tx>`: what can be checked about a release that was published through OutLayer.
//
// Part 1 needs only the NEAR chain. It reads the transaction that called `request_publish` and
// checks that the contract itself asked OutLayer, that the build that ran is the one the contract
// pins, that the request carried the approved hash, that the run succeeded and that the contract
// recorded the release from OutLayer's answer.
//
// Part 2 is the Intel TDX quote: proof that this wasm really ran inside a genuine TEE and that the
// request and the answer are the ones that were signed. Keyturn does not re-implement that.
// It runs OutLayer's own `outlayer-verify` when it is installed and reports its verdict, and says
// plainly when it could not.

import { spawn } from 'node:child_process';

const EVENT = 'EVENT_JSON:';

export function eventsOf(tx, executorPrefix) {
  const out = [];
  for (const r of tx.receipts_outcome || []) {
    const who = r.outcome?.executor_id || '';
    if (executorPrefix && !who.startsWith(executorPrefix)) continue;
    for (const line of r.outcome?.logs || []) {
      if (!line.startsWith(EVENT)) continue;
      try {
        out.push({ executor: who, ...JSON.parse(line.slice(EVENT.length)) });
      } catch {
        /* not an event */
      }
    }
  }
  return out;
}

const first = (list, name) => list.find((e) => e.event === name);

async function rpcTx({ rpc, txHash, signer, fetchImpl }) {
  const res = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'keyturn', method: 'tx', params: { tx_hash: txHash, sender_account_id: signer, wait_until: 'FINAL' } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.data || body.error.message || 'RPC error');
  return body.result;
}

/** Run `outlayer-verify tx <hash> --short`. Exit 0 proven, 1 failed, 2 unproven, 3 usage. */
export function runOutlayerVerify(txHash, { bin = 'outlayer-verify', network = 'testnet' } = {}) {
  return new Promise((resolve) => {
    const args = ['tx', txHash, '--short'];
    if (network === 'testnet') args.push('--network', 'testnet');
    const child = spawn(bin, args);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => resolve({ status: 'missing', text: '' }));
    child.on('close', (code) => {
      const status = code === 0 ? 'proven' : code === 1 ? 'failed' : code === 2 ? 'unproven' : 'error';
      resolve({ status, text: out.trim().split('\n').slice(-3).join(' | ') });
    });
  });
}

/**
 * @param chain   a NearChain for the Keyturn contract (views only)
 * @returns {{ checks: {ok: boolean|null, text: string}[], ok: boolean }}  ok = no check failed
 */
export async function attest(chain, { txHash, signer, fetchImpl = fetch, verifier = runOutlayerVerify, tx: given }) {
  const checks = [];
  const add = (ok, text) => checks.push({ ok, text });
  const tx = given || (await rpcTx({ rpc: chain.rpcUrl, txHash, signer, fetchImpl }));

  const call = tx.transaction?.actions?.[0]?.FunctionCall;
  const args = call ? JSON.parse(Buffer.from(call.args, 'base64').toString()) : {};
  add(tx.transaction?.receiver_id === chain.contractId && call?.method_name === 'request_publish',
    `the transaction calls request_publish on ${chain.contractId}`);
  const project = args.project_id;
  const version = args.version;
  const config = await chain.view('get_outlayer');
  const release = project && version ? await chain.view('get_release', { project_id: project, version }) : null;
  add(Boolean(config && release), `the contract has OutLayer settings and knows ${project}@${version}`);
  if (!config || !release) return { checks, ok: false };

  const ol = eventsOf(tx, config.contract.split('.')[0]);
  const requested = first(ol, 'execution_requested');
  const completed = first(ol, 'execution_completed');
  const request = requested ? JSON.parse(requested.data[0].request_data) : null;
  add(Boolean(request) && request.predecessor_id === chain.contractId,
    `OutLayer was called by the contract itself (predecessor ${request?.predecessor_id || 'none'})`);
  const ran = request?.code_source?.WasmUrl?.hash;
  add(ran === config.version_key, `the wasm that ran is the build the contract pins (${(ran || 'none').slice(0, 12)}… = ${config.version_key.slice(0, 12)}…)`);
  add(request?.project_id === config.project, `it ran the pinned project ${config.project}`);
  const input = request ? JSON.parse(request.input_data) : {};
  add(input.approved_hash === release.artifact_hash, `the request carried the approved hash ${release.artifact_hash.slice(0, 12)}…`);
  add(completed?.data?.[0]?.success === true && completed.data[0].code_source?.WasmUrl?.hash === ran,
    'OutLayer reports the run succeeded, with the same wasm');
  const kt = eventsOf(tx, chain.contractId);
  const done = kt.find((e) => e.event === 'release_published' && e.data?.via === 'outlayer');
  add(Boolean(done) && done.data.hash === release.artifact_hash, 'the contract recorded Released from OutLayer\'s answer, with the approved hash');
  add(release.status === 'Released' || release.status === 'Recalled', `the release is ${release.status} on the contract`);

  const tee = await verifier(tx.transaction.hash || txHash);
  if (tee.status === 'proven') add(true, `TEE quote (outlayer-verify): PROVEN. ${tee.text}`);
  else if (tee.status === 'missing') add(null, 'TEE quote: NOT CHECKED (outlayer-verify is not installed: cargo install --git https://github.com/out-layer/outlayer-verify outlayer-verify)');
  else add(tee.status === 'unproven' ? null : false, `TEE quote (outlayer-verify): ${tee.status.toUpperCase()}. ${tee.text}`);
  return { checks, ok: checks.every((c) => c.ok !== false), teeChecked: tee.status === 'proven' };
}
