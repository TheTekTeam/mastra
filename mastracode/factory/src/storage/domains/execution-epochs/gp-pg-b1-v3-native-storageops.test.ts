import { describe, expect, it } from 'vitest';
import {
  FACTORY_GP_PG_B1_V3_NATIVE_CAPABILITY,
  FACTORY_GP_PG_B1_V3_TEST_SCHEMAS,
  FactoryGpPgB1V3NativeStorageOps,
  factoryGpB1V3SourceSchemaSha256,
} from './gp-pg-b1-v3-native-storageops.js';

describe('Factory native B1 V3 source-only StorageOps', () => {
  it('does not install, migrate or authorize anything by default', async () => {
    expect(FACTORY_GP_PG_B1_V3_NATIVE_CAPABILITY).toEqual({
      installed: false,
      enabledByDefault: false,
      productionReady: false,
      liveSchemaMigrationInstalled: false,
      liveGpMtlsReceiverInstalled: false,
      livePmSignerInstalled: false,
      authorizesFactoryWrites: false,
    });
    expect(Object.isFrozen(FACTORY_GP_PG_B1_V3_NATIVE_CAPABILITY)).toBe(true);
    const domain = new FactoryGpPgB1V3NativeStorageOps();
    expect(await domain.revokeWithTombstone({})).toBe('not_ready');
    expect(await domain.mintOneUseChallenge({})).toBeNull();
    expect(await domain.consumePrivateV3Nonce({})).toBe('not_ready');
  });
  it('rejects enabled issuer with missing independent GP/PM providers', () => {
    expect(() => new FactoryGpPgB1V3NativeStorageOps({ enabled: true })).toThrow(
      /independently enrolled private GP and PM providers/,
    );
  });
  it('describes immutable unique tombstone, challenge and nonce scopes', () => {
    const names = FACTORY_GP_PG_B1_V3_TEST_SCHEMAS.map(s => s.name);
    expect(names).toEqual([
      'factory_gp_pg_handover_revocations',
      'factory_gp_pg_b1_v3_tombstones',
      'factory_gp_pg_b1_v3_challenges',
      'factory_gp_pg_b1_v3_consumed_nonces',
    ]);
    const nonce = FACTORY_GP_PG_B1_V3_TEST_SCHEMAS[3];
    const fields = nonce.uniqueIndexes?.flatMap(x => x.columns) ?? [];
    for (const name of [
      'challenge_id',
      'revoke_request_id',
      'rebind_nonce_sha256',
      'nonce_scope_sha256',
      'signed_packet_digest',
    ])
      expect(fields).toContain(name);
    expect(factoryGpB1V3SourceSchemaSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  // BLOCKED: actual @mastra/core and @mastra/pg dist absent in isolated source
  // clone; #59's real PG18 race tests exercise SQL fixtures, NOT this class.
  it.todo('PG18 native B1 epoch lock commits original revoke + V3 tombstone atomically');
  it.todo('real independent process race consumes one signed V3 challenge and nonce');
  it.todo('fresh process after PostgreSQL restart denies durable replay');
  it.todo('raw migration exact FK and immutable triggers match ensureCollections DDL');
  it.todo('independent PM V11 current writer and pinned mTLS Ed25519 under epoch lock');
  it.todo('injected transaction abort leaves no original or V3 tombstone orphan');
});
