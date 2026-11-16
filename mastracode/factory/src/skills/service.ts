import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { SendAgentSignalResult } from '@mastra/core/agent';
import type { AgentController } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';
import { formatSkillActivation } from '@mastra/core/workspace';
import type { Workspace } from '@mastra/core/workspace';

export interface SkillInvocationInput {
  resourceId: string;
  scope?: string;
  name: string;
  arguments?: string;
}

export interface SkillSession {
  getWorkspace(): Workspace;
  sendMessage(input: { content: string; requestContext?: RequestContext }): Promise<unknown>;
  sendNotificationSignal(
    input: {
      source: string;
      kind: string;
      summary: string;
      priority?: 'low' | 'medium' | 'high' | 'urgent';
      payload?: unknown;
      dedupeKey?: string;
      sourceId?: string;
    },
    options?: {
      ifActive?: { behavior?: 'deliver' | 'persist' };
      ifIdle?: { behavior?: 'persist' | 'wake' };
      requestContext?: RequestContext;
    },
  ): Promise<Pick<SendAgentSignalResult, 'persisted' | 'accepted'>>;
}

export class SkillInvocationError extends Error {
  readonly code: 'session_not_found' | 'skill_not_found';

  constructor(code: SkillInvocationError['code'], message: string) {
    super(message);
    this.name = 'SkillInvocationError';
    this.code = code;
  }
}

function escapeSkillBoundary(value: string): string {
  return value.replaceAll('</skill>', '&lt;/skill&gt;');
}

/**
 * Resolve a project-local skill only after its session checkout exists.
 *
 * Factory intentionally constructs the workspace lazily: before the sandbox
 * starts, project skill roots are deliberately reported as empty. A single
 * explicit skill invocation may therefore miss a valid project-local skill
 * while bundled Factory skills are already available. Materialise *only on
 * an explicit miss*, through the sandbox's coalesced ensureRunning lifecycle;
 * never start sandboxes on metadata/listing paths or use a plain start()
 * call that may bypass the provider's startup hooks. No native work item,
 * lease, scheduler, permission or project configuration is changed here.
 */
async function resolveInvocableSkill(session: SkillSession, name: string) {
  const workspace = session.getWorkspace();
  const skills = workspace.skills;
  await skills?.maybeRefresh();
  let skill = await skills?.get(name);
  if (!skill && skills) {
    // Factory's concrete session sandbox is a MastraSandbox. Other sandbox
    // providers and entirely absent sandboxes cannot be force-started.
    const sandbox = workspace.sandbox as
      | (typeof workspace.sandbox & { ensureRunning?: () => Promise<void> })
      | undefined;
    if (sandbox && typeof sandbox.ensureRunning === 'function') {
      await sandbox.ensureRunning();
      // The onStart hook schedules a best-effort rescan; join a fresh scan
      // here so the requested skill cannot race that background refresh.
      await skills.refresh();
      skill = await skills.get(name);
    }
  }
  if (!skill || skill['user-invocable'] === false) {
    throw new SkillInvocationError('skill_not_found', `Skill not found: ${name}.`);
  }
  return skill;
}

/** Kicks a run off from a plain prompt, for runs that activate no skill. */
export async function resolvePromptInvocation(
  controller: Pick<AgentController<MastraCodeState>, 'getSessionByResource'>,
  input: { resourceId: string; scope?: SkillInvocationInput['scope']; prompt: string },
): Promise<{ session: SkillSession; message: string }> {
  const session = (await controller.getSessionByResource(input.resourceId, input.scope)) as SkillSession | undefined;
  if (!session) throw new SkillInvocationError('session_not_found', 'Agent controller session not found.');
  return { session, message: input.prompt };
}

export async function resolveSkillInvocation(
  controller: Pick<AgentController<MastraCodeState>, 'getSessionByResource'>,
  input: SkillInvocationInput,
): Promise<{ session: SkillSession; skillName: string; message: string }> {
  const session = (await controller.getSessionByResource(input.resourceId, input.scope)) as SkillSession | undefined;
  if (!session) throw new SkillInvocationError('session_not_found', 'Agent controller session not found.');

  const skill = await resolveInvocableSkill(session, input.name);

  const args = input.arguments?.trim();
  const content = `${formatSkillActivation(skill)}${args ? `\n\nARGUMENTS: ${args}` : ''}`.trim();
  return {
    session,
    skillName: skill.name,
    message: `<skill name="${skill.name}">\n${escapeSkillBoundary(content)}\n</skill>`,
  };
}

/**
 * Same-stage re-entry: the skill is already active in the card's live session.
 * Resolve a compact continuation that references the skill by name and carries
 * only the fresh arguments, instead of re-pasting the whole skill document. If
 * the skill body was compacted out of context, the agent can re-open it with the
 * skill tool.
 */
export async function resolveSkillResumeInvocation(
  controller: Pick<AgentController<MastraCodeState>, 'getSessionByResource'>,
  input: SkillInvocationInput,
): Promise<{ session: SkillSession; skillName: string; message: string }> {
  const session = (await controller.getSessionByResource(input.resourceId, input.scope)) as SkillSession | undefined;
  if (!session) throw new SkillInvocationError('session_not_found', 'Agent controller session not found.');

  const skill = await resolveInvocableSkill(session, input.name);

  const args = input.arguments?.trim();
  const content = [
    `Resume the active ${skill.name} session — it is already open in this thread; continue it rather than restarting.`,
    `Re-open the ${skill.name} skill with the skill tool if its instructions are no longer in context.`,
    ...(args ? [`ARGUMENTS: ${args}`] : []),
  ].join('\n');
  return {
    session,
    skillName: skill.name,
    message: `<skill name="${skill.name}">\n${escapeSkillBoundary(content)}\n</skill>`,
  };
}

export async function dispatchSkillInvocation(
  controller: Pick<AgentController<MastraCodeState>, 'getSessionByResource'>,
  input: SkillInvocationInput,
  requestContext?: RequestContext,
): Promise<{ skillName: string; message: string }> {
  const resolved = await resolveSkillInvocation(controller, input);
  await resolved.session.sendMessage({ content: resolved.message, ...(requestContext ? { requestContext } : {}) });
  return { skillName: resolved.skillName, message: resolved.message };
}
