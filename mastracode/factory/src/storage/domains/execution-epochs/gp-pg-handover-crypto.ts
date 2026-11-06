import { createHash, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// Must byte-match PM's source-only Ed25519 handover v1 canonical contract.
// This verifier is not an activation route or an independent lease authority.
const DOMAIN = Buffer.from('PM_TO_FACTORY_GP_PG_HANDOVER_V1\0', 'utf8');
const KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const opaque = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256 && v === v.trim();
const own = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const fields = (v: unknown, expected: readonly string[]): v is Record<string, unknown> =>
  own(v) && Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k));
const SCOPE = [
  'consentRequestId', 'manifestId', 'nonceSha256', 'projectId', 'factoryOrgId',
  'repositoryId', 'repositoryOwnerId', 'appInstallationId', 'writerOwnerId',
  'writerEpoch', 'ownerEpoch', 'authorityRevision', 'policyDigest', 'scopeDigest',
  'sourceProofDigest', 'mode', 'nativeAutomationRevision', 'mappingDigest',
  'coverageVersion', 'bridgeChallengeId', 'leaseIntentId',
] as const;
const PAYLOAD = [
  'version', 'audience', 'issuer', 'keyId', 'issuedAtMs', 'expiresAtMs',
  'scopeTupleSha256', 'scope',
] as const;

export interface GpHandoverScope {
  consentRequestId: string; manifestId: string; nonceSha256: string;
  projectId: string; factoryOrgId: string;
  repositoryId: number; repositoryOwnerId: number; appInstallationId: number | null;
  writerOwnerId: string; writerEpoch: number; ownerEpoch: string;
  authorityRevision: number; policyDigest: string; scopeDigest: string;
  sourceProofDigest: string; mode: 'supervised' | 'autonomous';
  nativeAutomationRevision: number; mappingDigest: string; coverageVersion: number;
  bridgeChallengeId: string; leaseIntentId: string;
}
export interface GpSignedHandoverPacket {
  alg: 'Ed25519'; signature: string;
  payload: {
    version: 'pm_factory_pg_handover_v1';
    audience: 'factory_pg_handover_issuer';
    issuer: string; keyId: string;
    issuedAtMs: number; expiresAtMs: number;
    scopeTupleSha256: string; scope: GpHandoverScope;
  };
}
export interface VerifiedHandoverPacket {
  scope: GpHandoverScope;
  packetDigest: string;
  scopeTupleSha256: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!own(value)) throw new Error('GP_PG_NONCANONICAL_JSON');
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) throw new Error('GP_PG_JSON_ACCESSOR_FORBIDDEN');
  }
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function gpV9ScopeTupleDigest(x: GpHandoverScope): string {
  const tuple = [
    x.consentRequestId, x.manifestId, x.nonceSha256, x.projectId,
    x.factoryOrgId, x.repositoryId, x.repositoryOwnerId, x.appInstallationId,
    x.writerOwnerId, x.writerEpoch, x.ownerEpoch, x.authorityRevision,
    x.policyDigest, x.scopeDigest, x.sourceProofDigest, x.mode,
    x.nativeAutomationRevision, x.mappingDigest, x.coverageVersion,
    x.bridgeChallengeId, x.leaseIntentId,
  ];
  return sha(JSON.stringify(tuple));
}
function validScope(x: unknown): x is GpHandoverScope {
  if (!fields(x, SCOPE)) return false;
  return UUID.test(String(x.consentRequestId ?? '')) && HEX.test(String(x.manifestId ?? '')) &&
    HEX.test(String(x.nonceSha256 ?? '')) && UUID.test(String(x.projectId ?? '')) &&
    opaque(x.factoryOrgId) && positive(x.repositoryId) && positive(x.repositoryOwnerId) &&
    (x.appInstallationId === null || positive(x.appInstallationId)) &&
    opaque(x.writerOwnerId) && positive(x.writerEpoch) && opaque(x.ownerEpoch) &&
    positive(x.authorityRevision) && HEX.test(String(x.policyDigest ?? '')) &&
    HEX.test(String(x.scopeDigest ?? '')) && HEX.test(String(x.sourceProofDigest ?? '')) &&
    (x.mode === 'supervised' || x.mode === 'autonomous') &&
    nonnegative(x.nativeAutomationRevision) && HEX.test(String(x.mappingDigest ?? '')) &&
    positive(x.coverageVersion) && UUID.test(String(x.bridgeChallengeId ?? '')) &&
    UUID.test(String(x.leaseIntentId ?? ''));
}

/**
 * Real signature verification using Factory-pinned server key and PG DB time.
 * It is safe to call within the project epoch-row transaction, but the
 * caller MUST still commit a unique PG replay consumption before granting.
 */
export function verifyFactoryGpSignedPacket(input: {
  packet: unknown;
  expectedScope: GpHandoverScope;
  trustedKey: { keyId: string; publicKey: KeyObject };
  now: Date;
  expectedIssuer?: string;
}): VerifiedHandoverPacket | null {
  try {
    const { packet, expectedScope, trustedKey, now } = input;
    if (!fields(packet, ['payload', 'signature', 'alg']) || packet.alg !== 'Ed25519') return null;
    const p = packet.payload;
    if (!fields(p, PAYLOAD) || p.version !== 'pm_factory_pg_handover_v1' ||
      p.audience !== 'factory_pg_handover_issuer' ||
      p.issuer !== (input.expectedIssuer ?? 'factory-project-manager') ||
      !KEY.test(String(p.issuer ?? '')) || !KEY.test(String(p.keyId ?? '')) ||
      !validScope(p.scope) || !validScope(expectedScope)) return null;
    const digest = gpV9ScopeTupleDigest(expectedScope);
    if (p.scopeTupleSha256 !== digest || canonical(p.scope) !== canonical(expectedScope)) return null;
    const ms = now.getTime();
    if (!positive(ms) || !positive(p.issuedAtMs) || !positive(p.expiresAtMs) ||
      Number(p.issuedAtMs) > ms || ms >= Number(p.expiresAtMs) ||
      Number(p.expiresAtMs) - Number(p.issuedAtMs) > 10000) return null;
    if (typeof packet.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(packet.signature) ||
      p.keyId !== trustedKey.keyId || trustedKey.publicKey?.type !== 'public' ||
      trustedKey.publicKey.asymmetricKeyType !== 'ed25519') return null;
    const signature = Buffer.from(packet.signature, 'base64url');
    const bytes = Buffer.concat([DOMAIN, Buffer.from(canonical(p), 'utf8')]);
    if (signature.length !== 64 || !verify(null, bytes, trustedKey.publicKey, signature)) return null;
    return { scope: expectedScope, packetDigest: sha(bytes), scopeTupleSha256: digest };
  } catch {
    return null;
  }
}
