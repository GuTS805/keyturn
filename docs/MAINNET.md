# Running Keyturn on mainnet

Status: **not done and not tested on mainnet.** Everything in this repository was run on testnet. This page is the plan, with what is known and what is not. It needs a funded mainnet account and keys that only the owner should hold, so it is a task for the owner, not for a script that runs unattended.

`node cli/scripts/mainnet-preflight.mjs` reads the real mainnet (no key, nothing sent) and reports:

- `outlayer.near` answers `estimate_execution_cost`: one run with Keyturn's limits is about 0.013 NEAR. The contract sends 0.02 NEAR per attempt and OutLayer refunds the payer the rest.
- `worker.outlayer.near` lists the approved worker measurements (72 when checked). The TEE identity check reads this list.
- The contract wasm is about 526 KB, so about **5.3 NEAR** stays locked for its storage.

## Steps

1. **Fund an account** with roughly 7 NEAR (contract storage 5.3, a few NEAR for calls). Create the contract account (for example `keyturn.<you>.near`) with its own key.
2. **Build and deploy the contract** (`npm run build:contract`, then `near deploy` from your own key), then `new` with a worker account. The worker account is only the old fallback path (`confirm_published`); the OutLayer path does not use it.
3. **Deploy the worker to OutLayer mainnet.** `npm run build:worker:wasm`, then `outlayer upload` and `outlayer deploy` with the CLI logged in to mainnet. Set the credential as an OutLayer secret (`outlayer secrets set` with the mainnet profile). The token never goes through this repository or a request.
4. **Pin the build and lock the secret.** Call `set_outlayer` once from the contract account with `contract: "outlayer.near"`, your project, and the `version_key` (the SHA-256 of the wasm, which `get_project` and `list_versions` on `outlayer.near` show). Then restrict the secret: `outlayer secrets access --project <owner/name> --profile default --access allow-all --via <contract>` and `outlayer secrets access ... --build <wasm sha256>`.
5. **Register a project**, then run a release through `propose`, two `approve`, the public window, `execute`, and `request_publish` (or `keyturn handoff`). Check it with `keyturn verify` and `keyturn attest <tx> --require-tee`.

The CLI takes `KEYTURN_NETWORK=mainnet`. The helper scripts in `cli/scripts/` (`setup-testnet.mjs`, `setup-outlayer.mjs`, `demo-*.mjs`) are written for testnet and use testnet accounts and key files; they are not meant for mainnet.

## What is known and what is not

- Known from the preflight: the mainnet OutLayer contract and its approved-measurements list exist and answer the same methods that were used on testnet.
- Not known: that mainnet OutLayer behaves like testnet in the details that mattered here. The gas needed by `request_execution` (about 55 Tgas on testnet), how often answers are lost to the 200-block yield timeout, and the exact format of the answer were all measured on testnet only.
- The npm token is a real credential on mainnet. Use a dedicated bot account with a granular token, and keep the demo package separate from anything people depend on.
- The contract has had no audit. See THREAT_MODEL.md.
