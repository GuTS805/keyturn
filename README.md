# Keyturn

Nobody ships a release alone.

Keyturn puts a two-person rule in front of software releases. A NEAR contract holds the approval policy (who must approve, how many, and a public waiting window). The credential that actually publishes the package lives only in a worker, designed for a TEE, and the worker acts only on releases the contract has approved.

Status: work in progress, built for NEAR HACKATHON (tracks: open, security, agents).

## The problem

In 2026 a single stolen credential was enough to publish a malicious release:

- axios (March): a maintainer's npm account was hijacked and a release carrying a remote access trojan was published.
- Trust Wallet extension 2.68 (December 2025): a leaked Chrome Web Store API key was used to push a backdoored update. About 2,500 wallets were drained.
- keyv (August): a compromised GitHub account ran the CI, so the malicious versions carried valid provenance.

npm's staged publishing adds a 2FA step, but any one maintainer can approve alone.

## How it works

1. CI builds the artifact and proposes its SHA-256 hash to the contract. CI is a proposer, not an approver.
2. Maintainers approve the exact hash. At the threshold, a public window starts. Anyone can flag the release by attaching a bond.
3. When the window ends, anyone can trigger execution. The TEE worker, which alone holds the publish credential, checks that the artifact it holds matches the approved hash, then publishes.
4. The contract records the result. A quorum can later recall a release.

Layout:

```
contract/   NEAR smart contract (Rust): quorum, public window, bonded flags, recall
worker/     Stateless publisher (Rust, builds natively and for wasm32-wasip2): npm and Chrome Web Store modes
mock/       Local stand-ins for npm and the Chrome Web Store, for tests and demos
cli/        `keyturn` command line (Node): propose, approve, flag, status, verify, relay
web/        Read-only dashboard (one static page, no build): look up a release, check a file against the approved hash
```

See [THREAT_MODEL.md](THREAT_MODEL.md) for what Keyturn stops and what it does not.

### Dashboard

Live: https://keyturn-rho.vercel.app/ ([a real release, published through OutLayer](https://keyturn-rho.vercel.app/?project=npm:@scammerop08/keyturn-demo&version=0.0.3)). It reads the testnet contract and holds no keys.

```
npx serve web        # or any static file server, then open the page
```

It reads the contract over public RPC and holds no keys. The default contract is the testnet deployment below. Choosing a downloaded package hashes it in the browser and compares it with the approved hash.

