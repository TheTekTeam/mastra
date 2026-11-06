---
'@mastra/core': patch
'@mastra/pg': patch
'@mastra/factory': patch
---

Stage a default-inert, PostgreSQL transaction-bound managed Core effect admission
contract with database-clock GP lease checks, immutable origin and B1 epoch
fencing, duplicate/UNKNOWN preservation, and two-process revocation races.
No live Core gateway, lease issuer, manager handover or production writes are
enabled.
