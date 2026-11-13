// Read-only access to a Keyturn contract over NEAR JSON-RPC. No keys, no build step.

export const RPC = {
  testnet: 'https://test.rpc.fastnear.com',
  mainnet: 'https://free.rpc.fastnear.com',
};

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Call a view method. Returns the parsed JSON result. */
export async function rpcView({ rpc, contract, method, args = {}, fetchImpl = fetch }) {
  const res = await fetchImpl(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'keyturn',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contract,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      },
    }),
  });
  if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.data || body.error.message || 'RPC error');
  const result = body.result;
  if (result.error) throw new Error(result.error);
  const text = new TextDecoder().decode(new Uint8Array(result.result));
  return text ? JSON.parse(text) : null;
}

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const PLAIN = {
  Proposed: 'Waiting for approvals',
  Pending: 'Quorum reached. The public window is open.',
  Flagged: 'Flagged by a watcher. Blocked until the members decide.',
  Executing: 'Window passed. The worker may publish.',
  Released: 'Published and recorded.',
  Rejected: 'Rejected by the quorum.',
  Recalled: 'Recalled by the quorum after publishing.',
};

/** Turn a release and its project into plain facts for display. `nowMs` is injected for tests. */
export function summarize(project, release, nowMs = Date.now()) {
  if (!project) return { found: false, message: 'This project is not registered.' };
  if (!release) return { found: true, project, released: false, message: 'This version has not been proposed.' };
  const waitMs = release.ready_at_ms ? release.ready_at_ms - nowMs : null;
  return {
    found: true,
    status: release.status,
    meaning: PLAIN[release.status] || release.status,
    hash: release.artifact_hash,
    approvals: release.approvals,
    needed: project.threshold,
    members: project.members,
    proposer: release.proposer,
    windowOpen: release.status === 'Pending' && waitMs !== null && waitMs > 0,
    windowRemainingMs: release.status === 'Pending' && waitMs > 0 ? waitMs : 0,
    flag: release.flag,
    registry: project.registry,
    readyAtMs: release.ready_at_ms ?? null,
    dismissVotes: release.dismiss_votes || [],
    rejectVotes: release.reject_votes || [],
    recallVotes: release.recall_votes || [],
  };
}

export function formatDuration(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
}
