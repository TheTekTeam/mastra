import { describe, expect, it } from 'vitest';

import {
  FACTORY_CORE_REQUIRED_EFFECT_PATHS,
  inspectInertCoreFence,
  runWithInertCoreFence,
} from './pre-effect-capability.js';

describe('A2 default-off all-path admission capability (PM #36)', () => {
  it('cannot self-certify handover even when caller claims every prerequisite', () => {
    const purported = {
      protocolVersion: 1, backend: 'postgres', originVersion: 1, reservationVersion: 1,
      coveredPaths: [...FACTORY_CORE_REQUIRED_EFFECT_PATHS],
      ownerRevisionAttested: true, lockOrderAttested: true,
      settlementVerifierAttested: true, managerLeaseAttested: true,
      unsupportedProviderDenialAttested: true, adoptionReady: true,
    };
    expect(inspectInertCoreFence(purported)).toMatchObject({
      adoptionReady: false, nativeExecutionAdmissionInstalled: false,
    });
    expect(inspectInertCoreFence({ ...purported, backend: 'remote' }).adoptionReady).toBe(false);
    expect(Object.isFrozen(inspectInertCoreFence())).toBe(true);
  });

  it('cannot invoke a native model/tool effect from any claimed Core path', async () => {
    for (const path of FACTORY_CORE_REQUIRED_EFFECT_PATHS) {
      let called = false;
      await expect(runWithInertCoreFence({ path, trusted: true, managed: true }, async () => {
        called = true;
      })).rejects.toThrow(/CORE_EPOCH_FENCE_NOT_READY/);
      expect(called, path).toBe(false);
    }
  });

  it('denies legacy/resume/unknown and forged caller contexts identically', async () => {
    for (const claim of [null, {}, { projectId: 'hti', ownerEpoch: 'guessed' },
      { path: 'agent.resume.durable', serverTrusted: true },
      { path: 'unregistered-bypass', classifiedAs: 'personal' }]) {
      await expect(runWithInertCoreFence(claim, async () => 'effect')).rejects
        .toThrow(/CORE_EPOCH_FENCE_NOT_READY/);
    }
  });
});
