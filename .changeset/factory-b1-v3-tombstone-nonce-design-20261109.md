---
'@mastra/factory': patch
---

Document a default-off, non-authorizing Factory B1 post-tombstone V3
PostgreSQL row-lock and one-use challenge/nonce CAS design, with canonical
source-only tombstone and nonce-key derivation and adversarial unit tests.
No live PG schema, migration, runtime signer, route or rebind authorization
is installed; real PG18 race/replay acceptance remains outstanding.