Acting happens in your own NEAR wallet. **Connect wallet** loads [near-connect](https://www.npmjs.com/package/@hot-labs/near-connect) (pinned version, loaded from a CDN only when you press the button) and, depending on the release status and who you are, offers: approve, flag (with the 0.1 NEAR bond), dismiss a flag, reject, start execution, hand the release to OutLayer, or vote to recall. Each button is one transaction that the wallet asks you to approve, and the contract checks every rule again. What is tested: the rules for which button shows (`cli/test/web-actions.test.mjs`), the exact transaction each button builds, and the page in a real browser against a stand-in wallet; the real connector library loads and opens its wallet picker. What is not: I have not signed a transaction through a real wallet popup.

## CLI

```
npm run install:cli
export KEYTURN_CONTRACT=<contract account>   KEYTURN_ACCOUNT=<your account>   KEYTURN_KEY=ed25519:...
node cli/src/index.mjs help
```

Reads (`status`, `verify`) need no key. `verify npm:name@1.2.3` downloads what the registry serves, hashes it, and exits non-zero unless the contract says that exact hash was approved by the quorum and published. A recalled version fails too.

## Run the tests

```
npm run test:contract      # contract unit tests
npm run test:worker        # worker unit tests
npm run build:worker && npm run test:mock   # mock registry plus the real worker binary
npm run install:cli && npm run test:cli     # CLI logic, the local chain, relay with the real worker binary
npm test                                    # all of the above
```

The mock tests start a local registry and run the compiled worker against it. They check that the worker publishes the approved bytes, refuses a tarball swapped after approval, and fails on a wrong one-time seed. A stage-only credential cannot approve on the mock, as with a trusted publishing identity on npm.

## Live on testnet

The contract is deployed at `contract.hudich-keyturn.testnet`. Reading needs no key:

```
npm run install:cli
export KEYTURN_CONTRACT=contract.hudich-keyturn.testnet
node cli/src/index.mjs status npm:demo-mwci8d1h@1.0.0     # a release from the demo run, now Recalled
```

## Try it in two minutes, no NEAR account needed

```
npm run build:worker
npm run demo:local
```

You should see 22 `PASS` lines and `ALL CHECKS PASSED`. `npm run demo:chrome` does the same for a Chrome extension. The contract here is the real contract code, run natively as a local chain (`contract/examples/localchain.rs`), with a simulated clock so the public window passes instantly. The worker is the real worker binary. Only the npm registry is a mock. The local chain does not check signatures or gas; those are the NEAR runtime's job, so use the testnet demo below for that part.

## Full demo

The demo registers a project on the testnet contract, uploads build artifacts to a local mock npm registry, and walks through the attack scenarios with the real contract and the real worker binary. Only the registry is mocked.

```
npm run install:cli && npm run build:worker && npm run build:contract
# create a main testnet account with near CLI (save the key to the legacy keychain), then:
cp .env.example .env        # set KEYTURN_MAIN_ACCOUNT
npm run setup:testnet       # creates sub-accounts, deploys and initialises the contract
npm run demo
```

What it checks, in order: a stage-only CI account cannot approve; one maintainer alone cannot release; execution is refused while the public window is open; after quorum and window the worker publishes and the contract records it; `verify` passes on the served bytes; a tarball swapped after approval is refused by the worker and never recorded; a quorum recall makes `verify` fail.

Build note: `contract/.cargo/config.toml` sets `--cfg near` for the wasm target. Without it near-sdk-env compiles its local fallback, and panic messages never reach the chain.

## npm: publish modes and their limits

The worker has two modes for npm. Both only act on the hash the quorum approved.

- **Direct publish (default).** CI uploads the build artifact anywhere and proposes its SHA-256 to the contract. After quorum and the public window, the worker downloads the artifact without credentials, checks the hash and the package name and version in `package.json`, and publishes with a granular token held only by the worker. It then downloads what the registry serves and checks the hash again. This needs a token with "bypass 2FA". npm will remove direct publishing with such tokens in January 2027 ([npm changelog](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)), so this mode has an end date. Verified against the real registry on 2026-11-12: a new package's first version took longer than ten seconds to appear, so the worker now waits up to a minute for it.
- **Staged approve.** CI runs `npm stage publish` and the worker approves the staged version with a one-time code. npm no longer allows new authenticator-app setups, so this works only for accounts that still have one, and npm intends approval to be a human 2FA step. It is kept for those accounts and for the mock registry.

**Real npm, verified.** `npm run demo:real -- 0.0.2 --yes` runs the whole chain with nothing mocked: the testnet contract enforces the quorum and window, the worker publishes to the real npm registry, and the contract records it. The run for `@scammerop08/keyturn-demo@0.0.2` is the one linked from the project page. npm answers a publish with `202 Accepted` and shows a new version a few minutes later, so the worker answers `pending` and is safe to ask again: a repeated request confirms what the registry serves, never publishes twice, and refuses to touch a version that exists with other bytes.

The registry address is read from the operator's environment, never from the request, so a requester cannot make the worker send its token elsewhere. Artifact URLs must be `https` and must not contain credentials.

## Watchtower

The public window only helps if someone looks. `keyturn watch` is the one who looks:

```
keyturn watch npm:name@1.2.4 --tarball build.tgz --registry https://registry.npmjs.org --flag
```

It checks that the file is exactly the bytes the quorum approved, finds the previous version on the registry (or takes `--previous old.tgz`), and reports what is new in this release: an added or changed install script (`preinstall`, `install`, `postinstall`), dependencies from a URL, newly appearing process execution, network access, `eval`, reads of credential or wallet files, encoded blobs, and new executables. Reading credentials and using the network in the same release is the exfiltration shape and counts as high. Only what is new counts, so a package that always spawned processes is not reported for it. With `--flag`, a high finding inside the public window (status Pending) flags the release with a 0.1 NEAR bond, which blocks execution until the members decide. Exit code 3 means a flag-worthy release.

`--ai` adds a second opinion from NEAR AI Cloud (`NEAR_AI_API_KEY`, and the model name in `KEYTURN_AI_MODEL`, which is not guessed). The package text is sent as untrusted data with an instruction to ignore anything inside it, and the answer can only add a finding, never lower the rules' verdict.

Honest numbers: the rules are tested on synthetic attacks (install-script downloads, credential theft plus network, URL dependencies, obfuscated blobs) and produced no findings on five real version pairs I tried (chalk, express, lodash, axios, commander). I have not tested them against real malicious releases, so treat them as a net with large holes: a determined attacker can avoid these patterns. The value is a cheap first filter that makes a human look. The AI call has been tested only against a stub of the API, not the live service.

## Break-glass recovery

If maintainers lose their keys, a project must not be stuck forever, and a stolen key must not be able to take it over either. A project can name guardians in advance, accounts that are not members. The members' quorum has to propose the same guardians for them to take effect (`keyturn guardians`). Later, if keys are lost, the guardians' threshold can start a recovery that replaces the member list (`keyturn recovery start|approve|status`). It waits seven days in public. Any current member can cancel it during that time (`keyturn recovery cancel`), and anyone can finish it afterwards (`keyturn recovery finish`). Approvals given by members who were removed stop counting for releases that were still waiting.

The wait is seven days, so the demo shows this on the simulated clock (`npm run demo:local`, step 8). It is tested in the contract unit tests and over the local chain. Limits are in [THREAT_MODEL.md](THREAT_MODEL.md).

## Chrome Web Store

The worker has a `chrome` mode. The quorum approves the SHA-256 of an extension ZIP. After the window the worker downloads the ZIP, checks the hash and the `manifest.json` version, wraps it in a CRX3 file signed with an RSA key that only the worker holds, uploads it through the Chrome Web Store API v2 and requests publication. CI holds neither the signing key nor any store credential.

- The extension id is derived from the signing key, so the worker refuses any request that names an extension its key does not own (`key_mismatch`).
- The store address comes from the operator's environment, never from the request, as for npm.
- The worker's CRX3 output is byte-identical to the output of the independent `crx3` npm package for the same key and ZIP (checked once by hand, not part of the test suite).
- `keyturn verify chrome:<extension id>@<version>` downloads the live CRX from Google's update service and hashes the ZIP inside it. The service only serves the latest version, so it also checks the version inside.

```
npm run build:worker
npm run demo:chrome
```

Limits, stated plainly: this mode is tested against a mock store that checks the CRX3 signature with real cryptography, not against the real Chrome Web Store. The store reviews uploads before they go live, so the worker can only confirm that the store accepted the upload; `verify` shows what is actually live. A forum report says the first CRX upload for an extension may have to be done by hand in the developer dashboard so that the store records the signing key ([thread](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/SybCdMk2LIE)); I could not confirm that. Environment: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID`, `CRX_PRIVATE_KEY`; optional `KEYTURN_CWS_API`, `KEYTURN_OAUTH_URL`.

## Running the worker in a TEE (OutLayer)

The worker is built to run on [OutLayer](https://docs.near.org/primitives/off-chain-compute/outlayer), NEAR's TEE compute: it reads one JSON request on stdin, writes one JSON result of at most 900 bytes on stdout, reads secrets from environment variables, and makes HTTP calls through `wasi:http`. Those are the constraints OutLayer documents (the same page lists a 60 second limit per run).

```
npm run build:worker:wasm      # worker/target/wasm32-wasip2/release/keyturn-worker.wasm (about 700 KB)
cargo install wasmtime-cli --locked
npm run test:cli               # includes cli/test/wasi.test.mjs, which runs the wasm under wasmtime
```

What is verified: the wasm build runs under wasmtime, and over `wasi:http` it publishes to the mock npm registry, refuses a swapped artifact, and signs and uploads a CRX3 to the mock Chrome store.

What was also done on the OutLayer testnet: the wasm is deployed as the project `hudich-keyturn.testnet/keyturn-worker`, the npm token is stored as an OutLayer secret (it never appears in a request or in this repository), and a real release went through it. `cli/scripts/demo-outlayer.mjs` drives the contract (register, propose, two approvals, public window, execute), calls `outlayer run` for the worker, and records the result on the contract. `@scammerop08/keyturn-demo@0.0.3` was published to the real npm registry by the worker running inside OutLayer, and `keyturn verify` reports it as approved by the quorum and published. A run costs about 0.0013 NEAR. Two things showed up in that run: the answer to the first `outlayer run` was lost to a timeout although the publish had happened, and the retry got an HTTP 409 from npm ("previously staged"). The worker now treats that 409 as `pending`, so asking again confirms the version instead of failing.

**The contract calls OutLayer itself.** After the window, `execute_release` moves a release to `Executing`. Anyone then calls `request_publish(project, version, artifact_url)` with 0.02 to 0.08 NEAR (one to four attempts) and 300 Tgas. The contract builds the worker request from the hash it stores (the caller only picks where the file is downloaded from, and the worker refuses any file whose SHA-256 differs), calls `request_execution` on `outlayer.testnet` for the one worker project that was set with `set_outlayer`, and OutLayer calls `on_publish_result` back. The contract marks the release `Released` only if the worker reports a published hash equal to the approved one. `set_outlayer` can be called once and only by the contract account, so nobody can later point the contract at a worker that merely echoes the hash. The old path (a worker account calling `confirm_published`) still exists as a fallback and for the local mock. For the credential to be used only through the contract, the OutLayer secret is restricted with `outlayer secrets access --project <owner/name> --access allow-all --via <contract>`. On testnet the hand-off was run with an artifact that does not have the approved hash: the contract called OutLayer, the worker ran inside OutLayer with the secret (readable only through this contract), answered `hash_mismatch`, the callback recorded that, the release stayed `Executing` and npm got nothing. A real release went through it: `@scammerop08/keyturn-demo@0.0.4` was published to npm by the worker inside OutLayer after the contract called it, and the contract itself recorded `Released` from OutLayer's answer (event `release_published` with `via: outlayer`); `keyturn verify` agrees. **OutLayer sometimes loses the answer, and the contract asks again by itself.** OutLayer's public job list for the account that called `request_publish` (`https://testnet-api.outlayer.ai/public/jobs?user_account_id=watch.hudich-keyturn.testnet`) showed 14 runs: 5 completed, 1 was refused by the secret's access rule (before I allowed the contract), and 8 `failed` with `Failed to submit to NEAR: the chain did not take resolve_execution … Execution request not found`. In those 8 the worker had run (once after it had already uploaded the package to npm), but OutLayer's own transaction handing the result back reached the chain 233 to 338 blocks after the request, and NEAR's yield times out after 200 blocks, so the contract's callback got `null`. The cause is on OutLayer's side (its executor picked the job up late); it came in bursts of consecutive failures, and it did not depend on the instruction limit or on the secret's lock. So `request_publish` now keeps a small record per release and retries by itself: the caller attaches up to 0.08 NEAR (0.02 per attempt, at most four), each attempt is sent with `payer_account_id` set to the caller so OutLayer refunds what it does not use straight to them, and what was not spent is returned when the chain ends. It asks again when the answer was lost, when the OutLayer call itself failed (the deposit then comes back to the contract and is credited to the escrow), or when the worker says `pending` or reports a transient error; it stops for good on `hash_mismatch` and the other final errors, and on a published hash that is not the approved one. Only one chain of attempts runs per release at a time, and one that never answered can be replaced after 215 blocks, which returns its money. Four attempts is a gas limit, not a choice: OutLayer's `request_execution` needs at least about 55 Tgas (I measured: 52 fails, 55 works; `cli/scripts/probe-outlayer-gas.mjs`), each retry reserves the next one's gas from what is left of the 300 Tgas of the transaction, and the contract only starts a retry when enough gas is left, so a chain cannot stall halfway. Beyond that, `keyturn handoff <project>@<version> --artifact-url URL` repeats the whole thing until the release is `Released` or the worker gives a final answer (asking again is safe: the worker confirms an existing version instead of publishing twice). A mistake of mine on the way: I first gave OutLayer 40 Tgas, every attempt of that run failed at once, and the deposits of the failed calls (0.1 NEAR) stayed in the contract account because I had not accounted for NEAR returning a failed call's deposit to the caller contract; the contract now credits it back to the payer's escrow (tested), and I did not recover those 0.1 testnet NEAR. The retry has unit tests (lost answer, failed call, pending, final errors, out of attempts, low gas, an old chain replaced) and two runs on the real testnet, in [docs/evidence/retry-proof.md](docs/evidence/retry-proof.md): one where every attempt fails (four attempts fit in the gas of one transaction, then `publish_gave_up` and the escrow comes back, net cost 0.0095 NEAR), and one where the first two attempts fail because the file is not there yet and the third reaches it after I uploaded it mid-chain. Both are worker-reported transient errors. A lost answer (the yield timing out) takes the same branch in the contract, but in the runs after the change OutLayer answered at once every time, so I have not seen OutLayer lose an answer and the contract heal it. A `pending` answer is not helped by retrying at once, since the registry needs a few minutes and the attempts follow each other within seconds; `keyturn handoff` waits a minute after `pending` before it asks again.

**The worker build is pinned.** The contract does not call "whatever version of the project is active": `set_outlayer` stores the SHA-256 of the worker wasm and every request names that version. Before this, the project owner could have run `outlayer versions activate` on another build and the contract would have called it (OutLayer lists two versions of this project). The dashboard shows the pinned build in the release record. The credential is locked to the same build on OutLayer's side (`outlayer secrets access --project <owner/name> --build <sha256>`, the "one build only" rule): its access rule now reads `from:<this contract> and build:<that sha256>`, so only a call that comes through this contract and runs exactly that wasm can decrypt it. After the lock, a request still reached the worker and got its answer; A real publish under the lock worked: `@scammerop08/keyturn-demo@0.0.5` was published by the worker inside OutLayer, so the token was decrypted under the lock, the contract recorded `Released`, `keyturn verify` passes and `keyturn attest` passes all chain checks on that transaction.

**`keyturn attest <tx>`** takes the transaction that called `request_publish` and checks, from the chain: the contract itself called OutLayer, the wasm that ran is the pinned build, the request carried the approved hash, OutLayer reports success, and the contract recorded `Released` from that answer. From OutLayer's public record of the run it checks that the attestation names the same pinned build, project and caller, that its input hash equals the SHA-256 of the request in the transaction, and that it carries a TDX quote for this transaction. That record is only data from OutLayer's server until the quote is verified. The Intel signature chain is not re-implemented: the command runs OutLayer's [outlayer-verify](https://github.com/out-layer/outlayer-verify) when it is installed and otherwise says "not checked here" and points to the dashboard check below. On the 0.0.5 release all 15 checks pass with `--require-tee` (`cli/test/attest.test.mjs` runs the chain and record checks on that transaction and on tampered copies).

**The TEE attestation is verified, twice, with OutLayer's own verifier.** (1) `outlayer-verify job 98626 --network testnet --api https://testnet-api.outlayer.ai`, built from OutLayer's [source](https://github.com/out-layer/outlayer-verify) and run on my machine, reports `PROVEN` (exit code 0): Authenticity (the Intel signature chain, eight sub-checks, trust anchor the Intel SGX Root CA compiled into the tool, TCB UpToDate), Identity (the worker's measurements are approved on `worker.outlayer.testnet`), Binding (the quote's report data equals the hash of this execution's task fields), and Input and Output (the request and the answer recovered from the transaction hash to the attested values). The Intel collateral was read from the register contract on chain and is byte-identical to the API's copy. The answer that is bound into the quote is the worker's `{"ok":true,"published_hash":"59a6a416…"}`. The tool's default API address in the version I built is OutLayer's retired one (HTTP 410), so `--api` is needed. The saved bundle re-checks with no network: `outlayer-verify bundle docs/evidence/outlayer-verify-job-98626-bundle.json --offline` (also `PROVEN`). `keyturn attest` runs this tool (set `KEYTURN_OUTLAYER_VERIFY` if it is not on the PATH). (2) Earlier I had pressed *Verify* on OutLayer's dashboard for the same job (network set to testnet): the same three layers pass, and the saved screenshot is in [docs/evidence/](docs/evidence/). What this does not show: that I read or audited `outlayer-verify` (I built it and ran it); that the pinned wasm hash is reproducibly built from this repository; or that OutLayer's operators cannot misbehave beyond what their TEE design claims. A valid quote shows what ran on genuine hardware.

What is not: the wasm that did the publish above was built before the 409 change (the source here includes it), and I have not shown that this source compiles to the pinned hash.

**The dashboard's transactions were executed for real, through a script and not a wallet popup.** `cli/scripts/dashboard-tx-check.mjs` asks the dashboard's own code (`web/actions.js`) what each account may do on a release, builds the dashboard's own request, signs it with the account's real testnet key and sends it to the real contract: approve (a non-member sees the button disabled, a repeat approval is refused), flag with the 0.1 NEAR bond (refunded after two rejections), reject, start execution after the window, and hand to OutLayer (a plain http URL is refused before anything is sent). All checks passed. A real wallet popup, signed by a person, is still untested by me, and a script cannot do it.

**Retry soak.** `cli/scripts/soak-handoff.mjs` runs one safe round trip through the contract and OutLayer every few minutes. I stopped it after three runs because my other scripts were using the same accounts at the same time (one run is marked failed for that reason), and replaced it with the forced runs in [docs/evidence/retry-proof.md](docs/evidence/retry-proof.md); the three runs are in [docs/evidence/soak-handoff.md](docs/evidence/soak-handoff.md).

Mainnet: not done. [docs/MAINNET.md](docs/MAINNET.md) has the plan, and `node cli/scripts/mainnet-preflight.mjs` reads the real mainnet (no key, nothing sent): `outlayer.near` answers, a run is estimated at 0.013 NEAR, `worker.outlayer.near` lists 72 approved measurements, and the contract would lock about 5.3 NEAR for storage.

## Prior art

Google's Wombat Dressing Room (2020) is a central npm publish proxy that holds a 2FA bot account. It uses a single approval and its operator holds the secrets. Keyturn adds an approval quorum, a public window, and an onchain policy and audit log, and the credential is bound to one worker build.

## License

MIT
