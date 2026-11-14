# The contract's retry, on the real testnet

Both runs use `cli/scripts/demo-handoff.mjs` against `contract.hudich-keyturn.testnet`, with the real OutLayer worker. Nothing is published to npm in either. The contract sends 0.02 NEAR per attempt out of the 0.08 NEAR attached and retries by itself; the events below are the `EVENT_JSON` lines of the transaction.

## 1. Every attempt fails: four attempts, then it gives up and returns the money

The artifact URL serves nothing (HTTP 404), so the worker answers `artifact_fetch_failed` each time, which is a retryable error.

Command: `node --env-file=.env cli/scripts/demo-handoff.mjs 0.0.9-unreach-a <404 url> --yes --unreachable`
Transaction: `FHPH3tfUA7ejZm7k2jxHTCdNdbKERFP6W5QTtZHo6vSX`

```
publish_requested (up to 4 attempts)
publish_failed artifact_fetch_failed (the contract asks again, 3 left)
publish_failed artifact_fetch_failed (the contract asks again, 2 left)
publish_failed artifact_fetch_failed (the contract asks again, 1 left)
publish_failed artifact_fetch_failed (final)
publish_gave_up
PASS  the contract holds no money for this release any more
PASS  the contract asked again by itself 3 times (4 attempts in all), saw 3
PASS  then it gave up and said so (publish_gave_up)
PASS  the release stays Executing, and can be handed over again
PASS  of the 0.08 NEAR attached, all but 0.0095 NEAR (gas and OutLayer's base charge) came back
```

This shows the four-attempt chain fits in the gas of one 300 Tgas transaction on the real chain, and that the escrow is returned.

## 2. The first attempts fail, then it recovers

The file the worker must download does not exist yet. About four seconds after the request, the file was uploaded to FastFS with `outlayer upload`. The approved hash was wrong on purpose, so the worker's answer once it reaches the file is its final `hash_mismatch` and nothing is published.

Command: `node --env-file=.env cli/scripts/demo-handoff.mjs 0.0.9-heal-a <url of a file not yet uploaded> --yes --tamper --appears-later`
Transaction: `72SEnknViMSWAeUNXgvd1ojRjrMjdL7KqeGZzY5UUjVT`

```
publish_requested (up to 4 attempts)
publish_failed artifact_fetch_failed (the contract asks again, 3 left)
publish_failed artifact_fetch_failed (the contract asks again, 2 left)
publish_failed hash_mismatch (final)
PASS  the contract holds no money for this release any more
PASS  the first 2 attempt(s) failed because the file was not there yet, and the contract asked again by itself
PASS  a later attempt reached the file and the worker gave its final answer: hash_mismatch
PASS  the contract did not give up
```

## What this does not show

- Both runs heal or exhaust a **worker-reported transient error** (`artifact_fetch_failed`). A **lost answer** (OutLayer's yield timing out, the callback getting `null`) goes through the same retry branch in the contract, and that branch is unit-tested, but I have not seen OutLayer lose an answer in a run since the retry was added: in the runs after the change OutLayer answered at once every time.
- `pending` is not helped by retrying at once. The registry needs a few minutes to show an upload, and the contract's attempts follow each other within seconds, so a real publish that is still pending will use up the attempts. `keyturn handoff` waits a minute after a pending answer and asks again; so does anyone calling `request_publish` later.
- Two soak runs were disturbed by my other scripts using the same accounts at the same time, so the soak was stopped after three runs (all three ended with the worker's `hash_mismatch`; one of them is marked failed in `soak-handoff.md` because it ran while another script was using the same accounts).
