# Self-hosted Better Auth: deployed policy provenance

This document records the security-relevant behavior preserved by the frozen
Factory 0.25 host-composition recovery. It does **not** authorize broadening
network access, creating operator accounts, or enabling production mutations.

## Previously deployed behavior (verified 6 November 2026)

The canonical Dell Factory service was running from the immutable release
`0.25.0-9d98bbed-receipt-acl-20261106`. Its owner-private
`src/mastra/index.ts` (SHA-256
`3f8e9548e3164e2192e971bad2993a0e7378742e2cebb1e000be467bda7bd450`)
selected `MastraAuthBetterAuth({ secret: process.env.BETTER_AUTH_SECRET,
signUpEnabled: true })` at line 168 when that configured secret was present,
after shared-platform and WorkOS precedence. The generated serving bundle
`.mastra/output/mastra.mjs` (SHA-256
`666f4a700a71791221120b6b57e3f73d0d48d2d736cb2c2b9caba96f32fd12a9`)
independently contains the same `signUpEnabled: true` at line 95.

The installed Better Auth provider's compiled `dist/index.js` (SHA-256
`6073bb7ae271c1cc054914e7f808f588377a9273ff88f07f78327704ce301a6d`)
assigns `signUpEnabledConfig = options.signUpEnabled ?? true` (line 438),
then `emailAndPassword.disableSignUp: !this.signUpEnabledConfig` (line 489).
Consequently the live 9d98 configuration had `disableSignUp: false`
when Better Auth was selected. This conclusion is based on two immutable
host artifacts and the provider implementation, not a historical source-branch
assumption.

At verification time the canonical Factory listener was bound to
`127.0.0.1:14111` and Tailscale Serve listed tailnet-only routes. These
facts do not guarantee that all reachable clients are trusted, nor do they
make self-registration intrinsically safe.

## Recovery scope and follow-up policy

The accepted CAS/quota source snapshot `8df229bd` had dropped the existing
self-hosted Better Auth provider selection and dependency. Its generated
candidate therefore returned 404 on the established operator sign-in route.
The recovery restores that **existing** conditional behavior and leaves the
shared-platform/WorkOS/explicit-disable precedence intact. It does not
change the host's Better Auth credential, origin, user membership, network
publication, or MCP write permissions.

Open signup for clients who can reach the Better Auth endpoint is a meaningful
security tradeoff. Restricting signup or provisioning an invite-only operator
identity should be handled as a **separate approved policy change** with an
operator-lockout rehearsal, explicit negative registration tests, and a
recoverable cutover. The present recovery must not silently change that policy
while repairing the missing operator sign-in route.

Acceptance evidence: exact-head hosted Factory 0.25 quality CI; independent
dual-root-pinned disposable PostgreSQL 18 real HTTP signup/signin, scoped
project GET with numeric `automationRevision` and typed flags, native receipt
JSON 404, and anonymous 401. No production signup or mutation is part of
that qualification.
