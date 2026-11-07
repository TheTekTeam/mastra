# Factory immutable output install (opt-in; default OFF)

This is a **source-build integrity gate**, not a production deployment mechanism.
Ordinary Mastra builds retain their existing behavior. It never calls `mastra deploy`,
enables MCP/Factory writes, restarts services or changes the nightly updater.

## Approval boundary

The environment variable `MASTRA_FACTORY_IMMUTABLE_RELEASE_ID` selects a release ID,
but is **not authority**. Without an independently installed, root-owned approval
at `/etc/modelspend-cluster/factory-immutable-release-approval.json`, installation
fails before copying a lockfile, writing workspace config or invoking pnpm.

The loader requires a regular, non-symlink root-owned approval file (single link,
not group/world writable), with trusted parent directories, and `schemaVersion:1`.
Each approved release pins:

- Accepted clean source commit SHA and source `pnpm-lock.yaml` SHA-256.
- Source root/project root and the exact candidate runtime and output roots.
- **Both** candidate lockfile and package.json SHA-256 values and the output lock's source-relative path.
- A complete generated-output JS/assets/config tree SHA-256 (excluding only pnpm's
  offline-reconstructed `node_modules` closure); symlinks and hardlinks fail closed.
- No untracked source outside the attested output; ignored app source/config and
  symlinked root paths fail closed.
- Source-built `@mastra/factory`, `@mastra/pg` and `mastra` CLI tar names,
  SHA-256 hashes and SHA-512 integrity strings.
- Exact `file:./artifacts/` runtime and `file:./workspace-module/` output
  importers, their structural lock entries and archive member types/paths.

A release lacking any proof is not approved, regardless of CLI flags or cached
registry packages. A verified immutable install preserves its approved lock and
runs `pnpm install --frozen-lockfile --offline --ignore-scripts`.
Skipping the install with `MASTRA_BUILD_SKIP_INSTALL` is rejected in immutable mode.

## Candidate evidence (no authority)

Run after **both candidate roots are already built and have locally pinned tar
artifacts**:

```sh
node packages/deployer/factory-immutable-candidate.mjs \
  RELEASE_ID ABS_ACCEPTED_SOURCE_ROOT ABS_PROJECT_ROOT \
  ABS_CANDIDATE_RUNTIME_ROOT ABS_GENERATED_OUTPUT_ROOT
```

The command only reads files and prints digests. Its result includes
`candidateOnly:true`; the approval loader explicitly rejects that result.
This prevents treating evidence collected by the builder as a self-approval.

