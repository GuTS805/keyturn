# Hand-off soak

Runs: 3, from 2026-11-14T07:05:01.484Z to 2026-11-14T07:24:25.435Z.
Each run is one safe round trip: the contract hands a release with a deliberately wrong approved hash to OutLayer, the worker refuses it, nothing is published. A run passes when the contract ends the hand-off with the worker's final `hash_mismatch` and holds no money afterwards.

Passed: 2 of 3.
Runs in which the contract had to ask again by itself (a lost answer, a failed call, or `pending`): 0.

How the runs ended:

- publish_failed hash_mismatch: 3

| run | started (UTC) | asked again | ended | passed |
|---|---|---|---|---|
| 0.0.8-soak-mwg29eek-1 | 2026-11-14T07:05:01.484Z | 0 | publish_failed hash_mismatch | yes |
| 0.0.8-soak-mwg2qc7a-1 | 2026-11-14T07:18:11.782Z | 0 | publish_failed hash_mismatch | yes |
| 0.0.8-soak-mwg2qc7a-2 | 2026-11-14T07:24:25.435Z | 0 | publish_failed hash_mismatch | no |
