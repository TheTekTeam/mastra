import { describe, expect, it, vi } from 'vitest';
import {
  FACTORY_SKILL_NAMES,
  awaitInFlightFactorySandboxSetup,
  refreshRepositorySkillsForInvocation,
  trackFactorySandboxSetup,
} from './invocation-readiness.js';

describe('invocation-only repository skill readiness', () => {
  it('waits for the whole onStart checkout after the sandbox reports running', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sandbox = { ensureRunning: vi.fn(async () => {}) };
    const refresh = vi.fn(async () => {});
    const workspace = { sandbox, skills: { refresh } };
    const started = trackFactorySandboxSetup(sandbox as never, async () => { await gate; });
    const refreshPromise = refreshRepositorySkillsForInvocation(workspace as never);
    expect(awaitInFlightFactorySandboxSetup(workspace as never)).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    expect(sandbox.ensureRunning).not.toHaveBeenCalled();
    release();
    await started;
    await refreshPromise;
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('coalesces three concurrent explicit invocation refreshes into one startup and scan', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const sandbox = { ensureRunning: vi.fn(() => gate) };
    const refresh = vi.fn(async () => {});
    const workspace = { sandbox, skills: { refresh } };
    const attempts = Array.from({ length: 3 },
      () => refreshRepositorySkillsForInvocation(workspace as never));
    await Promise.resolve();
    expect(sandbox.ensureRunning).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    finish();
    await Promise.all(attempts);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('exposes a failed onStart and releases the old barrier on retry', async () => {
    const sandbox = { ensureRunning: vi.fn(async () => {}) };
    const refresh = vi.fn(async () => {});
    const workspace = { sandbox, skills: { refresh } };
    await expect(trackFactorySandboxSetup(sandbox as never, async () => {
      throw new Error('checkout_failed');
    })).rejects.toThrow('checkout_failed');
    expect(await awaitInFlightFactorySandboxSetup(workspace as never)).toBe(false);
    await refreshRepositorySkillsForInvocation(workspace as never);
    expect(sandbox.ensureRunning).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not start unrecognised provider or passive workspace without skill service', async () => {
    const start = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    await refreshRepositorySkillsForInvocation({ sandbox: { start }, skills: { refresh } } as never);
    await refreshRepositorySkillsForInvocation({ skills: { refresh } } as never);
    expect(start).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps authoritative bundled skill identities available to the fast path', () => {
    expect(FACTORY_SKILL_NAMES.has('factory-review')).toBe(true);
    expect(FACTORY_SKILL_NAMES.has('modelspend-implementation')).toBe(false);
  });
});
