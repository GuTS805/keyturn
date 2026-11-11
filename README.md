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
contract/   NEAR smart contract (Rust)
```

More components (worker, CLI, mock registry, dashboard) are added as they are built.

## Run the contract tests

```
cd contract
cargo test
```

## Prior art

Google's Wombat Dressing Room (2020) is a central npm publish proxy that holds a 2FA bot account. It uses a single approval and its operator holds the secrets. Keyturn adds an approval quorum, a public window, and an onchain policy and audit log, and the credential is bound to one worker build.

## License

MIT
