# Factory B1 V3 Native StorageOps: Ephemeral PG18 Acceptance

**Status: draft, source-only and UNINSTALLED. No Factory runtime activation, GP
mTLS enrolment, PM signer, route, production migration or authorization.**

This stacked test slice validates the source-only
`FactoryGpPgB1V3NativeStorageOps` from the prior draft against **physical**
PostgreSQL 18.6 row locks, exact SQL foreign keys, append-only triggers and
one-use nonce constraints. The tests use only synthetic *in-process private
test seams* and ephemeral **test-only** Ed25519 PM keys. Those do **not**
constitute authenticated live GP/PM authority.

## Admission / command

Run only on a trusted Dell development host where UID995 `mastra-ci` already
owns the independently qualified *rootless* Docker socket
`/var/lib/mastra-ci/run/docker.sock`. The pinned
`postgres@sha256:300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736`
image must already be cached, with **no image pulls**.

```bash
cd mastracode/factory
FACTORY_GP_B1_V3_NATIVE_PG18_EPHEMERAL=I_ACK_SOURCE_ONLY_EPHEMERAL \
  python3 scripts/verify-gp-b1-v3-native-pg18.py
```

The harness fails closed without exact opt-in, a non-root orchestrator,
UID995 rootless security options, pinned cached image, exact SHA256 manifest
for uninstalled `GP-B1-V3-PROPOSED-UP.sql`, mapped 127.0.0.1 port and a
fresh unique ephemeral DB marker. It creates a unique Docker container,
random DB and password; PostgreSQL is published **only to host loopback**
through rootless Docker's regular bridge. Docker's `--internal` network was
tested and found to disable published host ports on this engine; therefore
**container egress is not formally denied** by this harness. This is a
deliberate, documented limit. There are no outbound calls in the test.

The original B1 schema and the exact proposed raw SQL are applied **only to
the randomly named ephemeral database used by Node**. The adapter's
`ensureCollections` is then exercised against the existing physical
FK/triggers, preventing the SQL-model-only false positive where DDL was
mistakenly applied to the container's default `postgres` DB instead of
the actual native test DB. On every success or exception, the unique test
container is forcibly removed and checked absent.

## Source-only assertions

1. Raw exact-scope FK rejects an orphan; immutable tombstone trigger survives
   native `ensureCollections`. An injected exact-scope FK failure rolls back
   the earlier original B1 row in the same native `withTransaction`.
2. Two independent `PgFactoryStorage` client connections race
   `revokeWithTombstone` under the epoch row lock; precisely one native
   original+B1 tombstone commits, duplicate revoke denies.
3. Three independent Node **processes** are started before a five-second
   Factory challenge is minted, then receive the same real test Ed25519-signed
   V3 packet. Exactly one native `consumePrivateV3Nonce` audit CAS wins;
   second and pre-expiry fresh-process replay deny.
4. A PostgreSQL **process restart** preserves physical native tombstones and
   exactly one nonce consumption; a new SQL session cannot insert the
   duplicate CAS or delete immutable nonce rows.

The test key and synthetic private test seam are deliberately non-production.
**No Factory write is ever authorized** by this audit-only nonce consumer.

## Still blocking live readiness

- Actual independently authenticated GP mTLS and PM V11 signer/key enrolment.
- Independently verified current PM writer epoch transition chain (the
  source-only PM packet inspector validates an expected object, not a live
  PM chain).
- Security review of raw migration rollout, immutable original-table policy,
  rollback, and already existing B1 rows. Proposed DOWN is uninstalled and
  fails closed when V3 data exists.
- Exact-head HP6 independent review, security/no-regression checks and
  production write gate qualification on the complete PR stack.

All capability flags remain default OFF. No production database was touched.

## Build prerequisites in the isolated worktree

Package `dist` is intentionally absent in a fresh monorepo checkout. Run
these source-build-only commands from the **worktree repository root** (no
package.json/lock edits):

```bash
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm -r --workspace-concurrency=2 --filter '@mastra/core^...' --if-present run build:lib
pnpm -r --workspace-concurrency=2 --filter '@mastra/core^...' --if-present run build
pnpm --filter @mastra/core build:lib
pnpm --filter @mastra/pg build:lib
pnpm -C mastracode/sdk build:lib
pnpm --filter @mastra/libsql build:lib
pnpm --filter @internal/workspace build
pnpm --filter @mastra/auth build:lib
pnpm --filter @mastra/mcp build:lib
pnpm -r --workspace-concurrency=2 \
 --filter @mastra/auth-workos --filter @mastra/auth-studio \
 --filter @mastra/slack --filter @mastra/platform-workspace --if-present run build
pnpm -C mastracode/factory check
```

The separate `mastracode/sdk` package is not currently discovered by the
workspace's recursive filter and must be built explicitly. Never make
production dependency changes just to run these tests.
