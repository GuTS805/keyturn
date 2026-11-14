// Command logic. Every function takes a `chain` with view() and call(), so
// it can be tested without a network.

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseNearAmount } from 'near-api-js';
import { sha256, splitProject, encodePackageName, hours } from './util.mjs';
import { crxZip, zipManifestVersion } from './crx.mjs';
import { analyze, aiReview, withAi, flagReason, describeReport } from './watchtower.mjs';

const REGISTRIES = { npm: 'Npm', chrome: 'Chrome' };

export async function hashFile(file) {
  return sha256(await readFile(file));
}

export async function register(chain, { project, registry, members, proposers, threshold, windowHours }) {
  const kind = REGISTRIES[registry];
  if (!kind) throw new Error(`registry must be one of: ${Object.keys(REGISTRIES).join(', ')}`);
  return chain.call('register_project', {
    id: project,
    registry: kind,
    members: members.split(',').map((s) => s.trim()).filter(Boolean),
    proposers: (proposers || '').split(',').map((s) => s.trim()).filter(Boolean),
    threshold: Number(threshold),
    window_ms: hours(windowHours ?? 24),
  });
}

export async function propose(chain, { project, version, tarball }) {
  const artifact_hash = await hashFile(tarball);
  await chain.call('propose_release', { project_id: project, version, artifact_hash });
  return { artifact_hash };
}

const simple = (method) => (chain, { project, version }) =>
  chain.call(method, { project_id: project, version });

export const approve = simple('approve_release');
export const execute = simple('execute_release');
export const dismiss = simple('dismiss_flag');
export const reject = simple('reject_release');
export const recall = simple('recall_release');

export function flag(chain, { project, version, reason, bond = '0.1' }) {
  const deposit = BigInt(parseNearAmount(String(bond)));
  return chain.call('flag_release', { project_id: project, version, reason }, { deposit });
}

export async function status(chain, { project, version }) {
  const p = await chain.view('get_project', { project_id: project });
  if (!p) throw new Error(`unknown project ${project}`);
  const r = await chain.view('get_release', { project_id: project, version });
  return { project: p, release: r };
}

export function describe({ project, release }) {
  const lines = [
    `project   ${project.id} (${project.registry}), ${project.threshold} of ${project.members.length} must approve`,
    `window    ${project.window_ms / 3_600_000} h`,
  ];
  if (!release) return [...lines, 'release   not proposed'].join('\n');
  lines.push(
    `release   ${release.version}`,
    `hash      ${release.artifact_hash}`,
    `status    ${release.status}`,
    `approvals ${release.approvals.length}/${project.threshold}  ${release.approvals.join(', ')}`,
  );
  if (release.ready_at_ms) lines.push(`ready at  ${new Date(release.ready_at_ms).toISOString()}`);
  if (release.flag) lines.push(`flagged   by ${release.flag.by}: ${release.flag.reason}`);
  return lines.join('\n');
}

/**
 * Consumer side check. Downloads what the registry serves for
 * project@version, hashes it, and asks the contract whether exactly that
 * hash was approved by the quorum and published.
 */
export async function verify(chain, { project, version, registryUrl, fetchImpl = fetch }) {
  const { registry, name } = splitProject(project);
  const base = (registryUrl || '').replace(/\/$/, '');
  let hash;
  if (registry === 'chrome') {
    // The update service serves the live CRX of an extension. The approved hash is
    // the hash of the ZIP inside it. It only serves the latest version, so the
    // version inside must be the one asked for.
    const crxRes = await fetchImpl(
      `${base || 'https://clients2.google.com'}/service/update2/crx?response=redirect&prodversion=130.0&acceptformat=crx3&x=id%3D${name}%26uc`,
    );
    if (!crxRes.ok) return { ok: false, reason: `the store serves no extension ${name} (HTTP ${crxRes.status})` };
    let zip;
    try {
      zip = crxZip(Buffer.from(await crxRes.arrayBuffer()));
      const served = zipManifestVersion(zip);
      if (served !== version) return { ok: false, reason: `the store serves version ${served}, not ${version}` };
    } catch (e) {
      return { ok: false, reason: `the store's download is not a valid extension: ${e.message}` };
    }
    hash = sha256(zip);
  } else {
    const metaRes = await fetchImpl(`${base}/${encodePackageName(name)}/${version}`);
    if (!metaRes.ok) return { ok: false, reason: `registry has no ${name}@${version} (HTTP ${metaRes.status})` };
    const meta = await metaRes.json();
    const tarRes = await fetchImpl(meta.dist.tarball);
    if (!tarRes.ok) return { ok: false, reason: `tarball download failed (HTTP ${tarRes.status})` };
    hash = sha256(Buffer.from(await tarRes.arrayBuffer()));
  }
  const released = await chain.view('is_released', { project_id: project, version, artifact_hash: hash });
  if (released) return { ok: true, hash, reason: 'approved by the quorum and published' };
  const release = await chain.view('get_release', { project_id: project, version });
  const why = !release
    ? 'this version was never proposed to the contract'
    : release.status === 'Recalled'
      ? 'this version was recalled by the quorum'
      : release.artifact_hash !== hash
        ? `the registry serves ${hash} but the quorum approved ${release.artifact_hash}`
        : `the release is ${release.status}, not published`;
  return { ok: false, hash, reason: why };
}

