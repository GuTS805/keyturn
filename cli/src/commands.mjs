// Command logic. Every function takes a `chain` with view() and call(), so
// it can be tested without a network.

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseNearAmount } from 'near-api-js';
import { sha256, splitProject, encodePackageName, hours } from './util.mjs';

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
  const { name } = splitProject(project);
  const base = registryUrl.replace(/\/$/, '');
  const metaRes = await fetchImpl(`${base}/${encodePackageName(name)}/${version}`);
  if (!metaRes.ok) return { ok: false, reason: `registry has no ${name}@${version} (HTTP ${metaRes.status})` };
  const meta = await metaRes.json();
  const tarRes = await fetchImpl(meta.dist.tarball);
  if (!tarRes.ok) return { ok: false, reason: `tarball download failed (HTTP ${tarRes.status})` };
  const hash = sha256(Buffer.from(await tarRes.arrayBuffer()));
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

export function runWorkerBinary(bin, env = {}) {
  return (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [], { env: { ...process.env, ...env } });
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
export async function relay(chain, { project, version, stageId, runWorker }) {
  const { registry, name } = splitProject(project);
  if (registry !== 'npm') throw new Error('relay supports npm projects only');
  const release = await chain.view('get_release', { project_id: project, version });
  if (!release) throw new Error('this version was never proposed');
  if (release.status !== 'Executing') {
    throw new Error(`release is ${release.status}; run execute once the public window has passed`);
  }
  const result = await runWorker({
    stage_id: stageId,
    package: name,
    version,
    approved_hash: release.artifact_hash,
  });
  if (!result.ok) return { confirmed: false, result };
  await chain.call('confirm_published', {
    project_id: project,
    version,
    published_hash: result.published_hash,
  });
  return { confirmed: true, result };
}
