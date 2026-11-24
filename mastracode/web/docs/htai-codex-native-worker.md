# HTAI Factory-native Codex CLI worker (zero additional API spend)

The Mastra Factory 0.25 native deferred-decision dispatcher already owns the
claim, role, work-item and renewable lease. This change adds an optional
externalSkillExecutor invoked only after that lease is claimed and the normal
consent gate is passed. When disabled, existing behavior is unchanged.

When FACTORY_HTAI_CODEX_WORKER_ENABLED=true:
- Native HTAI invokeSkill decisions are intercepted; only work role with an
  authenticated Factory work item linked to TheTekTeam/HTAI GitHub issues is
  eligible. Unsupported HTAI requests fail closed without model fallback.
- Other projects retain the existing Factory dispatch route.
- HTAI native pending starts and model-waking messages are denied, including
  stage-transition messages. This prevents the separate Factory model session
  path from bypassing the subscription-only worker.
- HTAI callback queues locally and the executable enforces a nonblocking
  single-process host lock. Factory remains sole task scheduler and claimant.
- A clean, pinned HTAI worktree is provisioned from origin/main. The on-host
  Factory callback signs an expiring five-minute claim and invokes the installed
  subscriber-only Python Codex worker.
- The Codex worker refuses API-key authentication, removes paid API credentials
  from its child environment, uses workspace-write sandbox and a one-hour
  timeout, and does not push, merge, deploy or close an issue.
- Worker process exit zero is NOT project, issue, PR, acceptance or deployment
  completion. Those require separate Factory lifecycle evidence. Ambiguous
  results never trigger a blind retry.

The Codex process wrapper lives in
TheTekTeam/Mastra-Factory-MCP-OAI PR #34 and is currently installed as
/home/gp/.local/libexec/factory-htai-codex-cli-worker.py.

Activation requires all of the following:
1. A **qualified Factory 0.25 release** containing this patch, reconciled with
   the actual live release (the current source is not identical to this
   repository's base; do not overwrite it blindly).
2. The on-host native issuer at
   /home/gp/.config/factory-codex-htai/native-issuer.key (owner private 0600)
   generated locally and never logged or committed.
3. A controlled systemd environment flag
   FACTORY_HTAI_CODEX_WORKER_ENABLED=true and a qualified release restart.
4. Confirmation from the existing Manager that HTAI Auto Run and Auto Approve
   remain false; native work is explicitly admitted one item at a time.
5. Exact Factory native decision readback and a verified successful sample
   HTAI work task. No independent polling scheduler is permitted.

This source patch is not a deployment receipt. Do not activate a blanket
Factory Auto Run setting or use the Astra/API-key model in its place.
