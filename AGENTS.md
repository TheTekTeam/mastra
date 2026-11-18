# Repository guidance

Unless asked, don't inspect reference or modify examples.
Use the most-specific `AGENTS.md`; for package work, read `packages/<name>/AGENTS.md` first.

Turborepo pnpm workspace; packages use strict TypeScript; Vitest tests are colocated.
For schema-backed execution, put deterministic input/output constraints (shape, types, ranges, formats, cross-field invariants) in schemas, not `execute`. Keep runtime/external checks (authorization, existence, conflicts, API responses) in `execute`.
Use literal model names/IDs from `docs/src/plugins/remark-model-tokens/models.ts` in changesets/comments; placeholders are not replaced.

Use the narrowest package build/test/lint/typecheck; run unit/integration before E2E. Prefer targeted `pnpm --filter` or `pnpm turbo build --filter` commands; avoid root setup/build scripts unless needed. Fresh clone: `pnpm install`, then build relevant dependencies. Unresolved workspace imports usually mean dependencies need building; some integration tests need `pnpm i --ignore-workspace`.

Features/new packages need docs. For docs, follow `docs/AGENTS.md` and styleguides. After code changes, read `@.mastracode/commands/changeset.md`.

Architecture: `packages/core/src`; `mastra/` config/DI; `agent/`, `tools/`, `memory/`, `workflows/`, `storage/` are modular framework components.

Read applicable `@.claude/commands/`: `changeset`, `commit`, `gh-new-pr`, `gh-pr-comments`, `make-moves`.
Read applicable `@.claude/skills/`: `playground-msw-tests` (primary for playground/UI), `e2e-tests-studio` (secondary), `mastra-docs`, `react-best-practices`, `tailwind-v4`, `mastra-frontend`, `mastra-smoke-test`, `smoke-test`.

<!-- shared-validation-policy:begin -->
## Shared final-candidate validation policy (TheTekTeam + gpcola)

**During development:** run focused, relevant tests and static/syntax/type/lint checks; iterate against the changed code without repeatedly running the full regression suite.

**Only at the final candidate:** run the repository-required full regression and security/no-regression acceptance, then obtain independent review bound to the exact commit SHA and current source/base/policy. Do not merge, deploy, close issues or enable production writes without these required gates; changing the head invalidates head-bound acceptance.

Do not trigger redundant full regression simply from a review request when the same immutable head already has valid green acceptance evidence. Re-run required full gates when the final head changes, trust/execution context changes, evidence expires, or a required gate explicitly calls for it. Project-specific stricter gates remain mandatory, and source-only tests never qualify a deployment.

See the shared policy: https://github.com/TheTekTeam/.github/blob/main/CONTRIBUTING.md.
<!-- shared-validation-policy:end -->
