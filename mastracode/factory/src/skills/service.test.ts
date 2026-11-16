import { describe, expect, it, vi } from 'vitest';
import { resolveSkillInvocation, resolveSkillResumeInvocation, SkillInvocationError } from './service.js';
import { trackFactorySandboxSetup } from './invocation-readiness.js';

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


describe('project-local skill discovery after lazy sandbox materialisation', () => {
  const input = { resourceId: 'card-1', name: 'modelspend-implementation' };
  const projectSkill = {
    name: input.name,
    instructions: 'Use the reviewed project-local implementation protocol.',
  };

  function lazySession(options?: { startError?: Error; hidden?: boolean }) {
    let materialized = false;
    const ensureRunning = vi.fn(async () => {
      if (options?.startError) throw options.startError;
      materialized = true;
    });
    const refresh = vi.fn(async () => {});
    const maybeRefresh = vi.fn(async () => {});
    const get = vi.fn(async () =>
      materialized
        ? { ...projectSkill, ...(options?.hidden ? { 'user-invocable': false } : {}) }
        : undefined,
    );
    const session = {
      getWorkspace: () => ({
        sandbox: { ensureRunning },
        skills: { get, refresh, maybeRefresh },
      }),
      sendMessage: vi.fn(async () => {}),
    };
    return { session, ensureRunning, refresh, maybeRefresh, get };
  }

  it('resolves a project skill on first explicit invocation without a false missing-skill response', async () => {
    const fixture = lazySession();
    const result = await resolveSkillInvocation(makeController({ session: fixture.session }), input);
    expect(result.skillName).toBe(input.name);
    expect(result.message).toContain('Use the reviewed project-local implementation protocol.');
    expect(fixture.ensureRunning).toHaveBeenCalledTimes(1);
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.get).toHaveBeenCalledTimes(2);
  });

  it('resolves a project skill on a same-stage resume after a lazy start', async () => {
    const fixture = lazySession();
    const result = await resolveSkillResumeInvocation(makeController({ session: fixture.session }), input);
    expect(result.skillName).toBe(input.name);
    expect(result.message).toContain('Resume the active modelspend-implementation session');
    expect(fixture.ensureRunning).toHaveBeenCalledTimes(1);
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
  });

  it('does not materialise for a bundled skill that was already available', async () => {
    const ensureRunning = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const session = {
      getWorkspace: () => ({
        sandbox: { ensureRunning },
        skills: {
          maybeRefresh: vi.fn(async () => {}),
          refresh,
          get: vi.fn(async () => ({ name: 'factory-review', instructions: SKILL_INSTRUCTIONS })),
        },
      }),
    };
    await resolveSkillInvocation(makeController({ session }), { resourceId: 'card-1', name: 'factory-review' });
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('fails closed rather than claiming a missing skill on sandbox start failure', async () => {
    const fixture = lazySession({ startError: new Error('checkout_not_ready') });
    await expect(resolveSkillInvocation(makeController({ session: fixture.session }), input)).rejects.toThrow(
      'checkout_not_ready',
    );
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it('does not allow hidden project skills after materialisation', async () => {
    const fixture = lazySession({ hidden: true });
    await expect(resolveSkillInvocation(makeController({ session: fixture.session }), input)).rejects.toMatchObject({
      code: 'skill_not_found',
    });
    expect(fixture.ensureRunning).toHaveBeenCalledTimes(1);
  });

  it('does not start a provider without an explicit ensureRunning lifecycle', async () => {
    const get = vi.fn(async () => undefined);
    const session = { getWorkspace: () => ({
      sandbox: { start: vi.fn() },
      skills: { maybeRefresh: vi.fn(async () => {}), get, refresh: vi.fn() },
    }) };
    await expect(resolveSkillInvocation(makeController({ session }), input)).rejects.toMatchObject({
      code: 'skill_not_found',
    });
    expect(session.getWorkspace().sandbox.start).not.toHaveBeenCalled();
  });
});


describe('checkout setup generation safeguards for explicit skill invocation', () => {
  const input = { resourceId: 'card-1', name: 'modelspend-implementation' };

  it('blocks use of a cached project skill until onStart has finished and rescanned it', async () => {
    let release!: () => void;
    const setupGate = new Promise<void>(resolve => { release = resolve; });
    const sandbox = { ensureRunning: vi.fn(async () => {}) };
    let instructions = 'stale-worktree-instructions';
    const refresh = vi.fn(async () => { instructions = 'fresh-checkout-instructions'; });
    const get = vi.fn(async () => ({ name: input.name, instructions }));
    const workspace = { sandbox, skills: { refresh, get, maybeRefresh: vi.fn(async () => {}) } };
    const session = { getWorkspace: () => workspace };
    const started = trackFactorySandboxSetup(sandbox as never, async () => { await setupGate; });
    const pending = resolveSkillInvocation(makeController({ session }), input);
    let complete = false;
    void pending.then(() => { complete = true; }, () => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    release();
    await started;
    const result = await pending;
    expect(result.message).toContain('fresh-checkout-instructions');
    expect(result.message).not.toContain('stale-worktree-instructions');
    expect(sandbox.ensureRunning).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('shares one scan across concurrent missing project skills', async () => {
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    let available = false;
    const sandbox = { ensureRunning: vi.fn(async () => { await started; available = true; }) };
    const refresh = vi.fn(async () => {});
    const skills = {
      maybeRefresh: vi.fn(async () => {}),
      get: vi.fn(async () =>
        available ? { name: input.name, instructions: 'verified-project-skill' } : undefined),
      refresh,
    };
    const session = { getWorkspace: () => ({ sandbox, skills }) };
    const results = Array.from({ length: 3 },
      () => resolveSkillInvocation(makeController({ session }), input));
    await Promise.resolve();
    release();
    const resolved = await Promise.all(results);
    expect(resolved.every(r => r.message.includes('verified-project-skill'))).toBe(true);
    expect(sandbox.ensureRunning).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
