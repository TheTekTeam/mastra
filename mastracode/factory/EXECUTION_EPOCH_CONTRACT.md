# Factory-native execution epoch storage — inert foundation

Tracking requirement: [Factory Project Manager #36](https://github.com/TheTekTeam/factory-project-manager/issues/36).

This source-only slice introduces three additive collections behind an **unregistered** Factory storage domain. The live Factory does not construct the domain or call these operations. It must remain inert until an independently reviewed Core pre-effect guard covers all stream, generate, resume, queued, durable, legacy, versioned, and recovery entrypoints.

The source code is not permission to adopt a project, enable service capabilities, grant authority, or hand over execution.

## Durable identity and epoch contract

The schema deliberately separates:

- **Project epoch**: exact organization and project, monotonic revision, state (\`native\` or \`quiescing\`), and \`fence_armed\`. Every row starts in \`native\` with revision **0**, \`fence_armed=false\`, coverage schema version **0**, mapping revision **0** and no mapping digest. There is **no production arming method** in this slice. A new thread binding increments the mapping revision and invalidates any previously armed coverage digest in the same transaction. Binding during quiescence is denied.
- **Execution scope**: immutable \`(resourceId,threadId)\` -> \`(orgId,projectId,sessionId)\` unique binding. A conflicting rebind fails. The binding must eventually come from authoritative Factory project/session storage, not user-supplied request context, resource headers, workspace paths, or model output. B1 does not create this mapping automatically.
- **Reservation**: exact org/project/session/resource/thread, native run ID, *unique attempt ID*, phase (\`start\` or \`resume\`), admitted epoch revision and durable state (\`reserved\`, \`running\`, \`suspended\`, \`unknown\`, \`settled\`). All except independently settled entries block quiescence.

The source operations intentionally require explicit registration by a future migration. An unarmed project refuses both \`reserveNative()\` and \`tryQuiesce()\`; no caller can create a handover with these default rows. Tests directly arm ephemeral fixture rows solely to exercise the transaction race.

Both admission and epoch quiescence run under the authoritative \`FactoryStorage.withTransaction()\` contract. **Every admitted native start/resume first writes and increments the SAME project epoch revision inside its reservation transaction**; quiescence uses an exact-revision update of that same row. This write contention is required to prevent PostgreSQL READ COMMITTED write skew (a reservation INSERT and a quiescence UPDATE otherwise can both commit). Quiescence only commits when no unsettled native reservations exist. Thus, once a complete Core execution guard eventually calls this service, a native start and handover-acquire race may have only one winner.

These columns alone **do not prove a project is drained**: B1 does not backfill historical sessions, capture active or parked runs, attach model/tool lifecycle settlement, or establish a trusted Project Manager writer. The \`quiescing\` state is intentionally not \`exclusive_pm\`. No lease row, handover activation, scheduling loop, session resume override or live native mutation is exposed.

## Future integration gates

1. Add Core admission to every execution path, including remote queued wake and durable recovery. Persistently verify the source thread and project against independent Factory records; missing or ambiguous project affiliation is **not** treated as personal.
2. Backfill, reconcile and attest the complete existing project/session/thread map before arming an epoch. Include interactive, side, Slack, subscription, dispatcher and Core API sessions.
3. An accepted Core hook must reserve **before** any irreversible model/tool/sandbox effect, attach completion to the actual run lifecycle (not merely the stream-handle return), and preserve crashes/uncertain/suspended work as blocking. No TTL-only clearance or automatic effect replay.
4. A separately reviewed authenticated owner-epoch/PM heartbeat, native automation CAS, stop-dispatch, operator consent, authoritative drain verification and restart proof must precede promoting a project to exclusive control.
5. Integrate the still-default-off service capability draft only after the Core and Factory gates pass, with exact organization/project/action grants and fresh \`beginEffect\` epoch checks.

## Acceptance and rollback

The focused tests exercise cross-organization identity rejection, immutable binding, replay rejection, admission/quiescence from **two real SQLite connections**, unknown state survival after restart, additive migration and restoring a pre-migration backup. PostgreSQL and LibSQL migration/restart evidence, mandatory package check/lint, full suite once, hosted exact-head CI, independent HP6 review and controlled HTAI pilot are required separately.

Rollback of this **unregistered** source addition is code-only. Once eventually registered, do not drop these tables as an ordinary rollback: retain reservations and unknown effects until an operator reconciles them. Keep old DB backups. This draft does not alter production schemas or data.
