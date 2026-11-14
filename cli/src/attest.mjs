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
import { createHash } from 'node:crypto';

export const OUTLAYER_API = { testnet: 'https://testnet-api.outlayer.ai', mainnet: 'https://api.outlayer.ai' };
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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

/** OutLayer's public record of the run that this transaction started, and its attestation. */
export async function fetchRecord({ api, signer, txHash, fetchImpl = fetch }) {
  const jobs = await (await fetchImpl(`${api}/public/jobs?user_account_id=${encodeURIComponent(signer)}&limit=100`)).json();
  const job = Array.isArray(jobs) ? jobs.find((j) => j.transaction_hash === txHash) : null;
  if (!job) return { job: null, attestation: null };
  const res = await fetchImpl(`${api}/attestations/${job.job_id}`);
  return { job, attestation: res.ok ? await res.json() : null };
}

/** Run `outlayer-verify job <id> --network testnet --short`. Exit 0 proven, 1 failed, 2 unproven, 3 usage. */
export function runOutlayerVerify(jobId, { bin = process.env.KEYTURN_OUTLAYER_VERIFY || 'outlayer-verify', network = 'testnet' } = {}) {
  return new Promise((resolve) => {
    // The default API address of the version I installed is OutLayer's retired one (HTTP 410), so pass it.
    const args = ['job', String(jobId), '--network', network, '--api', OUTLAYER_API[network], '--short', '--no-color'];
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
export async function attest(chain, { txHash, signer, fetchImpl = fetch, verifier = runOutlayerVerify, tx: given, record: givenRecord, api }) {
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

  // OutLayer's own record of the run. It is only data from their server until the quote is
  // verified, but its fields must agree with what the chain shows.
  const network = chain.network || 'testnet';
  const { job, attestation: att } = givenRecord || (await fetchRecord({ api: api || OUTLAYER_API[network], signer: signer || tx.transaction.signer_id, txHash: tx.transaction.hash || txHash, fetchImpl }));
  add(Boolean(job?.success) && job?.status === 'completed', job ? `OutLayer's public record: job ${job.job_id}, ${job.status}` : 'OutLayer has no public record of a run for this transaction');
  if (job && att) {
    add(att.wasm_hash === config.version_key && att.executed_wasm_sha256 === config.version_key, 'its attestation names the pinned build, and the executed binary is the same');
    add(att.project_id === config.project && att.caller_account_id === (signer || tx.transaction.signer_id), `its attestation names the pinned project and the caller ${att.caller_account_id}`);
    add(request && att.input_hash === sha256(request.input_data), 'its input hash equals the SHA-256 of the request that is in the transaction');
    add(Boolean(att.tdx_quote) && att.transaction_hash === (tx.transaction.hash || txHash), 'it carries a TDX quote and names this transaction');
  } else if (job) {
    add(false, 'OutLayer has no attestation for that job');
  }

  // The Intel signature chain, the approved-build list and the binding of the quote to this
  // input, output and code. Not re-implemented here: OutLayer's own verifier does it.
  const tee = job ? await verifier(job.job_id) : { status: 'unproven', text: 'no job' };
  if (tee.status === 'proven') add(true, `TEE quote (outlayer-verify): PROVEN. ${tee.text}`);
  else if (tee.status === 'missing') add(null, `TEE quote: NOT CHECKED HERE (outlayer-verify is not installed). Check it in a browser at https://app.outlayer.ai/attestation/${job?.job_id} (the dashboard must be on testnet) or run: outlayer-verify job ${job?.job_id} --network ${network}`);
  else add(tee.status === 'unproven' ? null : false, `TEE quote (outlayer-verify): ${tee.status.toUpperCase()}. ${tee.text}`);
  return { checks, ok: checks.every((c) => c.ok !== false), teeChecked: tee.status === 'proven', jobId: job?.job_id };
}
