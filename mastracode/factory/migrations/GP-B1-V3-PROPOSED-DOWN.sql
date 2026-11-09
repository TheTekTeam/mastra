-- NEVER INSTALLED OR AUTO-RUN. Fail-closed rollback for exact UP proposal.
-- The historic B1 revocation table and its rows are NEVER dropped.
-- Safe only if all new V3 ledger tables are empty. A nonempty ledger must
-- remain immutable and be dealt with through a separately reviewed plan.
BEGIN;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM factory_gp_pg_b1_v3_tombstones)
  OR EXISTS (SELECT 1 FROM factory_gp_pg_b1_v3_challenges)
  OR EXISTS (SELECT 1 FROM factory_gp_pg_b1_v3_consumed_nonces)
 THEN
  RAISE EXCEPTION 'rollback prohibited: V3 tombstone/challenge/nonce rows exist';
 END IF;
END;
$$;
DROP TRIGGER gp_b1_v3_nonce_append_only ON factory_gp_pg_b1_v3_consumed_nonces;
DROP TRIGGER gp_b1_v3_challenge_append_only ON factory_gp_pg_b1_v3_challenges;
DROP TRIGGER gp_b1_v3_tombstone_append_only ON factory_gp_pg_b1_v3_tombstones;
DROP TRIGGER gp_b1_v3_original_append_only ON factory_gp_pg_handover_revocations;
DROP TABLE factory_gp_pg_b1_v3_consumed_nonces;
DROP TABLE factory_gp_pg_b1_v3_challenges;
DROP TABLE factory_gp_pg_b1_v3_tombstones;
ALTER TABLE factory_gp_pg_handover_revocations
 DROP CONSTRAINT gp_b1_v3_original_exact_scope_unique;
DROP FUNCTION factory_gp_pg_b1_v3_reject_immutable();
COMMIT;
