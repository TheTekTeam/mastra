# GP B1 V3 isolated PostgreSQL 18 race/restart harness

Status: **new source-only, opt-in and uninstalled diagnostic**. The test
provisions its own minimal TABLE/FK/trigger model inside a unique ephemeral
PostgreSQL 18 container, not the Factory server. **Passing this test does not
qualify Factory's actual B1 runtime issuer, migrations, PM V3 signature/mTLS,
or live one-use nonce consumer.** All Factory write flags remain OFF.

## Admission and exact execution

On Dell, verified prerequisite is UID995 mastra-ci rootless Docker with
DOCKER_HOST unix:///var/lib/mastra-ci/run/docker.sock (socket 0600), image
postgres@sha256:300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736
locally cached; observed server PostgreSQL 18.6. No image pulls are allowed.

The script has a deliberate three-part fail-closed admission: explicit
FACTORY_GP_B1_V3_EPHEMERAL_PG18_TEST=I_ACK_ISOLATED_TEST_ONLY, exact rootless
socket and UID 995, and Docker server reporting its rootless security option.
Missing any of these stops before creating a container.

From the git worktree root (bash), an authorized operator can use this command.
Shell redirection opens the repo file as GP before the test executes as the
restricted mastra-ci user (which cannot directly traverse GP's private home):

~~~bash
sudo -n -u mastra-ci env \
  DOCKER_HOST=unix:///var/lib/mastra-ci/run/docker.sock \
  FACTORY_GP_B1_V3_EPHEMERAL_PG18_TEST=I_ACK_ISOLATED_TEST_ONLY \
  python3 - < mastracode/factory/scripts/verify-gp-b1-v3-pg18-ephemeral.py
~~~

Safety invariants: a new random container name every invocation, pinned locally
cached image, --network none (no published ports), rootless per-user daemon,
nonroot database process UID999, 512MiB/1 CPU/100 PIDs, no host mounts,
container-scoped writable data only, no Factory database URI or secrets, and
an unconditional docker rm -f in finally. Docker --rm also cleans normal
container stop. The temporary database survives only a same-container
PostgreSQL restart during the replay test, not removal.

The operator can confirm that no test containers are retained:

~~~bash
sudo -n -u mastra-ci env \
  DOCKER_HOST=unix:///var/lib/mastra-ci/run/docker.sock \
  docker ps -a --format '{{.Names}}' --filter name=factory-gp-b1-v3-pg18-
~~~

## What is tested against real PG18 (test-only model)

- Two independent psql sessions simultaneously acquire the same native-like
  epoch row lock. One wins a one-use nonce consumption insert and the other
  returns no row; unique challenge, nonce, scope, revocation and signed packet
  constraints are database-enforced.
- One original B1 revoke and post-tombstone extension commit atomically in the
  same transaction fixture; a deliberately failed second extension does not
  leave an orphan original revocation.
- Wrong tombstone hash, stale writer epoch, unknown challenge and expired
  challenge all yield zero consumption writes before the successful race.
- Original revoke/tombstone/consumption UPDATE or DELETE is rejected by test
  immutable-row triggers.
- Identical replay is denied immediately and remains denied after restarting
  the PostgreSQL process in the same ephemeral container (persistent container
  layer); exactly one consumption exists before and after restart.
- Concrete SQL uses clock_timestamp for expiry under the lock and forbids
  stale challenge commit. All test IDs/hashes/passwords are freshly generated.

## What is deliberately NOT tested or installed

This harness constructs its own fixtures and does not call the real
Factory StorageOps PG adapters, epoch updateAtomic, GP private session
resolver, live B1 native issuer/revoker, PM V3 signer, Ed25519 verifier,
mTLS transport, V11 transition chain, challenge generator, or actual
Factory production schema. It demonstrates **PostgreSQL mechanisms and
negative-case viability only**, not the issuer's integration safety.
The example signed_packet_digest is a test-only placeholder and explicitly
does not represent an authenticated signature.

The design in GP-PG-B1-V3-TOMBSTONE-NONCE-DESIGN.md remains preliminary.
Before any activation or merge to a release, add a separate actual PG18
integration suite exercising production-bound StorageOps transactions and
real row schema, exact-source HP6 independent review/CI, whole-stack
no-regression, cancellation/failure injection, PM key rotation and replay
negative tests. Keep #57, #58 and this harness DRAFT until qualified.