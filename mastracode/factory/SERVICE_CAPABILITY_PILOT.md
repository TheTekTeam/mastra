# Factory 0.25 service-principal pilot — source-only contract

Status: **DRAFT, NOT DEPLOYED, NOT ENABLED**. This contract is stacked on the accepted
Factory 0.25 native automation CAS branch. Factory owns dispatch and durable state;
this feature adds no second scheduler. The first project is selected by **external
boot policy** (HTAI in our deployment), never hard-coded into the library.

## Enablement and principal boundaries

Absent `MastraFactoryConfig.serviceCapabilities`, **no service-capability
storage or route is registered**. A separately audited boot configuration would
need all of:

- `enabled: true`, an owner-private 256-bit-or-longer `hmacKey`;
- an exact, non-empty set of permitted project UUIDs and issuer user IDs;
- the trusted HTTPS operator `adminOrigin` (exact string);
- a real BetterAuth-enabled Factory organisation session.

Do **not** enable this for the installed Factory pilot until the native lease
provisioner and PM authority are independently accepted. No key, GP ID, project
UUID, grant or lease is provisioned by the source patch.

The admin may create a one-use, five-minute consent on
`POST /web/factory/projects/:id/service-capability/consents`, then
issue or revoke a grant at the dedicated `/grants` routes. All management
writes require the verified signed-in issuer, organisation-admin membership,
project ownership and exact HTTPS Origin. Service bearers cannot call admin
routes even when accompanied by human cookies.

The issuer receives the 256-bit `fcp1_` token **only once**. The database
stores only a keyed HMAC-SHA256 digest. Grant listing omits tokens and digests.
Every request freshly checks the persisted organisation, project, grant,
revocation, expiry, allowed actions and work-item scope; no service principal
is a general organisation administrator.

## Exact enqueue scope

The grant intent and immutable, consumed consent bind:

- `actions`: only `workItem.enqueue` and/or `projectAutomation.set`;
- `workItemIds`: a maximum of eight exact UUIDs, no wildcards;
- `enqueueProfiles`: one per work item, with exact `workItemId`,
  `role`, `skillName` and `argumentsDigest` (64 lowercase SHA-256 hex);
- `ttlSeconds`: 60–86,400.

For an enqueue request, the digest is SHA-256 of UTF-8 JSON encoding
`[arguments !== undefined, arguments ?? null]`. This distinguishes absent
arguments from an explicit empty string. The Factory role must also pass
the native role enum. Every HTTP request must match its entire profile, not
merely its work-item ID. Grant issue atomically verifies each work-item's
original project/organisation ownership.

Service enqueue requires the native `requestId` UUID. Service project
automation CAS requires `X-Factory-Request-Id` UUID; the existing human
CAS body remains backward compatible. Both mutations journal
`(grantId, action, requestId, bodyFingerprint)` with unique grant/action/
request identity. Any reused identity, including a different payload, is
**denied without native replay**; reconciliation is required.

## Durable admission, effect-start and revocation

1. In one DB transaction, validate grant/scope/expiry/revocation and append an
   `admitted` audit plus a 15-second *start-by* lease. A duplicate request
   records denial; it cannot silently start twice.
2. After all local request/body/project/work-item validation, immediately before
   native CAS or rule-evaluation commit, `beginEffect` uses one DB transaction
   to revalidate the grant version/expiry/revocation, lease, and PM handover
   evidence. It records `effect_started` before the irreversible operation.
3. Native Factory commits once. The lease settlement and outcome audit append
   atomically. Audit loss after native commit returns
   `503 {status:"EFFECT_UNVERIFIED", requestId}`, never an automatic retry.
4. A revoke blocks **new admissions and new effect starts** once its transaction
   commits. An effect whose `effect_started` transaction committed first
   may finish after revocation; no promise of retroactive cancellation.
   Unsettled leases remain durably queryable through the storage domain for
   independent operator reconciliation after restart. There is no poller,
   lease replayer or background scheduler in this component.

## Deliberately inert PM handover gate

`beginEffect` also requires a valid row in
`service_capability_handover_leases` for the exact org/project:

- owner is exactly `factory-project-manager` with a nonempty epoch;
- not revoked, not expired, issued before effect start;
- exact project `automationRevision` equals the attested revision;
- a 64-hex evidence digest binds an independently verified paused PM
  dispatcher, paused native automation and drained native sessions;
- timestamps for each pause/drain proof must precede lease issue.

**This draft does not implement any lease writer, provisioning route, token
issuer, PM database attestor or live adapter.** Its positive tests explicitly
insert a *synthetic* row into a disposable LibSQL DB. All real service
mutations fail closed without a future separately reviewed bridge that
collects/verifies durable pause/drain/ownership evidence and supplies these
rows. An automation CAS advances the revision and therefore invalidates its
previous handover lease until the bridge reattests the new state.

Independent acceptance must prove identity, exclusive lease source,
cross-process revocation races, manager/native dispatch ownership and
migration/restart/backup restoration before service actions may be enabled.

## Migration and rollback

The domain adds five isolated tables (grants, consents, append-only audit,
native-effect leases and PM handover attestations). Default-OFF Factory does
not register the domain. Enabled upgrades create tables alongside the
unchanged existing project/work-item data. Before deployment: back up the
Factory DB, verify migration and restore on an isolated copy, and retain
audit evidence. Rollback is first to **remove opt-in service configuration**;
do not drop tables or delete unresolved mutation evidence. This source slice
has been exercised against the frozen 0.25 API; portability to later Factory
releases is a separate gate.
