import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FACTORY_GP_PG_REBIND_V3_CAPABILITY,
  FACTORY_GP_PG_REBIND_V3_FIELDS,
  inspectFactoryGpPgPostTombstoneV3,
} from './gp-pg-post-tombstone-v3.js';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const v = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map(k => JSON.stringify(k) + ':' + canonical(v[k]))
      .join(',') +
    '}'
  );
}
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now();
  const payload = {
    version: 'pm_gp_pg_post_tombstone_rebind_v3',
    audience: 'factory_pg_epoch_locked_rebind',
    phase: 'post_tombstone_rebind',
    keyId: 'pm-v3-test-pinned',
    challengeId: randomUUID(),
    factoryChallengeSha256: digest('factory-challenge'),
    issuedAtMs: now - 100,
    expiresAtMs: now + 4000,
    consentRequestId: randomUUID(),
    manifestId: digest('manifest'),
    projectId: randomUUID(),
    factoryOrgId: 'factory-private-org',
    repositoryId: 1412322534,
    repositoryOwnerId: 5189410,
    appInstallationId: 100027,
    policyDigest: digest('policy'),
    scopeDigest: digest('scope'),
    sourceProofDigest: digest('source'),
    authorityRevision: 7,
    ownerEpoch: 'factory-original-opaque-epoch',
    leaseIntentId: randomUUID(),
    scopeTupleSha256: digest('old-scope'),
    oldWriterOwnerId: randomUUID(),
    oldWriterEpoch: 7,
    newWriterOwnerId: randomUUID(),
    newWriterEpoch: 9,
    transitionChainSha256: digest('v11-complete-immutable-chain'),
    revokeRequestId: randomUUID(),
    factoryTombstoneSha256: digest('real-b1-tombstone'),
    rebindNonceSha256: digest('one-use-session-nonce'),
  };
  const signature = (p: unknown, domain = 'PM_TO_FACTORY_PRIVATE_GP_REBIND_V3\0') =>
    sign(null, Buffer.concat([Buffer.from(domain), Buffer.from(canonical(p))]), privateKey).toString('base64url');
  const packet = { alg: 'Ed25519', payload, signature: signature(payload) };
  const expected = Object.fromEntries(
    FACTORY_GP_PG_REBIND_V3_FIELDS.filter(
      k => !['version', 'audience', 'phase', 'keyId', 'issuedAtMs', 'expiresAtMs'].includes(k),
    ).map(k => [k, payload[k]]),
  ) as Parameters<typeof inspectFactoryGpPgPostTombstoneV3>[0]['expected'];
  const input = {
    packet,
    expected,
    pinnedKeyId: payload.keyId,
    pinnedPublicKey: publicKey,
    factoryDbNowMs: now,
    enabled: true,
  };
  return { payload, signature, packet, expected, input };
}
describe('source-only GP PG v3 post-tombstone signature inspection', () => {
  it('is unmounted and cannot grant Factory writes even for genuine Ed25519 bytes', () => {
    const f = fixture();
    expect(FACTORY_GP_PG_REBIND_V3_CAPABILITY).toMatchObject({
      installed: false,
      enabledByDefault: false,
      productionReady: false,
      b1NonceLedgerInstalled: false,
      authorizesFactoryWrites: false,
    });
    expect(inspectFactoryGpPgPostTombstoneV3({ ...f.input, enabled: false })).toBeNull();
    expect(inspectFactoryGpPgPostTombstoneV3(f.input)).toEqual({
      cryptographicallyVerified: true,
      authorizesFactoryWrites: false,
      requiresB1TombstoneAndReplayCas: true,
    });
    // A signature inspector has no durable nonce ledger. Repeating it is NOT
    // independent authority, and the real B1 consumer must still deny replay.
    expect(inspectFactoryGpPgPostTombstoneV3(f.input)?.authorizesFactoryWrites).toBe(false);
  });
  it('rejects a v2 domain signature, foreign key, and altered signature', () => {
    const f = fixture();
    const v2 = { ...f.packet, signature: f.signature(f.payload, 'PM_TO_FACTORY_PRIVATE_GP_AUTHORITY_V1\0') };
    expect(inspectFactoryGpPgPostTombstoneV3({ ...f.input, packet: v2 })).toBeNull();
    const { publicKey: otherKey } = generateKeyPairSync('ed25519');
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        pinnedPublicKey: otherKey,
      }),
    ).toBeNull();
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        packet: { ...f.packet, signature: 'A' + f.packet.signature.slice(1) },
      }),
    ).toBeNull();
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        pinnedKeyId: 'caller-key',
      }),
    ).toBeNull();
  });
  it('requires exact object shape and fresh bounded Factory database time', () => {
    const f = fixture();
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        packet: { ...f.packet, trusted: true },
      }),
    ).toBeNull();
    const forgedExpected = { ...f.expected, claimedWriterEpoch: 999 };
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        expected: forgedExpected,
      }),
    ).toBeNull();
    let untrustedGetterReads = 0;
    const accessorPayload = Object.defineProperty({ ...f.payload }, 'projectId', {
      enumerable: true,
      get() {
        untrustedGetterReads++;
        return f.payload.projectId;
      },
    });
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        packet: { ...f.packet, payload: accessorPayload },
      }),
    ).toBeNull();
    expect(untrustedGetterReads).toBe(0);
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        factoryDbNowMs: Number(f.payload.expiresAtMs),
      }),
    ).toBeNull();
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        factoryDbNowMs: Number(f.payload.issuedAtMs) - 1,
      }),
    ).toBeNull();
    const extended = { ...f.payload, expiresAtMs: Number(f.payload.issuedAtMs) + 5001 };
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        packet: { ...f.packet, payload: extended, signature: f.signature(extended) },
      }),
    ).toBeNull();
    const wrongEpoch = { ...f.payload, newWriterEpoch: f.payload.oldWriterEpoch };
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        packet: { ...f.packet, payload: wrongEpoch, signature: f.signature(wrongEpoch) },
      }),
    ).toBeNull();
  });
  it.each(
    FACTORY_GP_PG_REBIND_V3_FIELDS.filter(
      k => !['version', 'audience', 'phase', 'keyId', 'issuedAtMs', 'expiresAtMs'].includes(k),
    ),
  )('denies independently signed wrong %s instead of trusting body', key => {
    const f = fixture();
    const value = f.payload[key];
    const mutated = {
      ...f.payload,
      [key]: typeof value === 'number' ? value + 1 : typeof value === 'string' ? value + '-foreign' : null,
    };
    const signed = { ...f.packet, payload: mutated, signature: f.signature(mutated) };
    expect(
      inspectFactoryGpPgPostTombstoneV3({
        ...f.input,
        packet: signed,
      }),
    ).toBeNull();
  });
});
