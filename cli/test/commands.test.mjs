import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRegistry } from '../../mock/registry.mjs';
import { makePackage } from '../../mock/tarball.mjs';
import * as cmd from '../src/commands.mjs';
import { parseTarget, splitProject, sha256 } from '../src/util.mjs';

const BOT = 'bot-token';
const CI = 'ci-token';
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

class StubChain {
  constructor(views = {}) {
    this.views = views;
    this.calls = [];
  }
  async view(method, args) {
    const v = this.views[method];
    return typeof v === 'function' ? v(args) : v;
  }
  async call(method, args, opts) {
    this.calls.push({ method, args, opts });
  }
}

let reg;
before(async () => {
  reg = await startRegistry({ botToken: BOT, ciToken: CI, totpSecret: SECRET });
});
after(() => reg.close());

async function stage(name, version, source) {
  const tarball = makePackage(name, version, source);
  const r = await fetch(`${reg.url}/-/mock/stage`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CI}` },
    body: JSON.stringify({ name, version, tarball: tarball.toString('base64') }),
  });
  return { id: (await r.json()).id, tarball };
}

async function publish(name, version, source) {
  const s = await stage(name, version, source);
  const { totp } = await import('../../mock/registry.mjs');
  await fetch(`${reg.url}/-/stage/${s.id}/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${BOT}`, 'npm-otp': totp(SECRET) },
  });
  return s.tarball;
}

test('targets parse with and without versions and scopes', () => {
  assert.deepEqual(parseTarget('npm:leftpad@1.0.0'), { project: 'npm:leftpad', version: '1.0.0' });
  assert.deepEqual(parseTarget('npm:@acme/util@2.0.0'), { project: 'npm:@acme/util', version: '2.0.0' });
  assert.deepEqual(parseTarget('npm:@acme/util'), { project: 'npm:@acme/util', version: undefined });
  assert.deepEqual(parseTarget('npm:leftpad'), { project: 'npm:leftpad', version: undefined });
  assert.throws(() => parseTarget('leftpad@1.0.0'));
  assert.deepEqual(splitProject('npm:@acme/util'), { registry: 'npm', name: '@acme/util' });
});

test('propose sends the sha256 of the tarball file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'keyturn-'));
  const file = path.join(dir, 'a.tgz');
  const bytes = makePackage('leftpad', '1.0.0');
  writeFileSync(file, bytes);
  const chain = new StubChain();
  const { artifact_hash } = await cmd.propose(chain, { project: 'npm:leftpad', version: '1.0.0', tarball: file });
  assert.equal(artifact_hash, sha256(bytes));
  assert.deepEqual(chain.calls[0], {
    method: 'propose_release',
    args: { project_id: 'npm:leftpad', version: '1.0.0', artifact_hash: sha256(bytes) },
    opts: undefined,
  });
});

test('flag attaches the bond in yoctoNEAR', async () => {
  const chain = new StubChain();
  await cmd.flag(chain, { project: 'npm:x', version: '1.0.0', reason: 'new install script', bond: '0.1' });
  assert.equal(chain.calls[0].method, 'flag_release');
  assert.equal(chain.calls[0].opts.deposit, 100_000_000_000_000_000_000_000n);
});

test('register converts hours to milliseconds and splits the lists', async () => {
  const chain = new StubChain();
  await cmd.register(chain, {
    project: 'npm:x',
    registry: 'npm',
    members: 'a.test, b.test ,c.test',
    proposers: 'ci.test',
    threshold: '2',
    windowHours: '24',
  });
  assert.deepEqual(chain.calls[0].args, {
    id: 'npm:x',
    registry: 'Npm',
    members: ['a.test', 'b.test', 'c.test'],
    proposers: ['ci.test'],
    threshold: 2,
    window_ms: 86_400_000,
  });
  await assert.rejects(() => cmd.register(chain, { project: 'x', registry: 'pypi', members: 'a,b', threshold: '2' }));
});

test('verify passes only when the contract confirms the served bytes', async () => {
  const bytes = await publish('verified-a', '1.0.0');
  const chain = new StubChain({ is_released: ({ artifact_hash }) => artifact_hash === sha256(bytes) });
  const r = await cmd.verify(chain, { project: 'npm:verified-a', version: '1.0.0', registryUrl: reg.url });
  assert.equal(r.ok, true);
  assert.equal(r.hash, sha256(bytes));
});

test('verify fails when the registry serves bytes the quorum never approved', async () => {
  await publish('verified-b', '1.0.0', 'evil();');
  const approved = sha256(makePackage('verified-b', '1.0.0', 'good();'));
  const chain = new StubChain({
    is_released: false,
    get_release: { status: 'Released', artifact_hash: approved },
  });
  const r = await cmd.verify(chain, { project: 'npm:verified-b', version: '1.0.0', registryUrl: reg.url });
  assert.equal(r.ok, false);
  assert.match(r.reason, /quorum approved/);
});

test('verify says so when a version was never proposed', async () => {
  await publish('verified-c', '1.0.0');
  const chain = new StubChain({ is_released: false, get_release: null });
  const r = await cmd.verify(chain, { project: 'npm:verified-c', version: '1.0.0', registryUrl: reg.url });
  assert.equal(r.ok, false);
  assert.match(r.reason, /never proposed/);
});

test('verify reports a recalled version', async () => {
  await publish('verified-d', '1.0.0');
  const chain = new StubChain({ is_released: false, get_release: { status: 'Recalled', artifact_hash: 'x' } });
  const r = await cmd.verify(chain, { project: 'npm:verified-d', version: '1.0.0', registryUrl: reg.url });
  assert.match(r.reason, /recalled/);
});

test('verify reports a version the registry does not have', async () => {
  const r = await cmd.verify(new StubChain(), { project: 'npm:nothing', version: '9.9.9', registryUrl: reg.url });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no nothing@9.9.9/);
});

test('describe lists approvals and the flag', () => {
  const text = cmd.describe({
    project: { id: 'npm:x', registry: 'Npm', threshold: 2, members: ['a', 'b', 'c'], window_ms: 86_400_000 },
    release: {
      version: '1.0.0',
      artifact_hash: 'ab'.repeat(32),
      status: 'Flagged',
      approvals: ['a', 'b'],
      ready_at_ms: 0,
      flag: { by: 'watcher.test', reason: 'new install script' },
    },
  });
  assert.match(text, /approvals 2\/2/);
  assert.match(text, /flagged {3}by watcher.test: new install script/);
  assert.match(text, /Flagged/);
});

const workerBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../worker/target/debug/keyturn-worker' + (process.platform === 'win32' ? '.exe' : ''),
);
const hasWorker = existsSync(workerBin);
const workerEnv = () => ({ NPM_TOKEN: BOT, NPM_TOTP_SECRET: SECRET, KEYTURN_NPM_REGISTRY: reg.url });

test('relay confirms on the contract only after the worker published', { skip: !hasWorker }, async () => {
  const { id, tarball } = await stage('relay-a', '1.0.0');
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(tarball) } });
  const r = await cmd.relay(chain, {
    project: 'npm:relay-a',
    version: '1.0.0',
    stageId: id,
    runWorker: cmd.runWorkerBinary(workerBin, workerEnv()),
  });
  assert.equal(r.confirmed, true);
  assert.equal(reg.isPublished('relay-a', '1.0.0'), true);
  assert.deepEqual(chain.calls[0], {
    method: 'confirm_published',
    args: { project_id: 'npm:relay-a', version: '1.0.0', published_hash: sha256(tarball) },
    opts: undefined,
  });
});

test('relay does not confirm when the staged bytes were swapped', { skip: !hasWorker }, async () => {
  const { id, tarball } = await stage('relay-b', '1.0.0');
  const evil = makePackage('relay-b', '1.0.0', 'steal();');
  await fetch(`${reg.url}/-/mock/tamper/${id}`, { method: 'POST', body: JSON.stringify({ tarball: evil.toString('base64') }) });
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(tarball) } });
  const r = await cmd.relay(chain, {
    project: 'npm:relay-b',
    version: '1.0.0',
    stageId: id,
    runWorker: cmd.runWorkerBinary(workerBin, workerEnv()),
  });
  assert.equal(r.confirmed, false);
  assert.equal(r.result.error, 'hash_mismatch');
  assert.equal(chain.calls.length, 0);
  assert.equal(reg.isPublished('relay-b', '1.0.0'), false);
});

test('relay refuses to run before the window has passed', async () => {
  const chain = new StubChain({ get_release: { status: 'Pending', artifact_hash: 'a'.repeat(64) } });
  await assert.rejects(
    () => cmd.relay(chain, { project: 'npm:x', version: '1.0.0', stageId: 'id', runWorker: async () => ({}) }),
    /release is Pending/,
  );
});

async function artifact(tarball) {
  const r = await fetch(`${reg.url}/-/mock/artifact`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CI}` },
    body: JSON.stringify({ tarball: tarball.toString('base64') }),
  });
  return r.json();
}

