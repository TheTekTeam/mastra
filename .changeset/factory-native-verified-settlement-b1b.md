---
'@mastra/factory': patch
---

Stage a default-inert trusted native-reservation settlement CAS for Factory execution epochs, requiring exact independently resolved terminal proof and an append-only receipt ledger before clearing UNKNOWN/running reservations. Fence concurrent new attempts on the same unsettled run and serialize settlement with start/quiesce through a PostgreSQL epoch-row revision write. No Factory runtime registration, proof producer, native handover or production writes are enabled.
