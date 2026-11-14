# Hand-off soak

Runs: 1, from 2026-11-14T07:05:01.484Z to 2026-11-14T07:05:01.484Z.
Each run is one safe round trip: the contract hands a release with a deliberately wrong approved hash to OutLayer, the worker refuses it, nothing is published. A run passes when the contract ends the hand-off with the worker's final `hash_mismatch` and holds no money afterwards.

Passed: 1 of 1.
Runs in which the contract had to ask again by itself (a lost answer, a failed call, or `pending`): 0.

How the runs ended:

- publish_failed hash_mismatch: 1

| run | started (UTC) | asked again | ended | passed |
|---|---|---|---|---|
| 0.0.8-soak-mwg29eek-1 | 2026-11-14T07:05:01.484Z | 0 | publish_failed hash_mismatch | yes |
