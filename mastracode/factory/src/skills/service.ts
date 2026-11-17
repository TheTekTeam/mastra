import type { MastraCodeState } from '@mastra/code-sdk/schema';
import type { SendAgentSignalResult } from '@mastra/core/agent';
import type { AgentController } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';
import { formatSkillActivation } from '@mastra/core/workspace';
import type { Workspace } from '@mastra/core/workspace';
import {
  awaitInFlightFactorySandboxSetup,
  FACTORY_SKILL_NAMES,
  refreshRepositorySkillsForInvocation,
} from './invocation-readiness.js';

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
 * Resolve a skill without letting a lazy project checkout masquerade as a
 * missing skill. Bundled Factory skills are intentionally never forced to
 * provision a project sandbox.
 */
async function resolveInvocableSkill(session: SkillSession, name: string) {
  const workspace = session.getWorkspace();
  const skills = workspace.skills;
  await skills?.maybeRefresh();
  let skill = await skills?.get(name);
  if (skill && !FACTORY_SKILL_NAMES.has(name) &&
      await awaitInFlightFactorySandboxSetup(workspace)) {
    // A cached repository skill may be stale during a replacement checkout.
    await skills?.refresh();
    skill = await skills?.get(name);
  }
  if (!skill && skills && !FACTORY_SKILL_NAMES.has(name)) {
    await refreshRepositorySkillsForInvocation(workspace);
    skill = await skills.get(name);
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
