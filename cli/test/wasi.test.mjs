// Runs the wasm32-wasip2 build of the worker under wasmtime, against the mock
// registry over wasi:http. Skipped when wasmtime or the wasm file is missing:
//   cargo build --release --target wasm32-wasip2 --no-default-features   (in worker/)
//   cargo install wasmtime-cli --locked
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRegistry } from '../../mock/registry.mjs';
import { makePackage } from '../../mock/tarball.mjs';
import * as cmd from '../src/commands.mjs';
import { sha256 } from '../src/util.mjs';

const wasm = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../worker/target/wasm32-wasip2/release/keyturn-worker.wasm');
const hasWasmtime = spawnSync('wasmtime', ['--version'], { shell: process.platform === 'win32' }).status === 0;
const skip = !existsSync(wasm) || !hasWasmtime;

const BOT = 'bot-token';
let reg;
before(async () => {
  reg = await startRegistry({ botToken: BOT, ciToken: 'ci-token', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
});
after(() => reg.close());

function runWasm(input, env) {
  const flags = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  return cmd.runWorkerBinary('wasmtime', {}, ['run', '-S', 'http', ...flags, wasm])(input);
}

async function artifact(tarball) {
  const r = await fetch(`${reg.url}/-/mock/artifact`, { method: 'POST', headers: { authorization: 'Bearer ci-token' }, body: JSON.stringify({ tarball: tarball.toString('base64') }) });
  return r.json();
}

const env = () => ({ NPM_TOKEN: BOT, KEYTURN_NPM_REGISTRY: reg.url, KEYTURN_ALLOW_HTTP: '1' });

test('the wasm worker rejects a bad request with JSON', { skip }, async () => {
  const r = await runWasm({ mode: 'publish', package: 'x', version: '1.0.0', approved_hash: 'nope', artifact_url: 'https://a.test/x' }, env());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_input');
});

test('the wasm worker publishes the approved bytes over wasi:http', { skip }, async () => {
  const bytes = makePackage('wasi-a', '1.0.0');
  const { url } = await artifact(bytes);
  const r = await runWasm({ mode: 'publish', package: 'wasi-a', version: '1.0.0', approved_hash: sha256(bytes), artifact_url: url }, env());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.published_hash, sha256(bytes));
  assert.equal(reg.isPublished('wasi-a', '1.0.0'), true);
});

test('the wasm worker refuses a swapped artifact', { skip }, async () => {
  const bytes = makePackage('wasi-b', '1.0.0');
  const { id, url } = await artifact(bytes);
  const evil = makePackage('wasi-b', '1.0.0', 'steal();');
  await fetch(`${reg.url}/-/mock/tamper-artifact/${id}`, { method: 'POST', body: JSON.stringify({ tarball: evil.toString('base64') }) });
  const r = await runWasm({ mode: 'publish', package: 'wasi-b', version: '1.0.0', approved_hash: sha256(bytes), artifact_url: url }, env());
  assert.equal(r.ok, false);
  assert.equal(r.error, 'hash_mismatch');
  assert.equal(reg.isPublished('wasi-b', '1.0.0'), false);
});

test('the wasm worker signs a CRX3 and uploads it to the mock Chrome store', { skip }, async () => {
  const { createHash, generateKeyPairSync } = await import('node:crypto');
  const { startChromeStore } = await import('../../mock/chromestore.mjs');
  const { makeExtension } = await import('../../mock/zip.mjs');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const id = [...createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest().subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
  const store = await startChromeStore({ refreshToken: 'rt' });
  try {
    const zip = makeExtension('1.0.0');
    const up = await (await fetch(`${store.url}/-/mock/artifact`, { method: 'POST', body: JSON.stringify({ zip: zip.toString('base64') }) })).json();
    const r = await runWasm(
      { mode: 'chrome', package: id, version: '1.0.0', approved_hash: sha256(zip), artifact_url: up.url },
      {
        CWS_CLIENT_ID: 'c', CWS_CLIENT_SECRET: 's', CWS_REFRESH_TOKEN: 'rt', CWS_PUBLISHER_ID: store.publisher,
        CRX_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).replaceAll('\n', '\n'),
        KEYTURN_CWS_API: store.url, KEYTURN_OAUTH_URL: store.url, KEYTURN_ALLOW_HTTP: '1',
      },
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(store.isPending(id), true);
  } finally {
    await store.close();
  }
});
