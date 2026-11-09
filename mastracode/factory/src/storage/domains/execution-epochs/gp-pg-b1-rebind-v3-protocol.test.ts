import { describe, expect, it } from 'vitest';
import {
  FACTORY_GP_PG_B1_V3_CAPABILITY,
  canonicalV3AuthenticatedTombstoneDigest,
  canonicalV3RebindNonceKey,
} from './gp-pg-b1-rebind-v3-protocol';

const id = (digit: string) =>
  digit.repeat(8) + '-' + digit.repeat(4) + '-' + digit.repeat(4) + '-' + digit.repeat(4) + '-' + digit.repeat(12);
const baseTombstone = () => ({
  version: 'factory_gp_pg_b1_authenticated_revoke_v3',
  orgId: 'org-valid',
  projectId: id('1'),
  leaseIntentId: id('2'),
  oldWriterOwnerId: id('3'),
  ownerEpoch: 'epoch-17',
  revokeRequestId: id('4'),
  originalRevocationRowId: id('5'),
  pgCommittedAtMs: 1762704000000,
  pgEpochRevision: 17,
});
const baseNonce = () => ({
  version: 'factory_gp_pg_b1_rebind_nonce_v3',
  orgId: 'org-valid',
  projectId: id('1'),
  leaseIntentId: id('2'),
  challengeId: id('6'),
  factoryChallengeSha256: 'a'.repeat(64),
  rebindNonceSha256: 'b'.repeat(64),
  factoryTombstoneSha256: 'c'.repeat(64),
  oldWriterOwnerId: id('3'),
  oldWriterEpoch: 17,
  newWriterOwnerId: id('7'),
  newWriterEpoch: 18,
  transitionChainSha256: 'd'.repeat(64),
});
describe('source-only GP B1 V3 canonical tombstone protocol', () => {
  it('refuses any runtime authority, DB writer, migration or replay CAS claim', () => {
    expect(FACTORY_GP_PG_B1_V3_CAPABILITY).toEqual({
      installed: false,
      enabledByDefault: false,
      productionReady: false,
      pgTombstoneWriterInstalled: false,
      replayCasInstalled: false,
      authorizesFactoryWrites: false,
    });
    expect(Object.isFrozen(FACTORY_GP_PG_B1_V3_CAPABILITY)).toBe(true);
  });
  it('hashes the complete tuple independent of own-key order', () => {
    const t = baseTombstone();
    const reverse = Object.fromEntries(Object.entries(t).reverse());
    expect(canonicalV3AuthenticatedTombstoneDigest(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalV3AuthenticatedTombstoneDigest(reverse)).toEqual(canonicalV3AuthenticatedTombstoneDigest(t));
  });
  it.each([
    ['revoke request', { revokeRequestId: id('9') }],
    ['native row ID', { originalRevocationRowId: id('9') }],
    ['PG commit clock', { pgCommittedAtMs: 1762704000001 }],
    ['PG epoch revision', { pgEpochRevision: 18 }],
    ['original writer', { oldWriterOwnerId: id('9') }],
    ['original epoch', { ownerEpoch: 'epoch-18' }],
    ['lease intent', { leaseIntentId: id('9') }],
    ['project', { projectId: id('9') }],
    ['org', { orgId: 'different-org' }],
  ])('distinguishes %s under canonical digest', (_, diff) => {
    expect(canonicalV3AuthenticatedTombstoneDigest({ ...baseTombstone(), ...diff })).not.toEqual(
      canonicalV3AuthenticatedTombstoneDigest(baseTombstone()),
    );
  });
  it.each([
    [
      'missing native row',
      (t: Record<string, unknown>) => {
        delete t.originalRevocationRowId;
      },
    ],
    [
      'extra caller claim',
      (t: Record<string, unknown>) => {
        t.callerAuthenticated = true;
      },
    ],
    [
      'malformed revoke ID',
      (t: Record<string, unknown>) => {
        t.revokeRequestId = 'caller-value';
      },
    ],
    [
      'nonpositive revision',
      (t: Record<string, unknown>) => {
        t.pgEpochRevision = 0;
      },
    ],
    [
      'float PG clock',
      (t: Record<string, unknown>) => {
        t.pgCommittedAtMs = 1.2;
      },
    ],
    [
      'wrong version',
      (t: Record<string, unknown>) => {
        t.version = 'v2';
      },
    ],
    [
      'undefined field',
      (t: Record<string, unknown>) => {
        t.orgId = undefined;
      },
    ],
    [
      'accessor',
      (t: Record<string, unknown>) => {
        Object.defineProperty(t, 'orgId', {
          get() {
            throw Error('unsafe getter');
          },
        });
      },
    ],
  ])('rejects incomplete or unsafe tuple: %s', (_, mutate) => {
    const t: Record<string, unknown> = baseTombstone();
    mutate(t);
    expect(canonicalV3AuthenticatedTombstoneDigest(t)).toBeNull();
  });
  it('rejects inherited prototype semantics', () => {
    expect(canonicalV3AuthenticatedTombstoneDigest(Object.create(baseTombstone()))).toBeNull();
  });
  it('rejects hidden caller properties and symbols', () => {
    const hidden = baseTombstone();
    Object.defineProperty(hidden, 'trusted', { value: true, enumerable: false });
    expect(canonicalV3AuthenticatedTombstoneDigest(hidden)).toBeNull();
    const symbolled = baseNonce();
    Object.defineProperty(symbolled, Symbol('trusted'), { value: true });
    expect(canonicalV3RebindNonceKey(symbolled)).toBeNull();
  });
});
describe('source-only GP B1 V3 nonce uniqueness key', () => {
  it('derives stable domain-separated key; never consumes a nonce', () => {
    const n = baseNonce();
    const first = canonicalV3RebindNonceKey(n);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalV3RebindNonceKey(n)).toBe(first);
    expect(first).not.toBe(canonicalV3AuthenticatedTombstoneDigest(baseTombstone()));
    expect(canonicalV3RebindNonceKey(Object.fromEntries(Object.entries(n).reverse()))).toBe(first);
  });
  it.each([
    ['one-use challenge', { challengeId: id('8') }],
    ['nonce', { rebindNonceSha256: 'e'.repeat(64) }],
    ['challenge digest', { factoryChallengeSha256: 'e'.repeat(64) }],
    ['tombstone hash', { factoryTombstoneSha256: 'e'.repeat(64) }],
    ['transition proof', { transitionChainSha256: 'e'.repeat(64) }],
    ['new epoch', { newWriterEpoch: 19 }],
    ['new writer', { newWriterOwnerId: id('8') }],
    ['old epoch', { oldWriterEpoch: 16 }],
  ])('makes a separate key for %s', (_, diff) => {
    expect(canonicalV3RebindNonceKey({ ...baseNonce(), ...diff })).not.toBe(canonicalV3RebindNonceKey(baseNonce()));
  });
  it.each([
    ['same writer epoch', { newWriterEpoch: 17 }],
    ['rollback epoch', { newWriterEpoch: 16 }],
    ['negative old epoch', { oldWriterEpoch: -1 }],
    ['unbound challenge', { challengeId: 'not-a-uuid' }],
    ['bad digest', { rebindNonceSha256: 'not-a-hash' }],
    ['V2 downgrade', { version: 'pm_gp_pg_rebind_v2' }],
    ['caller extra claim', { trusted: true }],
  ])('rejects nonce tuple: %s', (_, diff) => {
    expect(canonicalV3RebindNonceKey({ ...baseNonce(), ...diff })).toBeNull();
  });
  it('refuses getter side effects in nonce tuple', () => {
    const n = baseNonce();
    Object.defineProperty(n, 'challengeId', {
      get() {
        throw Error('should not call');
      },
    });
    expect(canonicalV3RebindNonceKey(n)).toBeNull();
  });
});
