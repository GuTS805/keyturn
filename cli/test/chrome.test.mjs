import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startChromeStore } from '../../mock/chromestore.mjs';
import { makeExtension } from '../../mock/zip.mjs';
import * as cmd from '../src/commands.mjs';
import { sha256 } from '../src/util.mjs';

const workerBin = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../worker/target/debug/keyturn-worker' + (process.platform === 'win32' ? '.exe' : ''),
);
const skip = !existsSync(workerBin);

const REFRESH = 'refresh-token-1';
const idOf = (spki) =>
  [...createHash('sha256').update(spki).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    id: idOf(publicKey.export({ type: 'spki', format: 'der' })),
  };
}

class StubChain {
  constructor(views = {}) {
    this.views = views;
    this.calls = [];
  }
  async view(method) {
    const v = this.views[method];
    return typeof v === 'function' ? v() : v;
  }
  async call(method, args) {
    this.calls.push({ method, args });
  }
}

let store;
const key = newKey();
before(async () => {
  store = await startChromeStore({ refreshToken: REFRESH });
});
after(() => store.close());

const workerFor = (overrides = {}) =>
  cmd.runWorkerBinary(workerBin, {
    CWS_CLIENT_ID: 'client-id',
    CWS_CLIENT_SECRET: 'client-secret-xyz',
    CWS_REFRESH_TOKEN: REFRESH,
    CWS_PUBLISHER_ID: store.publisher,
    CRX_PRIVATE_KEY: key.pem,
    KEYTURN_CWS_API: store.url,
    KEYTURN_OAUTH_URL: store.url,
    KEYTURN_ALLOW_HTTP: '1',
    ...overrides,
  });

async function upload(zip) {
  const r = await fetch(`${store.url}/-/mock/artifact`, { method: 'POST', body: JSON.stringify({ zip: zip.toString('base64') }) });
  return r.json();
}

test('the worker signs the approved ZIP, the store accepts it, and verify passes once it is live', { skip }, async () => {
  const zip = makeExtension('1.0.0', 'approved();');
  const { url } = await upload(zip);
  const project = `chrome:${key.id}`;
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(zip) } });
  const r = await cmd.relay(chain, { project, version: '1.0.0', artifactUrl: url, runWorker: workerFor() });
  assert.equal(r.confirmed, true, JSON.stringify(r.result));
  assert.equal(r.result.published_hash, sha256(zip));
  assert.equal(chain.calls[0].method, 'confirm_published');
  assert.equal(store.isPending(key.id), true);
  assert.equal(store.pendingVersion(key.id), '1.0.0');
  assert.equal(JSON.stringify(r.result).includes('client-secret-xyz'), false);

  // Not live yet: the store is still reviewing it.
  const before = await cmd.verify(new StubChain({ is_released: true }), { project, version: '1.0.0', registryUrl: store.url });
  assert.equal(before.ok, false);
  assert.match(before.reason, /serves no extension/);

  await fetch(`${store.url}/-/mock/go-live/${key.id}`, { method: 'POST' });
  const live = await cmd.verify(new StubChain({ is_released: true }), { project, version: '1.0.0', registryUrl: store.url });
  assert.equal(live.ok, true);
  assert.equal(live.hash, sha256(zip));

  // The contract does not know this hash: verify must fail.
  const unknown = await cmd.verify(
    new StubChain({ is_released: false, get_release: { status: 'Released', artifact_hash: 'f'.repeat(64) } }),
    { project, version: '1.0.0', registryUrl: store.url },
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /quorum approved/);

  // A different version was asked for than the one the store serves.
  const wrong = await cmd.verify(new StubChain({ is_released: true }), { project, version: '2.0.0', registryUrl: store.url });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /serves version 1.0.0/);
});

test('an artifact swapped after approval is refused and never uploaded', { skip }, async () => {
  const k = newKey();
  const zip = makeExtension('1.1.0', 'good();');
  const { id, url } = await upload(zip);
  await fetch(`${store.url}/-/mock/tamper-artifact/${id}`, { method: 'POST', body: JSON.stringify({ zip: makeExtension('1.1.0', 'steal();').toString('base64') }) });
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(zip) } });
  const r = await cmd.relay(chain, { project: `chrome:${k.id}`, version: '1.1.0', artifactUrl: url, runWorker: workerFor({ CRX_PRIVATE_KEY: k.pem }) });
  assert.equal(r.confirmed, false);
  assert.equal(r.result.error, 'hash_mismatch');
  assert.equal(chain.calls.length, 0);
  assert.equal(store.isPending(k.id), false);
});

test('a request for an extension the key does not own is refused', { skip }, async () => {
  const other = newKey();
  const zip = makeExtension('1.2.0');
  const { url } = await upload(zip);
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(zip) } });
  const r = await cmd.relay(chain, { project: `chrome:${other.id}`, version: '1.2.0', artifactUrl: url, runWorker: workerFor() });
  assert.equal(r.confirmed, false);
  assert.equal(r.result.error, 'key_mismatch');
  assert.equal(store.isPending(other.id), false);
});

test('a wrong refresh token stops the worker before anything is uploaded', { skip }, async () => {
  const zip = makeExtension('1.3.0');
  const { url } = await upload(zip);
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: sha256(zip) } });
  const r = await cmd.relay(chain, { project: `chrome:${key.id}`, version: '1.3.0', artifactUrl: url, runWorker: workerFor({ CWS_REFRESH_TOKEN: 'nope' }) });
  assert.equal(r.confirmed, false);
  assert.equal(r.result.error, 'auth_failed');
  assert.notEqual(store.pendingVersion(key.id), '1.3.0');
});

test('chrome relay needs an artifact url', async () => {
  const chain = new StubChain({ get_release: { status: 'Executing', artifact_hash: 'a'.repeat(64) } });
  await assert.rejects(
    () => cmd.relay(chain, { project: `chrome:${key.id}`, version: '1.0.0', stageId: 'x', runWorker: async () => ({}) }),
    /chrome projects need --artifact-url/,
  );
});
