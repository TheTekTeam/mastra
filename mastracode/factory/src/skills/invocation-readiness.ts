import type { Workspace, WorkspaceSandbox } from '@mastra/core/workspace';

/** Immutable names that use the reviewed bundled Factory-skill source. */
export const FACTORY_SKILL_NAMES = new Set([
  'configure-factory-rules',
  'factory-complete-issue',
  'factory-gitlab-rereview',
  'factory-gitlab-review',
  'factory-plan',
  'factory-rereview',
  'factory-review',
  'factory-triage',
]);

/** Checkout hooks are in flight even after a sandbox reports "running". */
const pendingCheckouts = new WeakMap<WorkspaceSandbox, Promise<void>>();
/** Concurrent explicit invocations share one scan per concrete skill catalogue. */
const pendingSkillRefreshes = new WeakMap<object, Promise<void>>();

/** Attached only by the Factory workspace's existing trusted onStart hook. */
export async function trackFactorySandboxSetup(
  sandbox: WorkspaceSandbox,
  setup: () => Promise<void>,
): Promise<void> {
  // Register before executing setup: a concurrent invocation that sees
  // sandbox.status === "running" must still wait for complete checkout,
  // credential setup, and preceding onStart callbacks.
  const pending = Promise.resolve().then(setup);
  pendingCheckouts.set(sandbox, pending);
  try {
    await pending;
  } finally {
    if (pendingCheckouts.get(sandbox) === pending) pendingCheckouts.delete(sandbox);
  }
}

/** True only when a checkout was actually in flight at this lookup. */
export async function awaitInFlightFactorySandboxSetup(workspace: Workspace): Promise<boolean> {
  const task = workspace.sandbox && pendingCheckouts.get(workspace.sandbox);
  if (!task) return false;
  await task;
  return true;
}

/**
 * Called only from an already authorised skill invocation, never from passive
 * project listing or workspace metadata. Unknown providers are not started.
 * A single-flight refresh prevents N identical skill resolutions from
 * provisioning or scanning the same sandbox N times.
 */
export async function refreshRepositorySkillsForInvocation(workspace: Workspace): Promise<void> {
  const { sandbox, skills } = workspace;
  if (!sandbox || !skills) return;
  const executor = sandbox as WorkspaceSandbox & { ensureRunning?: () => Promise<void> };
  if (typeof executor.ensureRunning !== 'function') return;

  const existing = pendingSkillRefreshes.get(skills);
  if (existing) return existing;

  const pending = (async () => {
    const before = pendingCheckouts.get(sandbox);
    if (before) {
      // ensureRunning() itself may return while status is "running" but
      // before the onStart hook's promise has completed.
      await before;
    } else {
      // The concrete Factory session sandbox owns coalesced lazy materialisation.
      await executor.ensureRunning!();
    }
    const after = pendingCheckouts.get(sandbox);
    if (after) await after;
    await skills.refresh();
  })();
  pendingSkillRefreshes.set(skills, pending);
  try {
    await pending;
  } finally {
    if (pendingSkillRefreshes.get(skills) === pending) pendingSkillRefreshes.delete(skills);
  }
}
