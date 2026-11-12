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

What is not: the hand-off from the contract to OutLayer is still the CLI's `relay` step, which reads the approved hash from the contract, runs the worker and reports the result as the worker account. The contract does not call OutLayer itself (no yield and resume). I have not checked the TEE attestation, so the guarantee that even the operator cannot read the credential rests on OutLayer's documentation and is not demonstrated by this repository. The wasm that did the publish above was built before the 409 change; the source here includes it.

## Prior art

Google's Wombat Dressing Room (2020) is a central npm publish proxy that holds a 2FA bot account. It uses a single approval and its operator holds the secrets. Keyturn adds an approval quorum, a public window, and an onchain policy and audit log, and the credential is bound to one worker build.

## License

MIT
