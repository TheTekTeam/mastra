import { createHash } from 'node:crypto';

/**
 * Source-only deterministic B1 tombstone and nonce keys. Deliberately NO
 * schema registration, PostgreSQL writer or nonce consumption is installed.
 * A digest does not prove a durable PG tombstone or authorize any write.
 */
export const FACTORY_GP_PG_B1_V3_CAPABILITY = Object.freeze({
  installed: false,
  enabledByDefault: false,
  productionReady: false,
  pgTombstoneWriterInstalled: false,
  replayCasInstalled: false,
  authorizesFactoryWrites: false,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const DOMAIN = Buffer.from('FACTORY_GP_PG_B1_AUTHENTICATED_REVOKE_V3\0');
const NONCE_DOMAIN = Buffer.from('FACTORY_GP_PG_B1_REBIND_NONCE_V3\0');
const own = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype;
const positive = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0;
function exact(x: unknown, fields: readonly string[]): x is Record<string, unknown> {
  if (!own(x)) return false;
  const keys = Reflect.ownKeys(x);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return false;
  return fields.every(key => {
    const d = Object.getOwnPropertyDescriptor(x, key);
    return !!d && d.enumerable === true && 'value' in d;
  });
}
function canonical(x: Record<string, unknown>) {
  return (
    '{' +
    Object.keys(x)
      .sort()
      .map(k => JSON.stringify(k) + ':' + JSON.stringify(x[k]))
      .join(',') +
    '}'
  );
}
function sha(domain: Buffer, row: Record<string, unknown>) {
  return createHash('sha256').update(domain).update(canonical(row)).digest('hex');
}
const TOMB_FIELDS = Object.freeze([
  'version',
  'orgId',
  'projectId',
  'leaseIntentId',
  'oldWriterOwnerId',
  'ownerEpoch',
  'revokeRequestId',
  'originalRevocationRowId',
  'pgCommittedAtMs',
  'pgEpochRevision',
] as const);
const NONCE_FIELDS = Object.freeze([
  'version',
  'orgId',
  'projectId',
  'leaseIntentId',
  'challengeId',
  'factoryChallengeSha256',
  'rebindNonceSha256',
  'factoryTombstoneSha256',
  'oldWriterOwnerId',
  'oldWriterEpoch',
  'newWriterOwnerId',
  'newWriterEpoch',
  'transitionChainSha256',
] as const);
export type V3TombstoneTuple = Readonly<{
  version: 'factory_gp_pg_b1_authenticated_revoke_v3';
  orgId: string;
  projectId: string;
  leaseIntentId: string;
  oldWriterOwnerId: string;
  ownerEpoch: string;
  revokeRequestId: string;
  originalRevocationRowId: string;
  pgCommittedAtMs: number;
  pgEpochRevision: number;
}>;
export type V3NonceTuple = Readonly<{
  version: 'factory_gp_pg_b1_rebind_nonce_v3';
  orgId: string;
  projectId: string;
  leaseIntentId: string;
  challengeId: string;
  factoryChallengeSha256: string;
  rebindNonceSha256: string;
  factoryTombstoneSha256: string;
  oldWriterOwnerId: string;
  oldWriterEpoch: number;
  newWriterOwnerId: string;
  newWriterEpoch: number;
  transitionChainSha256: string;
}>;
const uuid = (x: unknown): x is string => typeof x === 'string' && UUID.test(x);
const hex = (x: unknown): x is string => typeof x === 'string' && HEX.test(x);

/** CALLER MUST NOT treat this digest as proof that a PG row was committed. */
export function canonicalV3AuthenticatedTombstoneDigest(row: unknown): string | null {
  if (
    !exact(row, TOMB_FIELDS) ||
    row.version !== 'factory_gp_pg_b1_authenticated_revoke_v3' ||
    typeof row.orgId !== 'string' ||
    !row.orgId ||
    !uuid(row.projectId) ||
    !uuid(row.leaseIntentId) ||
    !uuid(row.oldWriterOwnerId) ||
    typeof row.ownerEpoch !== 'string' ||
    !row.ownerEpoch ||
    !uuid(row.revokeRequestId) ||
    !uuid(row.originalRevocationRowId) ||
    !positive(row.pgCommittedAtMs) ||
    !positive(row.pgEpochRevision)
  )
    return null;
  return sha(DOMAIN, row);
}

/** Stable uniqueness key only. No one-use consume occurs in this source. */
export function canonicalV3RebindNonceKey(row: unknown): string | null {
  if (
    !exact(row, NONCE_FIELDS) ||
    row.version !== 'factory_gp_pg_b1_rebind_nonce_v3' ||
    typeof row.orgId !== 'string' ||
    !row.orgId ||
    !uuid(row.projectId) ||
    !uuid(row.leaseIntentId) ||
    !uuid(row.challengeId) ||
    !hex(row.factoryChallengeSha256) ||
    !hex(row.rebindNonceSha256) ||
    !hex(row.factoryTombstoneSha256) ||
    !uuid(row.oldWriterOwnerId) ||
    !positive(row.oldWriterEpoch) ||
    !uuid(row.newWriterOwnerId) ||
    !positive(row.newWriterEpoch) ||
    row.newWriterEpoch <= row.oldWriterEpoch ||
    !hex(row.transitionChainSha256)
  )
    return null;
  return sha(NONCE_DOMAIN, row);
}
