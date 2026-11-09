---
'@mastra/factory': patch
---

Add an opt-in and uninstalled PG18 test-only model for authenticated B1 V3
tombstone and nonce one-use concurrency/replay semantics. The isolated rootless
container harness includes strict admission and cleanup and does not install
production storage, nonce CAS, authentication or remote execution paths.