const httpEnv = () => ({ ...workerEnv(), KEYTURN_ALLOW_HTTP: '1' });

test('relay in publish mode confirms after the worker published the artifact', { skip: !hasWorker }, async () => {
  const bytes = makePackage('relay-c', '1.0.0');
  const { url } = await artifact(bytes);
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(bytes) } });
  const r = await cmd.relay(chain, {
    project: 'npm:relay-c',
    version: '1.0.0',
    artifactUrl: url,
    runWorker: cmd.runWorkerBinary(workerBin, httpEnv()),
  });
  assert.equal(r.confirmed, true);
  assert.equal(reg.isPublished('relay-c', '1.0.0'), true);
  assert.equal(chain.calls[0].method, 'confirm_published');
  assert.equal(chain.calls[0].args.published_hash, sha256(bytes));
});

test('relay in publish mode does not confirm when the artifact was swapped', { skip: !hasWorker }, async () => {
  const bytes = makePackage('relay-d', '1.0.0');
  const { id, url } = await artifact(bytes);
  const evil = makePackage('relay-d', '1.0.0', 'steal();');
  await fetch(`${reg.url}/-/mock/tamper-artifact/${id}`, { method: 'POST', body: JSON.stringify({ tarball: evil.toString('base64') }) });
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(bytes) } });
  const r = await cmd.relay(chain, {
    project: 'npm:relay-d',
    version: '1.0.0',
    artifactUrl: url,
    runWorker: cmd.runWorkerBinary(workerBin, httpEnv()),
  });
  assert.equal(r.confirmed, false);
  assert.equal(r.result.error, 'hash_mismatch');
  assert.equal(chain.calls.length, 0);
  assert.equal(reg.isPublished('relay-d', '1.0.0'), false);
});

test('relay needs either an artifact url or a stage id', async () => {
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: 'a'.repeat(64) } });
  await assert.rejects(
    () => cmd.relay(chain, { project: 'npm:x', version: '1.0.0', runWorker: async () => ({}) }),
    /--artifact-url/,
  );
});
