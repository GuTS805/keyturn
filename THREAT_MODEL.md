# Threat model

What Keyturn defends against, what it does not, and which parts are tested.

## What is trusted

| Part | Trusted to |
|---|---|
| The NEAR contract | Record approvals honestly and refuse an out-of-policy release. Its state is public. |
| The worker | Publish only the exact bytes the quorum approved, and keep the publish credential secret. |
| The quorum | At least `threshold` members are not compromised at the same time. |
| The registry (npm, Chrome Web Store) | Serve what it was given. Keyturn checks this after the fact and does not rely on it. |

The worker is the weakest link, so it is kept small and stateless. In production it should run in a TEE (OutLayer) so that even its operator cannot read the credential. In this repository it runs as a local binary, and the TEE part is not verified (see "Not covered").

## Attacks and what stops them

| Attack | Defence | Where tested |
|---|---|---|
| One maintainer account is hacked and ships a malicious version | Needs `threshold` approvals; one is not enough | contract unit tests, demo step 2 |
| The CI system is hacked | CI may only propose. It cannot approve, and holds no publish credential | contract tests, demo step 2 |
| The build artifact is swapped after approval | The contract binds the release to a SHA-256. The worker hashes the artifact it downloads and refuses a different one (`hash_mismatch`) | worker tests, demo step 6, Chrome demo step 5 |
| The registry serves different bytes than were published | The worker downloads what the registry serves after publishing and compares again. A consumer can run `verify` | worker tests, `verify` tests |
| A requester points the worker at an attacker's server to steal the token | The registry or store address comes from the operator's environment, not from the request. Requests reject unknown fields. Artifact URLs must be https without credentials. Artifact downloads carry no credentials | worker tests |
| Version mix-up: approve 1.0.0, publish 9.9.9 | The worker compares `package.json` or `manifest.json` name and version with the request | worker tests |
| A member approves twice to fake a quorum | Each member counts once | contract test |
| Rushing a release before anyone can look | A public window (up to seven days) after quorum. Execution is refused while it is open. If every member approves, there is no window by design | contract tests, demo step 3 |
| A watcher spots a bad release during the window | Anyone can flag with a 0.1 NEAR bond, which blocks execution until the members dismiss or reject | contract tests |
| A bad release is already out | The quorum can recall it. `verify` then fails for that version | demo step 7 |
| Signing for someone else's Chrome extension | The extension id is derived from the signing key. The worker refuses a request that names another id (`key_mismatch`) | worker tests, Chrome tests |
| Keys are lost and the project is stuck | Guardians start a recovery, which waits seven days in public and can be vetoed by any live member. After it, only the new members' approvals count | contract tests, demo step 8 (local clock) |
| Anyone but the worker records a publication | `confirm_published` accepts only the worker account, and only with the approved hash | contract tests |
| Secrets leaking in logs or outputs | Outputs never include tokens, secrets or keys. Registry error text is cut. Output is limited to 900 bytes | worker tests |

## Not covered

These are real gaps. Do not rely on Keyturn for them.

- **A compromised quorum.** If `threshold` members are hacked at once, the release is legitimate as far as Keyturn can tell. Keyturn raises the cost from one account to several, and adds a public window, but it is not magic.
- **Malicious code that the quorum approves.** Keyturn binds approval to bytes. It does not tell members whether the bytes are safe. `keyturn watch` (rules, optionally an AI second opinion) gives a cheap first filter and can flag during the window, but its rules are simple patterns that a determined attacker can avoid, and it has not been tried on real malicious releases. Reviewing the artifact stays the members' job.
- **A malicious worker operator.** Without a TEE, whoever runs the worker can read the credential and publish anything. The TEE integration with OutLayer is built as a WASI program but not yet run on OutLayer, so its guarantees are not demonstrated here.
- **The registry account itself.** The credential held by the worker can publish. If another route to that account exists (a recovery email, a second token, a login), the quorum can be bypassed. The package must be locked down so that the worker's token is the only way in. For npm that is a manual setting, and Keyturn cannot check it.
- **npm's end of direct publishing.** npm will remove direct publishing with 2FA-bypass tokens in January 2027. The direct mode has that end date. The staged-approve mode depends on an authenticator app that new npm accounts cannot set up.
- **Chrome Web Store behaviour.** The Chrome mode is tested against a mock store that verifies the CRX3 signature. It has not been run against the real store. Uploads are reviewed before they go live, so the worker only confirms acceptance.
- **Availability.** If the worker is down, releases stop. If members lose too many keys, the project can ship only through the recovery below.
- **Recovery limits.** Guardians (accounts that are not members, named by the members' quorum) can replace the member list after a seven day public wait, and any current member can cancel during that time. So a hostile takeover needs the guardian threshold plus every member being absent for seven days. The flip side: one compromised member can cancel a legitimate recovery and stall it, though it cannot steal anything that way. Recovery can only be started if guardians were set up in advance. Approvals by removed members stop counting, so a release approved by old members cannot execute after a recovery.
- **Timing.** The window is measured in NEAR block time and starts when quorum is reached. Watchers have only that long to flag a release, so a project should pick a window that matches how often someone is looking.
- **The local chain.** The offline demo runs the contract code natively, without signatures, gas or the NEAR runtime's storage rules. It shows policy logic. The testnet demo is the check for the rest.
