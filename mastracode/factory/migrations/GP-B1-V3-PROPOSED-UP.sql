-- NEVER INSTALLED OR AUTO-RUN. PostgreSQL 18 review proposal only.
-- Must be manually qualified against the exact Factory CollectionSchema and
-- native B1 original revocation table; no existing production migration imports.
BEGIN;
ALTER TABLE factory_gp_pg_handover_revocations
 ADD CONSTRAINT gp_b1_v3_original_exact_scope_unique UNIQUE
 (id, org_id, factory_project_id, lease_intent_id, writer_owner_id, owner_epoch);

CREATE TABLE factory_gp_pg_b1_v3_tombstones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id text NOT NULL,
 factory_project_id text NOT NULL,
 lease_intent_id text NOT NULL UNIQUE,
 old_writer_owner_id text NOT NULL,
 owner_epoch text NOT NULL,
 original_revocation_row_id text NOT NULL UNIQUE,
 original_revocation_uuid uuid GENERATED ALWAYS AS (original_revocation_row_id::uuid) STORED,
 revoke_request_id text NOT NULL UNIQUE,
 pg_epoch_revision integer NOT NULL CHECK (pg_epoch_revision > 0),
 pg_committed_at_ms bigint NOT NULL CHECK (pg_committed_at_ms > 0),
 tombstone_sha256 text NOT NULL UNIQUE CHECK (tombstone_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL,
 CONSTRAINT gp_b1_v3_original_exact_fk FOREIGN KEY
  (original_revocation_uuid, org_id, factory_project_id, lease_intent_id,
   old_writer_owner_id, owner_epoch)
  REFERENCES factory_gp_pg_handover_revocations
  (id, org_id, factory_project_id, lease_intent_id, writer_owner_id, owner_epoch)
);

CREATE TABLE factory_gp_pg_b1_v3_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id text NOT NULL,
 factory_project_id text NOT NULL,
 lease_intent_id text NOT NULL,
 challenge_id text NOT NULL UNIQUE,
 factory_challenge_sha256 text NOT NULL UNIQUE
  CHECK (factory_challenge_sha256 ~ '^[0-9a-f]{64}$'),
 tombstone_sha256 text NOT NULL
  REFERENCES factory_gp_pg_b1_v3_tombstones(tombstone_sha256),
 issued_at_ms bigint NOT NULL,
 expires_at_ms bigint NOT NULL,
 created_at timestamptz NOT NULL,
 CHECK (issued_at_ms > 0 AND expires_at_ms > issued_at_ms
  AND expires_at_ms <= issued_at_ms + 5000)
);

CREATE TABLE factory_gp_pg_b1_v3_consumed_nonces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 challenge_id text NOT NULL UNIQUE
  REFERENCES factory_gp_pg_b1_v3_challenges(challenge_id),
 revoke_request_id text NOT NULL UNIQUE
  REFERENCES factory_gp_pg_b1_v3_tombstones(revoke_request_id),
 rebind_nonce_sha256 text NOT NULL UNIQUE
  CHECK (rebind_nonce_sha256 ~ '^[0-9a-f]{64}$'),
 nonce_scope_sha256 text NOT NULL UNIQUE
  CHECK (nonce_scope_sha256 ~ '^[0-9a-f]{64}$'),
 signed_packet_digest text NOT NULL UNIQUE
  CHECK (signed_packet_digest ~ '^[0-9a-f]{64}$'),
 org_id text NOT NULL,
 factory_project_id text NOT NULL,
 lease_intent_id text NOT NULL,
 old_writer_owner_id text NOT NULL,
 old_writer_epoch integer NOT NULL,
 new_writer_owner_id text NOT NULL,
 new_writer_epoch integer NOT NULL,
 transition_chain_sha256 text NOT NULL
  CHECK (transition_chain_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL,
 CHECK (new_writer_epoch > old_writer_epoch AND old_writer_epoch > 0)
);

CREATE FUNCTION factory_gp_pg_b1_v3_reject_immutable()
 RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'immutable GP B1 V3 ledger: update/delete denied';
END;
$$;
CREATE TRIGGER gp_b1_v3_original_append_only
 BEFORE UPDATE OR DELETE ON factory_gp_pg_handover_revocations
 FOR EACH ROW EXECUTE FUNCTION factory_gp_pg_b1_v3_reject_immutable();
CREATE TRIGGER gp_b1_v3_tombstone_append_only
 BEFORE UPDATE OR DELETE ON factory_gp_pg_b1_v3_tombstones
 FOR EACH ROW EXECUTE FUNCTION factory_gp_pg_b1_v3_reject_immutable();
CREATE TRIGGER gp_b1_v3_challenge_append_only
 BEFORE UPDATE OR DELETE ON factory_gp_pg_b1_v3_challenges
 FOR EACH ROW EXECUTE FUNCTION factory_gp_pg_b1_v3_reject_immutable();
CREATE TRIGGER gp_b1_v3_nonce_append_only
 BEFORE UPDATE OR DELETE ON factory_gp_pg_b1_v3_consumed_nonces
 FOR EACH ROW EXECUTE FUNCTION factory_gp_pg_b1_v3_reject_immutable();
COMMIT;
