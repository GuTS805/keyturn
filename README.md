# Keyturn

Nobody ships a release alone.

Keyturn puts a two-person rule in front of software releases. A NEAR contract holds the approval policy (who must approve, how many, and a public waiting window). The credential that actually publishes the package lives only inside a TEE worker, and the worker acts only on releases the contract has approved.

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
worker/     Stateless publisher (Rust, builds natively and for wasm32-wasip2)
mock/       Local stand-in for npm's staged publishing API, for tests and demos
cli/        `keyturn` command line (Node): propose, approve, flag, status, verify, relay
```

The dashboard is added as it is built.

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
npm run install:cli && npm run test:cli     # CLI logic, including relay with the real worker binary
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

- **Direct publish (default).** CI uploads the build artifact anywhere and proposes its SHA-256 to the contract. After quorum and the public window, the worker downloads the artifact without credentials, checks the hash and the package name and version in `package.json`, and publishes with a granular token held only by the worker. It then downloads what the registry serves and checks the hash again. This needs a token with "bypass 2FA". npm will remove direct publishing with such tokens in January 2027 ([npm changelog](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)), so this mode has an end date.
- **Staged approve.** CI runs `npm stage publish` and the worker approves the staged version with a one-time code. npm no longer allows new authenticator-app setups, so this works only for accounts that still have one, and npm intends approval to be a human 2FA step. It is kept for those accounts and for the mock registry.

The registry address is read from the operator's environment, never from the request, so a requester cannot make the worker send its token elsewhere. Artifact URLs must be `https` and must not contain credentials.

Other registries do not have the 2FA problem. The Chrome Web Store verified-uploads feature signs packages with a developer-held key, which suits this design, and is the next adapter.

## Prior art

Google's Wombat Dressing Room (2020) is a central npm publish proxy that holds a 2FA bot account. It uses a single approval and its operator holds the secrets. Keyturn adds an approval quorum, a public window, and an onchain policy and audit log, and the credential is bound to one worker build.

## License

MIT