/** The most recent published version before `version`, from the registry. Null if there is none. */
export async function fetchPrevious(name, version, registryUrl, fetchImpl = fetch) {
  const base = registryUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${base}/${encodePackageName(name)}`);
  if (!res.ok) return null;
  const doc = await res.json();
  const candidates = Object.keys(doc.versions || {})
    .filter((v) => v !== version && !v.endsWith('-stage'))
    .sort((a, b) => Date.parse(doc.time?.[b] || 0) - Date.parse(doc.time?.[a] || 0));
  if (!candidates.length) return null;
  const tar = await fetchImpl(doc.versions[candidates[0]].dist.tarball);
  if (!tar.ok) return null;
  return { version: candidates[0], bytes: Buffer.from(await tar.arrayBuffer()) };
}

/**
 * Watchtower. Looks at the exact bytes the quorum approved, compares them with the previous
 * version, and flags the release (with a bond) if it finds something that should stop it.
 * It only acts while the release is Pending, which is the public window.
 */
export async function watch(chain, { project, version, tarball, previous, registryUrl, flag: doFlag, bond, ai, fetchImpl = fetch }) {
  const release = await chain.view('get_release', { project_id: project, version });
  if (!release) throw new Error('this version was never proposed');
  const bytes = await readFile(tarball);
  const hash = sha256(bytes);
  if (hash !== release.artifact_hash) {
    throw new Error(`this file hashes to ${hash}, but the quorum approved ${release.artifact_hash}; watch the approved bytes`);
  }
  let before = null;
  let comparedWith = null;
  if (previous) {
    before = await readFile(previous);
    comparedWith = previous;
  } else if (registryUrl) {
    const prev = await fetchPrevious(splitProject(project).name, version, registryUrl, fetchImpl);
    if (prev) {
      before = prev.bytes;
      comparedWith = `${prev.version} from the registry`;
    }
  }
  let report = analyze(bytes, before);
  if (ai && report.findings.length) report = withAi(report, await aiReview(report, { ...ai, fetchImpl }));
  const out = { report, comparedWith, text: describeReport(report), flagged: false, status: release.status };
  if (doFlag && report.verdict === 'flag') {
    if (release.status !== 'Pending') {
      out.note = `not flagged: the release is ${release.status}, and only a Pending release (public window open) can be flagged`;
    } else {
      await flag(chain, { project, version, reason: flagReason(report), bond });
      out.flagged = true;
    }
  }
  return out;
}

const list = (text) => (text || '').split(',').map((s) => s.trim()).filter(Boolean);

/** A member proposes guardians. They take effect when the members' threshold proposed the same ones. */
export function proposeGuardians(chain, { project, guardians, threshold }) {
  return chain.call('propose_guardians', { project_id: project, guardians: list(guardians), threshold: Number(threshold) });
}

/** A guardian asks to replace the member list. */
export function startRecovery(chain, { project, members, threshold }) {
  return chain.call('start_recovery', { project_id: project, new_members: list(members), new_threshold: Number(threshold) });
}

export const approveRecovery = (chain, { project }) => chain.call('approve_recovery', { project_id: project });
export const cancelRecovery = (chain, { project }) => chain.call('cancel_recovery', { project_id: project });
export const finishRecovery = (chain, { project }) => chain.call('finish_recovery', { project_id: project });

export async function recoveryStatus(chain, { project }) {
  const [guardians, proposal, recovery] = await Promise.all([
    chain.view('get_guardians', { project_id: project }),
    chain.view('get_guardian_proposal', { project_id: project }),
    chain.view('get_recovery', { project_id: project }),
  ]);
  const lines = [];
  lines.push(guardians ? `guardians  ${guardians.threshold} of ${guardians.accounts.join(', ')}` : 'guardians  none');
  if (proposal) lines.push(`proposed   ${proposal.guardians.threshold} of ${proposal.guardians.accounts.join(', ')} (${proposal.approvals.length} member approvals)`);
  if (recovery) {
    lines.push(`recovery   to ${recovery.new_threshold} of ${recovery.new_members.join(', ')}`);
    lines.push(`           guardian approvals: ${recovery.approvals.join(', ')}`);
    lines.push(recovery.ready_at_ms ? `           can finish at ${new Date(recovery.ready_at_ms).toISOString()}` : '           waiting for more guardians');
  }
  return lines.join('\n');
}

export function runWorkerBinary(bin, env = {}, args = []) {
  return (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: { ...process.env, ...env } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error('worker did not return JSON'));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
}

/**
 * Local mode glue. Reads the approved hash from the contract, runs the worker,
 * and reports the published hash back as the worker account. With OutLayer this
 * step is replaced by the yield/resume callback.
 */
export async function relay(chain, { project, version, stageId, artifactUrl, runWorker, pendingRetries = 0, pendingDelayMs = 15000 }) {
  const { registry, name } = splitProject(project);
  if (registry === 'chrome' && !artifactUrl) throw new Error('chrome projects need --artifact-url');
  if (!artifactUrl && !stageId) throw new Error('give --artifact-url (publish) or --stage-id (staged approve)');
  const release = await chain.view('get_release', { project_id: project, version });
  if (!release) throw new Error('this version was never proposed');
  if (release.status !== 'Executing') {
    throw new Error(`release is ${release.status}; run execute once the public window has passed`);
  }
  const request = artifactUrl
    ? { mode: registry === 'chrome' ? 'chrome' : 'publish', package: name, version, approved_hash: release.artifact_hash, artifact_url: artifactUrl }
    : { mode: 'stage_approve', stage_id: stageId, package: name, version, approved_hash: release.artifact_hash };
  let result = await runWorker(request);
  // A registry may accept an upload and show it minutes later. The worker answers "pending"
  // and is safe to ask again: it confirms what is there and never publishes twice.
  for (let i = 0; !result.ok && result.error === 'pending' && i < pendingRetries; i++) {
    await new Promise((r) => setTimeout(r, pendingDelayMs));
    result = await runWorker(request);
  }
  if (!result.ok) return { confirmed: false, result };
  await chain.call('confirm_published', {
    project_id: project,
    version,
    published_hash: result.published_hash,
  });
  return { confirmed: true, result };
}

// Answers from the worker that can pass on their own. The contract uses the same list.
const RETRYABLE = ['pending', 'upload_failed', 'artifact_fetch_failed', 'publish_failed', 'post_check_failed', 'stage_fetch_failed',
  'outlayer_call_failed', 'unreadable_answer'];

/**
 * Hand a release to OutLayer through the contract and keep going until it is Released, the worker
 * gives a final answer, or time runs out. The contract already asks again by itself a few times
 * (it is limited by gas); this goes on from there. Asking again is safe: the worker confirms an
 * existing version and never publishes twice.
 */
export async function handoff(chain, { project, version, artifactUrl, maxMinutes = 30, pollMs = 10000, deposit = '0.08', say = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const deadline = now() + maxMinutes * 60000;
  let rounds = 0;
  while (now() < deadline) {
    const release = await chain.view('get_release', { project_id: project, version });
    if (!release) return { ok: false, reason: 'this version was never proposed' };
    if (release.status === 'Released') return { ok: true, rounds };
    if (release.status !== 'Executing') return { ok: false, reason: `the release is ${release.status}, not Executing` };
    if (await chain.view('get_handoff', { project_id: project, version })) {
      await sleep(pollMs); // a chain of attempts is running; its answer arrives within about four minutes
      continue;
    }
    rounds++;
    const res = await chain.callRaw('request_publish', { project_id: project, version, artifact_url: artifactUrl }, {
      deposit: BigInt(parseNearAmount(deposit)),
      gas: 300_000_000_000_000n,
    });
    const tx = res.transaction?.hash || res.transaction_outcome?.id;
    say(`round ${rounds}: request_publish ${tx}`);
    // Wait for this chain to end.
    while (now() < deadline && (await chain.view('get_handoff', { project_id: project, version }))) await sleep(pollMs);
    const after = await chain.view('get_release', { project_id: project, version });
    if (after?.status === 'Released') return { ok: true, rounds };
    const events = await chain.events(tx, chain.accountId).catch(() => []);
    const last = [...events].reverse().find((e) => e.event === 'publish_failed');
    say(`round ${rounds} ended: ${last ? last.data.error : 'no answer'}`);
    if (last && !RETRYABLE.includes(last.data.error)) return { ok: false, reason: `final answer from the worker: ${last.data.error}${last.data.detail ? ' (' + last.data.detail + ')' : ''}`, rounds };
  }
  return { ok: false, reason: `not released after ${maxMinutes} minutes`, rounds };
}