An independent HP6 reviewer and operator must corroborate exact-head CI and
the source-built provenance before installing any trusted approval. Use the
accepted infrastructure verifier (dev-cluster-optimisation #227), including
the dual-root PG tar equality and lock integrity checks. Review the candidate
manifest itself, remove its non-authoritative marker only as part of that
separate approval, and install it root-owned without user-writable/symlink
parents. An approval is scoped to **one** immutable source/candidate root set.

## Two independent builds — additional reproducibility proof

The source-only `factory-immutable-two-builds.mjs` is a **read-only qualification
harness**, not a build runner. It never invokes `pnpm`, the legacy web `deploy`
script, a registry, a database or a production service. Only run it after TWO
independently staged, source-built candidates exist, each at the same accepted
source HEAD with its own root, output, runtime and lockfiles:

```sh
node packages/deployer/factory-immutable-two-builds.mjs verify-two \\
  ACCEPTED_40_CHAR_HEAD \\
  ABS_SOURCE_A ABS_RUNTIME_A ABS_SOURCE_B ABS_RUNTIME_B
```

A successful proof verifies **all 13** direct `link:` dependencies in
`mastracode/web/package.json` **plus their complete source-tracked recursive
runtime dependency closure**, not merely the 13 imported names. At accepted
e789 this is **30** runtime first-party tarballs and **27** output tarballs
(the CLI, deployer and logger packages are absent from the generated output).
The verifier derives this closure from the exact accepted source manifests;
future legitimate changes must be explicitly reflected in source and reviewed.
It reads every `.tgz` embedded package manifest without extracting any member,
rejects unsafe tar paths/links, and checks that every source `workspace:` edge
was replaced by a genuine locally pinned `file:` tar—not registry semver.
Every required first-party archive must be present, individually SHA-512 locked,
and source-name/version matched. Direct lock importers must also match their
file pins; neither runtime nor output may silently use registry, `link:` or
`workspace:` in place of a required first-party archive. Every candidate external package and
snapshot record must match its accepted-source lock metadata, including exact
third-party version and integrity. Both independently built candidate manifests,
locks, **root-specific** tarball digests and generated asset trees must match
between the TWO independent candidate builds. Runtime `artifacts/` and output
`workspace-module/` tars may differ in embedded relative `file:` dependency
paths; each variant is independently pinned and compared across the two builds.
Source HEAD, lock and no-symlink, no-hardlink boundaries are also checked.

The proof emits only `candidateOnly:true`. **It cannot install an approval**;
#47's independently controlled owner-private approval path and the accepted
infrastructure #227 full Factory/PG source/tar/dist verifiers remain mandatory.
It deliberately fails if the actual generated-output lock, local tar closure or
source-clone lock integrity is missing. This is the current expected result on
the unqualified e789 candidate. Do not forge fixtures or reuse the live F2E
lock to turn a failure green.

The standalone fake-fixture regression is safe and bypasses destructive
monorepo globalSetup:

```sh
node --test packages/deployer/factory-immutable-two-builds.test.mjs
```

### Source-built first-party archive producer (source-only, explicitly opt-in)

The guarded artifact producer is `packages/deployer/factory-immutable-artifact-producer.mjs`.
It performs a read-only preflight by default. `build` and `produce` require
**separate** explicit environment opt-in. Use **two fresh, independent, clean**
exact-HEAD source clones under private staging parents; the runtime candidate
must be a sibling directory literally named `runtime` that does not exist.
Do not point it at the live Factory host, the retained PR worktrees, or the
updater's release paths.

```sh
node packages/deployer/factory-immutable-artifact-producer.mjs preflight ACCEPTED_40_CHAR_SHA ABS_SOURCE_CLONE

MASTRA_FACTORY_IMMUTABLE_ARTIFACT_BUILD=1 node \
  packages/deployer/factory-immutable-artifact-producer.mjs build ACCEPTED_40_CHAR_SHA ABS_SOURCE_CLONE

# Only after a separately controlled, offline CLI build has generated
# mastracode/web/.mastra/output with MASTRA_BUILD_SKIP_INSTALL=1:
MASTRA_FACTORY_IMMUTABLE_ARTIFACT_PRODUCE=1 node \
  packages/deployer/factory-immutable-artifact-producer.mjs produce ACCEPTED_40_CHAR_SHA ABS_SOURCE_CLONE ABS_SIBLING_RUNTIME
```

The build compiles source-tracked first-party modules in dependency order,
through existing `build:lib`/`build` scripts, without invoking `deploy`,
`prepack`, postinstall or network. The archive packer uses npm's local
`--offline --ignore-scripts` pack list and an isolated copy, strips lifecycle
scripts, replaces every source `workspace:` runtime edge with exact
`file:` tar references and records per-archive SHA-256/SHA-512. It requires
compiled `dist/` files, clean accepted source and at least 10GiB free at
each stage. Archives are written to both runtime `artifacts/` and generated
output `workspace-module/`; existing targets are never overwritten.

**Important remaining release blocker:** this step emits
`artifactOnly:true, candidateOnly:true`; it does **not** fabricate the
generated-output `pnpm-lock.yaml`, choose new registry versions, install
dependencies, declare a release reproducible or enable any Factory writes.
After source-built packing, the complete generated lock must be reconciled
against the accepted source's third-party package/snapshot closure, followed
by TWO frozen offline installs, #51 independent-build verifier, accepted #227
source/PG verifiers and fresh HP6 approval. A missing external artifact or
source-locked version is a STOP condition, not permission to resolve online.

Fake local packer regressions (safe; no monorepo globalSetup):

```sh
node --test packages/deployer/factory-immutable-artifact-producer.test.mjs
```

**Remaining prerequisite:** a separately accepted candidate **compositor**
must reconcile generated-output third-party imports to the accepted source
lock, construct root manifests and exact frozen lockfiles, then prove two
offline frozen installs. The source-only artifact producer above solves the
bounded first-party pack stage, not this external lock-closure problem. The
read-only verifier continues to reject unqualified candidates; neither stage
supplies the missing reviewed generated-output lock or production approval.

## Non-goals and safeguards

- No registry fallback or lockfile regeneration in approved mode.
- No network or dependency lifecycle script during the approved install.
- No auth/permission elevation, automatic project adoption or production cutover.
- No approval from a caller-supplied JSON, SHA or mutable worktree file.
- If the tar artifacts, locks or Factory source change, seek fresh acceptance.
- If an offline tarball is missing from the verified store, installation stops;
  rebuild through a separately accepted deterministic process.

The older live Factory release, database, backups and active timers remain
untouched by this source-only feature. Live cutover has independent health,
rollback, PG18 and disk-headroom acceptance gates.

## Destructive monorepo test setup — disposable worktree ONLY

`e2e-tests/_local-registry-setup/prepare.js` currently invokes `git add -A`
and creates a `SAVEPOINT` commit, rewrites hundreds of package manifests, and
its cleanup invokes `git checkout .`, `git clean -fd`, and `git reset --soft`.
It is **not safe** to run the complete `e2e-tests/monorepo` suite in a source
worktree containing PR changes, staged files, untracked files, active branches,
or user data. Run that E2E suite **only in a disposable, independently created
copy/worktree** after proving that it contains no user changes. Preserve
the original source worktree and all pending PR/Factory state.

**Even the focused `immutable-output.test.ts` command triggers this directory's
Vitest `globalSetup`** and therefore the same Git SAVEPOINT and cleanup. Run
both focused and full monorepo tests only in a disposable copy/worktree.
The test body's assertions are offline/read-only, but the default suite harness is not.
For a narrow read-only check, explicitly select the standalone
`e2e-tests/monorepo/vitest.immutable.config.ts` (which has no `globalSetup`),
otherwise use a disposable copy/worktree. The exact-head CI uses this safe config.
Do not treat either test run as deployment approval.
