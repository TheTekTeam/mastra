import { verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Source-only V3 reader for the separate PM writer-epoch recovery protocol.
 * Nothing imports/registers it at runtime; even a verified signature conveys
 * NO Factory write authority. PG tombstone/nonce CAS are intentionally absent.
 */
export const FACTORY_GP_PG_REBIND_V3_CAPABILITY = Object.freeze({
  installed: false,
  enabledByDefault: false,
  productionReady: false,
  acceptsCallerAuthority: false,
  b1NonceLedgerInstalled: false,
  authorizesFactoryWrites: false,
});

export const FACTORY_GP_PG_REBIND_V3_FIELDS = Object.freeze([
  'version',
  'audience',
  'phase',
  'keyId',
  'challengeId',
  'factoryChallengeSha256',
  'issuedAtMs',
  'expiresAtMs',
  'consentRequestId',
  'manifestId',
  'projectId',
  'factoryOrgId',
  'repositoryId',
  'repositoryOwnerId',
  'appInstallationId',
  'policyDigest',
  'scopeDigest',
  'sourceProofDigest',
  'authorityRevision',
  'ownerEpoch',
  'leaseIntentId',
  'scopeTupleSha256',
  'oldWriterOwnerId',
  'oldWriterEpoch',
  'newWriterOwnerId',
  'newWriterEpoch',
  'transitionChainSha256',
  'revokeRequestId',
  'factoryTombstoneSha256',
  'rebindNonceSha256',
] as const);
type Field = (typeof FACTORY_GP_PG_REBIND_V3_FIELDS)[number];
type UnboundField = 'version' | 'audience' | 'phase' | 'keyId' | 'issuedAtMs' | 'expiresAtMs';
type BoundField = Exclude<Field, UnboundField>;
type V3 = Record<Field, unknown>;
const DOMAIN = Buffer.from('PM_TO_FACTORY_PRIVATE_GP_REBIND_V3\0');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const uuid = (x: unknown): x is string => typeof x === 'string' && UUID.test(x);
const hex = (x: unknown): x is string => typeof x === 'string' && HEX.test(x);
const own = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x: unknown, fields: readonly string[]): x is Record<string, unknown> =>
  own(x) && Object.keys(x).length === fields.length && Object.keys(x).every(key => fields.includes(key));
const dataOnly = (x: unknown, fields: readonly string[]): x is Record<string, unknown> =>
  exact(x, fields) &&
  fields.every(key => {
    const d = Object.getOwnPropertyDescriptor(x, key);
    return !!d && 'value' in d;
  });
const BOUND_FIELDS = FACTORY_GP_PG_REBIND_V3_FIELDS.filter(
  key => !['version', 'audience', 'phase', 'keyId', 'issuedAtMs', 'expiresAtMs'].includes(key),
) as BoundField[];
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0;
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!own(value)) throw new Error('GP_REBIND_V3_NONCANONICAL');
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('GP_REBIND_V3_ACCESSOR');
  }
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function shape(p: V3, now: number): boolean {
  return (
    p.version === 'pm_gp_pg_post_tombstone_rebind_v3' &&
    p.audience === 'factory_pg_epoch_locked_rebind' &&
    p.phase === 'post_tombstone_rebind' &&
    KEY.test(String(p.keyId ?? '')) &&
    uuid(p.challengeId) &&
    uuid(p.consentRequestId) &&
    uuid(p.projectId) &&
    uuid(p.leaseIntentId) &&
    uuid(p.oldWriterOwnerId) &&
    uuid(p.newWriterOwnerId) &&
    uuid(p.revokeRequestId) &&
    hex(p.manifestId) &&
    [
      p.factoryChallengeSha256,
      p.policyDigest,
      p.scopeDigest,
      p.sourceProofDigest,
      p.scopeTupleSha256,
      p.transitionChainSha256,
      p.factoryTombstoneSha256,
      p.rebindNonceSha256,
    ].every(value => typeof value === 'string' && HEX.test(value)) &&
    typeof p.factoryOrgId === 'string' &&
    p.factoryOrgId.length > 0 &&
    typeof p.ownerEpoch === 'string' &&
    p.ownerEpoch.length > 0 &&
    [
      p.repositoryId,
      p.repositoryOwnerId,
      p.appInstallationId,
      p.authorityRevision,
      p.oldWriterEpoch,
      p.newWriterEpoch,
    ].every(positive) &&
    Number(p.newWriterEpoch) > Number(p.oldWriterEpoch) &&
    positive(p.issuedAtMs) &&
    positive(p.expiresAtMs) &&
    Number(p.issuedAtMs) <= now &&
    now < Number(p.expiresAtMs) &&
    Number(p.expiresAtMs) - Number(p.issuedAtMs) <= 5000
  );
}

/** Expected values MUST eventually be independently read under Factory's B1 PG
 * epoch lock from native original scope, actual revocation tombstone, and
 * current PM transition chain. This source prototype does NOT provide those
 * reads and therefore cannot issue a native-authorization acknowledgement. */
export type FactoryGpPgRebindV3Expected = Readonly<
  Omit<V3, 'version' | 'audience' | 'phase' | 'keyId' | 'issuedAtMs' | 'expiresAtMs'>
>;
export interface InspectFactoryGpPgRebindV3 {
  packet: unknown;
  enabled?: boolean;
  pinnedKeyId: string;
  pinnedPublicKey: KeyObject;
  expected: FactoryGpPgRebindV3Expected;
  factoryDbNowMs: number;
}
export function inspectFactoryGpPgPostTombstoneV3({
  packet,
  enabled = false,
  pinnedKeyId,
  pinnedPublicKey,
  expected,
  factoryDbNowMs,
}: InspectFactoryGpPgRebindV3): Readonly<{
  cryptographicallyVerified: true;
  authorizesFactoryWrites: false;
  requiresB1TombstoneAndReplayCas: true;
}> | null {
  // Source-level off switch is not a runtime deployment/config flag.
  if (
    !enabled ||
    !positive(factoryDbNowMs) ||
    !KEY.test(pinnedKeyId) ||
    pinnedPublicKey?.type !== 'public' ||
    pinnedPublicKey.asymmetricKeyType !== 'ed25519'
  )
    return null;
  if (
    !dataOnly(packet, ['alg', 'payload', 'signature']) ||
    packet.alg !== 'Ed25519' ||
    typeof packet.signature !== 'string' ||
    !SIGNATURE.test(packet.signature) ||
    !dataOnly(packet.payload, FACTORY_GP_PG_REBIND_V3_FIELDS) ||
    !dataOnly(expected, BOUND_FIELDS)
  )
    return null;
  const p = packet.payload as V3;
  if (!shape(p, factoryDbNowMs) || p.keyId !== pinnedKeyId) return null;
  // Check every bound field, including challenge, exact original scope,
  // immutable old writer, new singleton, v11 chain and real tombstone digest.
  for (const key of BOUND_FIELDS) {
    if (p[key] !== expected[key]) return null;
  }
  try {
    const signature = Buffer.from(packet.signature, 'base64url');
    if (
      signature.length !== 64 ||
      signature.toString('base64url') !== packet.signature ||
      !verify(null, Buffer.concat([DOMAIN, Buffer.from(canonical(p))]), pinnedPublicKey, signature)
    )
      return null;
  } catch {
    return null;
  }
  return Object.freeze({
    cryptographicallyVerified: true,
    authorizesFactoryWrites: false,
    requiresB1TombstoneAndReplayCas: true,
  });
}
