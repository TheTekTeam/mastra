# Self-hosted Better Auth: owner-controlled registration policy

The Factory 0.25 host-composition recovery restores the established
`/auth/api/sign-in/email` route when `BETTER_AUTH_SECRET` is configured.
It deliberately **does not enable new account registration by default**.

## Enforced policy

- Without a nonblank `BETTER_AUTH_SECRET`, the self-hosted provider is not
  installed. Explicit disabled auth, shared-platform identity and WorkOS
  retain their higher selection precedence.
- With a configured secret, existing eligible users may sign in, but the
  provider receives `signUpEnabled: false` by default. This maps to native
  Better Auth `emailAndPassword.disableSignUp: true`.
- New registration requires the **exact** trusted host environment setting
  `MASTRACODE_BETTER_AUTH_SIGNUP_ENABLED=true`. Missing, blank, `TRUE`,
  `1` or any other value does not enable registration.
- Only GP's authorized host operators control this setting. It must never be
  accepted from a client request, header or MCP write operation. A controlled
  bootstrap window needs separate approval and a verified return to disabled.
- This recovery grants no new permissions, creates no user, changes no
  credential, and does not enable production MCP writes.

## Why this is an intentional security change

Read-only inspection of the previously serving Factory 9d98 runtime observed
a Better Auth selector with `signUpEnabled: true`. That observed artifact
was not independently accessible inside HP6's source-review assignment;
**acceptance does not depend on relying on that historical policy claim**.

The later frozen CAS/quota snapshot lost the provider altogether and broke
existing operator sign-in. Restoring the provider does not require preserving
open registration. The recovery therefore restores existing-account login
while deliberately selecting a secure registration default. Any signup window
must be an explicit, owner-operated opt-in.

## Required acceptance

Focused tests cover default-disabled registration, strict exact opt-in,
malformed near-matches, blank secret and identity-provider precedence. The
hosted exact-head workflow must perform a frozen web prebuild, the **actual
web build**, generated-bundle existence check and focused entry tests.
Independent disposable PostgreSQL 18 HTTP QA must use a **test-only** opt-in
to prove signup/signin, org-scoped project GET with numeric automation
revision and typed flags, native unknown receipt JSON 404 and anonymous 401.
No disposable opt-in is permitted to become a production environment value.
