import { describe, expect, it, vi } from 'vitest';
import { resolveSkillInvocation, resolveSkillResumeInvocation, SkillInvocationError } from './service.js';

const SKILL_INSTRUCTIONS = 'Follow the entire factory-review protocol in extensive detail.';

function makeController(options?: { skill?: unknown; session?: unknown }) {
  const skill =
    options && 'skill' in options ? options.skill : { name: 'factory-review', instructions: SKILL_INSTRUCTIONS };
  const session =
    options && 'session' in options
      ? options.session
      : {
          getWorkspace: () => ({
            skills: {
              maybeRefresh: vi.fn(async () => {}),
              get: vi.fn(async () => skill),
            },
          }),
          sendMessage: vi.fn(async () => {}),
        };
  return {
    getSessionByResource: vi.fn(async () => session as never),
  };
}

describe('resolveSkillResumeInvocation', () => {
  const input = { resourceId: 'card-1', name: 'factory-review', arguments: 'PR https://example/pull/7' };

  it('references the skill by name and carries the arguments without the full body', async () => {
    const resolved = await resolveSkillResumeInvocation(makeController(), input);
    expect(resolved.skillName).toBe('factory-review');
    expect(resolved.message).toContain('<skill name="factory-review">');
    expect(resolved.message).toContain('Resume the active factory-review session');
    expect(resolved.message).toContain('Re-open the factory-review skill with the skill tool');
    expect(resolved.message).toContain('ARGUMENTS: PR https://example/pull/7');
    // The whole point: the ~18KB skill body is NOT re-pasted on resume.
    expect(resolved.message).not.toContain(SKILL_INSTRUCTIONS);
  });

  it('omits the ARGUMENTS line when there are no fresh arguments', async () => {
    const resolved = await resolveSkillResumeInvocation(makeController(), {
      resourceId: 'card-1',
      name: 'factory-review',
    });
    expect(resolved.message).not.toContain('ARGUMENTS:');
  });

  it('does not embed the full skill body that the eager invocation pastes', async () => {
    const full = await resolveSkillInvocation(makeController(), input);
    const resume = await resolveSkillResumeInvocation(makeController(), input);
    expect(full.message).toContain(SKILL_INSTRUCTIONS);
    expect(resume.message).not.toContain(SKILL_INSTRUCTIONS);
  });

  it('throws skill_not_found for an unknown or non-user-invocable skill', async () => {
    await expect(resolveSkillResumeInvocation(makeController({ skill: undefined }), input)).rejects.toMatchObject({
      code: 'skill_not_found',
    });
    await expect(
      resolveSkillResumeInvocation(
        makeController({ skill: { name: 'factory-review', 'user-invocable': false } }),
        input,
      ),
    ).rejects.toBeInstanceOf(SkillInvocationError);
  });

  it('throws session_not_found when the resource has no session', async () => {
    await expect(resolveSkillResumeInvocation(makeController({ session: undefined }), input)).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });
});

describe('repository-local skills before sandbox materialization', () => {
  const input = { resourceId: 'card-1', name: 'repo-skill', arguments: 'issue=3' };
  const repoSkill = { name: 'repo-skill', instructions: 'Repository-local fixture skill.' };

  function lazySession(options: { status: string; materializes: boolean }) {
    let materialized = options.status === 'running';
    const sandbox = {
      status: options.status,
      start: vi.fn(async () => {
        sandbox.status = 'running';
        materialized = options.materializes;
      }),
    };
    const skills = {
      maybeRefresh: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      get: vi.fn(async (name: string) => (materialized && name === repoSkill.name ? repoSkill : null)),
    };
    const session = { getWorkspace: () => ({ skills, sandbox }), sendMessage: vi.fn(async () => {}) };
    return { controller: { getSessionByResource: vi.fn(async () => session as never) }, sandbox, skills };
  }

  it.each([
    ['fresh', resolveSkillInvocation],
    ['resume', resolveSkillResumeInvocation],
  ] as const)('starts the unmaterialized sandbox and finds the skill (%s)', async (_label, resolve) => {
    const { controller, sandbox, skills } = lazySession({ status: 'stopped', materializes: true });
    const resolved = await resolve(controller, input);
    expect(resolved.skillName).toBe('repo-skill');
    expect(sandbox.start).toHaveBeenCalledTimes(1);
    expect(skills.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not start an already-running sandbox and still fails closed', async () => {
    const { controller, sandbox } = lazySession({ status: 'running', materializes: false });
    await expect(resolveSkillInvocation(controller, { ...input, name: 'missing' })).rejects.toMatchObject({
      code: 'skill_not_found',
    });
    expect(sandbox.start).not.toHaveBeenCalled();
  });

  it('fails closed when the skill is absent after materialization', async () => {
    const { controller, sandbox } = lazySession({ status: 'stopped', materializes: false });
    await expect(resolveSkillInvocation(controller, input)).rejects.toMatchObject({ code: 'skill_not_found' });
    expect(sandbox.start).toHaveBeenCalledTimes(1);
  });
});
