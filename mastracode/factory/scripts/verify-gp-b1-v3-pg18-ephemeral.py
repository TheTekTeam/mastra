#!/usr/bin/env python3
"""DEFAULT-OFF isolated PG18 *model* for proposed B1 V3 tombstone/nonce CAS.

No Factory module, migration, route, signer or live DB is touched. This script
creates a unique NO-NETWORK rootless container with test-only tables and deletes
it in finally. This is NOT end-to-end Factory native B1 authorization evidence.
"""
import concurrent.futures
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import uuid

PINNED_IMAGE = (
    "postgres@sha256:"
    "300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736"
)
ROOTLESS_HOST = "unix:///var/lib/mastra-ci/run/docker.sock"
TEST_ENABLE = "FACTORY_GP_B1_V3_EPHEMERAL_PG18_TEST"
DOMAIN = b"FACTORY_GP_PG_B1_AUTHENTICATED_REVOKE_V3\x00"
NONCE_DOMAIN = b"FACTORY_GP_PG_B1_REBIND_NONCE_V3\x00"


def checked(cmd, *, stdin=None, timeout=30, must_succeed=True):
    outcome = subprocess.run(
        cmd, input=stdin, text=True, capture_output=True, timeout=timeout,
        check=False,
    )
    if must_succeed and outcome.returncode:
        raise AssertionError(
            f"command failed ({outcome.returncode}): {cmd[0]} {cmd[1:3]} "
            f"{outcome.stderr[-700:]}"
        )
    return outcome


def docker(*args, timeout=30, must_succeed=True):
    return checked(["docker", *args], timeout=timeout, must_succeed=must_succeed)


def sql(container, statement, *, must_succeed=True):
    outcome = checked(
        ["docker", "exec", "-i", container, "psql", "-X", "-q", "-t", "-A",
         "-v", "ON_ERROR_STOP=1", "-U", "postgres", "postgres"],
        stdin=statement, timeout=20, must_succeed=must_succeed,
    )
    return outcome


def digest(domain, mapping):
    canonical = json.dumps(mapping, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(domain + canonical.encode("utf8")).hexdigest()


def fixture():
    identity = lambda: str(uuid.uuid4())
    old_writer = identity()
    new_writer = identity()
    org = "isolated-harness-org"
    project = identity()
    lease = identity()
    original = identity()
    revoke = identity()
    epoch = "epoch-17"
    clock_ms = int(time.time() * 1000)
    tombstone = {
        "version": "factory_gp_pg_b1_authenticated_revoke_v3",
        "orgId": org, "projectId": project, "leaseIntentId": lease,
        "oldWriterOwnerId": old_writer, "ownerEpoch": epoch,
        "revokeRequestId": revoke, "originalRevocationRowId": original,
        "pgCommittedAtMs": clock_ms, "pgEpochRevision": 17,
    }
    tombstone_hash = digest(DOMAIN, tombstone)
    challenge = identity()
    nonce_hash = "a" * 64
    challenge_hash = "b" * 64
    chain_hash = "c" * 64
    nonce_scope = {
        "version": "factory_gp_pg_b1_rebind_nonce_v3",
        "orgId": org, "projectId": project, "leaseIntentId": lease,
        "challengeId": challenge,
        "factoryChallengeSha256": challenge_hash,
        "rebindNonceSha256": nonce_hash,
        "factoryTombstoneSha256": tombstone_hash,
        "oldWriterOwnerId": old_writer, "oldWriterEpoch": 17,
        "newWriterOwnerId": new_writer, "newWriterEpoch": 18,
        "transitionChainSha256": chain_hash,
    }
    return {
        **tombstone, "tombstoneHash": tombstone_hash, "challengeId": challenge,
        "challengeHash": challenge_hash, "nonceHash": nonce_hash,
        "nonceScopeHash": digest(NONCE_DOMAIN, nonce_scope),
        "newWriterOwnerId": new_writer, "chainHash": chain_hash,
        "signedPacketHash": "d" * 64,
    }


DDL = """
CREATE TABLE test_native_epochs (
  org_id text NOT NULL, project_id text NOT NULL, revision bigint NOT NULL,
  owner_epoch text NOT NULL, writer_owner_id text NOT NULL,
  writer_epoch bigint NOT NULL, PRIMARY KEY(org_id, project_id)
);
CREATE TABLE test_original_b1_revocations (
  id uuid PRIMARY KEY, org_id text NOT NULL, project_id text NOT NULL,
  lease_intent_id uuid NOT NULL UNIQUE, writer_owner_id uuid NOT NULL,
  owner_epoch text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE test_b1_v3_tombstones (
  original_revocation_row_id uuid NOT NULL UNIQUE
    REFERENCES test_original_b1_revocations(id),
  revoke_request_id uuid PRIMARY KEY,
  org_id text NOT NULL, project_id text NOT NULL,
  lease_intent_id uuid NOT NULL UNIQUE,
  old_writer_owner_id uuid NOT NULL, owner_epoch text NOT NULL,
  pg_epoch_revision bigint NOT NULL CHECK(pg_epoch_revision > 0),
  committed_at_ms bigint NOT NULL CHECK(committed_at_ms > 0),
  tombstone_sha256 char(64) NOT NULL UNIQUE
);
CREATE TABLE test_v3_challenges (
  challenge_id uuid PRIMARY KEY, org_id text NOT NULL,
  project_id text NOT NULL, lease_intent_id uuid NOT NULL,
  factory_challenge_sha256 char(64) NOT NULL UNIQUE,
  tombstone_sha256 char(64) NOT NULL REFERENCES test_b1_v3_tombstones(tombstone_sha256),
  expires_at_ms bigint NOT NULL
);
CREATE TABLE test_v3_consumptions (
  challenge_id uuid NOT NULL UNIQUE REFERENCES test_v3_challenges(challenge_id),
  rebind_nonce_sha256 char(64) NOT NULL UNIQUE,
  nonce_scope_sha256 char(64) NOT NULL UNIQUE,
  revoke_request_id uuid NOT NULL UNIQUE REFERENCES test_b1_v3_tombstones(revoke_request_id),
  signed_packet_digest char(64) NOT NULL UNIQUE,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable B1 V3 ledger'; END $$;
CREATE TRIGGER forbid_revocation_change BEFORE UPDATE OR DELETE
 ON test_original_b1_revocations FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER forbid_tombstone_change BEFORE UPDATE OR DELETE
 ON test_b1_v3_tombstones FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER forbid_consumption_change BEFORE UPDATE OR DELETE
 ON test_v3_consumptions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
"""


def initial_sql(f):
    # Test fixture only: a live implementation MUST derive these from
    # authenticated private GP session / same PG commit clock, never caller data.
    return f"""
BEGIN;
INSERT INTO test_native_epochs VALUES
 ('{f['orgId']}','{f['projectId']}',17,'{f['ownerEpoch']}','{f['oldWriterOwnerId']}',17);
SELECT revision FROM test_native_epochs WHERE org_id='{f['orgId']}'
 AND project_id='{f['projectId']}' FOR UPDATE;
INSERT INTO test_original_b1_revocations
 (id,org_id,project_id,lease_intent_id,writer_owner_id,owner_epoch)
 VALUES ('{f['originalRevocationRowId']}','{f['orgId']}','{f['projectId']}',
 '{f['leaseIntentId']}','{f['oldWriterOwnerId']}','{f['ownerEpoch']}');
INSERT INTO test_b1_v3_tombstones VALUES
 ('{f['originalRevocationRowId']}','{f['revokeRequestId']}',
 '{f['orgId']}','{f['projectId']}','{f['leaseIntentId']}',
 '{f['oldWriterOwnerId']}','{f['ownerEpoch']}',17,
 {f['pgCommittedAtMs']},'{f['tombstoneHash']}');
COMMIT;
UPDATE test_native_epochs SET writer_owner_id='{f['newWriterOwnerId']}',
 writer_epoch=18,revision=18 WHERE org_id='{f['orgId']}'
 AND project_id='{f['projectId']}';
INSERT INTO test_v3_challenges VALUES
 ('{f['challengeId']}','{f['orgId']}','{f['projectId']}',
 '{f['leaseIntentId']}','{f['challengeHash']}','{f['tombstoneHash']}',
 (floor(extract(epoch FROM clock_timestamp())*1000)::bigint + 30000));
"""


def attempt_sql(f, *, challenge=None, tombstone=None, expect_epoch=18, sleep=0.15):
    challenge = challenge or f["challengeId"]
    tombstone = tombstone or f["tombstoneHash"]
    return f"""
BEGIN;
SET LOCAL lock_timeout = '5000ms';
SELECT revision FROM test_native_epochs WHERE org_id='{f['orgId']}'
 AND project_id='{f['projectId']}' FOR UPDATE;
SELECT pg_sleep({sleep});
WITH accepted AS (
INSERT INTO test_v3_consumptions
 (challenge_id,rebind_nonce_sha256,nonce_scope_sha256,
  revoke_request_id,signed_packet_digest)
 SELECT c.challenge_id,'{f['nonceHash']}','{f['nonceScopeHash']}',
        t.revoke_request_id,'{f['signedPacketHash']}'
 FROM test_native_epochs e
 JOIN test_b1_v3_tombstones t ON t.org_id=e.org_id
  AND t.project_id=e.project_id
 JOIN test_original_b1_revocations r ON r.id=t.original_revocation_row_id
 JOIN test_v3_challenges c ON c.tombstone_sha256=t.tombstone_sha256
 WHERE e.org_id='{f['orgId']}' AND e.project_id='{f['projectId']}'
   AND e.writer_epoch={expect_epoch}
   AND e.writer_owner_id='{f['newWriterOwnerId']}'
   AND t.tombstone_sha256='{tombstone}'
   AND t.revoke_request_id='{f['revokeRequestId']}'
   AND t.lease_intent_id='{f['leaseIntentId']}'
   AND r.org_id=t.org_id AND r.project_id=t.project_id
   AND r.lease_intent_id=t.lease_intent_id
   AND r.writer_owner_id=t.old_writer_owner_id
   AND r.owner_epoch=t.owner_epoch
   AND c.challenge_id='{challenge}'
   AND c.org_id=t.org_id AND c.project_id=t.project_id
   AND c.lease_intent_id=t.lease_intent_id
   AND c.expires_at_ms > floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 ON CONFLICT DO NOTHING RETURNING 'WON' AS result
) SELECT result FROM accepted;
COMMIT;
"""


def must_count(container, table, expected):
    actual = sql(container, f"SELECT count(*) FROM {table};").stdout.strip()
    assert actual == str(expected), f"{table}: expected {expected}, got {actual!r}"


def verify(container):
    version = int(sql(container, "SELECT current_setting('server_version_num');").stdout.strip())
    assert 180000 <= version < 190000, f"Expected PostgreSQL 18, got {version}"
    f = fixture()
    sql(container, DDL)
    sql(container, initial_sql(f))
    must_count(container, "test_original_b1_revocations", 1)
    must_count(container, "test_b1_v3_tombstones", 1)
    assert sql(container, attempt_sql(f, tombstone="e"*64, sleep=0)).stdout.count("WON") == 0
    assert sql(container, attempt_sql(f, expect_epoch=17, sleep=0)).stdout.count("WON") == 0
    assert sql(container, attempt_sql(f, challenge=str(uuid.uuid4()), sleep=0)).stdout.count("WON") == 0
    expired_id = str(uuid.uuid4())
    sql(container, f"""INSERT INTO test_v3_challenges VALUES
    ('{expired_id}','{f['orgId']}','{f['projectId']}',
     '{f['leaseIntentId']}','{'e'*64}','{f['tombstoneHash']}',
     (floor(extract(epoch FROM clock_timestamp())*1000)::bigint - 1));""")
    assert sql(container, attempt_sql(f, challenge=expired_id, sleep=0)).stdout.count("WON") == 0
    must_count(container, "test_v3_consumptions", 0)
    # A duplicate authenticated revoke is atomic fail-closed; the native row
    # and extension remain one committed pair.
    duplicate = f"""
BEGIN;
INSERT INTO test_original_b1_revocations VALUES
 ('{uuid.uuid4()}','{f['orgId']}','{f['projectId']}',
 '{uuid.uuid4()}','{f['oldWriterOwnerId']}','{f['ownerEpoch']}',clock_timestamp());
INSERT INTO test_b1_v3_tombstones VALUES
 ('{uuid.uuid4()}','{f['revokeRequestId']}','{f['orgId']}',
 '{f['projectId']}','{uuid.uuid4()}','{f['oldWriterOwnerId']}',
 '{f['ownerEpoch']}',17,{f['pgCommittedAtMs']},'{f['tombstoneHash']}');
COMMIT;
"""
    assert sql(container, duplicate, must_succeed=False).returncode != 0
    must_count(container, "test_original_b1_revocations", 1)
    must_count(container, "test_b1_v3_tombstones", 1)
    # True independent PostgreSQL sessions race for the identical one-use
    # nonce under the same native row lock and unique database constraints.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        one = executor.submit(sql, container, attempt_sql(f))
        two = executor.submit(sql, container, attempt_sql(f))
        results = (one.result(), two.result())
    wins = sum(x.stdout.count("WON") for x in results)
    assert wins == 1, f"PG concurrency expected one unique winner, got {wins}"
    must_count(container, "test_v3_consumptions", 1)
    assert sql(container, attempt_sql(f, sleep=0)).stdout.count("WON") == 0
    # Immutable ledgers fail UPDATE, DELETE, not merely privilege hints.
    for table in ("test_original_b1_revocations", "test_b1_v3_tombstones",
                  "test_v3_consumptions"):
        assert sql(container, f"DELETE FROM {table};", must_succeed=False).returncode != 0
    print("PG18 isolated B1 V3: real two-session lock/CAS 1 winner; mismatch, rollback and immutable negatives PASS")
    return f


def main():
    if os.environ.get(TEST_ENABLE) != "I_ACK_ISOLATED_TEST_ONLY":
        raise SystemExit(f"DENIED: set {TEST_ENABLE}=I_ACK_ISOLATED_TEST_ONLY explicitly")
    if os.geteuid() != 995 or os.environ.get("DOCKER_HOST") != ROOTLESS_HOST:
        raise SystemExit("DENIED: requires UID995 mastra-ci and exact pinned rootless socket")
    info = docker("info", "--format", "{{.SecurityOptions}}").stdout
    if "rootless" not in info:
        raise SystemExit("DENIED: Docker daemon is not rootless")
    if docker("image", "inspect", PINNED_IMAGE, "--format", "{{.Id}}",
              must_succeed=False).returncode:
        raise SystemExit("DENIED: pinned PG18 image not locally cached; no pulls permitted")
    name = "factory-gp-b1-v3-pg18-" + uuid.uuid4().hex[:16]
    password = secrets.token_urlsafe(32)
    created = True  # Always attempt cleanup even if docker run fails midway.
    try:
        docker("run", "--pull", "never", "--rm", "-d",
               "--name", name, "--network", "none",
               "--memory", "512m", "--pids-limit", "100", "--cpus", "1",
               "--security-opt", "no-new-privileges",
               "--user", "999:999", "-e", "PGDATA=/tmp/pgdata",
               "-e", "POSTGRES_PASSWORD=" + password, PINNED_IMAGE,
               timeout=30)
        for _ in range(50):
            # Official image starts a *temporary* postmaster for initdb, stops
            # it and then starts the final server. pg_isready alone races that
            # restart; wait for completed init log plus a live SQL round trip.
            boot_complete = "PostgreSQL init process complete" in docker("logs", name).stdout
            ready = sql(name, "SELECT 1;", must_succeed=False).returncode == 0
            if boot_complete and ready:
                break
            time.sleep(0.2)
        else:
            raise AssertionError("PG18 ephemeral boot did not become ready")
        f = verify(name)
        docker("restart", "-t", "2", name, timeout=30)
        for _ in range(50):
            if docker("exec", name, "pg_isready", "-U", "postgres",
                      must_succeed=False).returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise AssertionError("ephemeral PG18 restart did not become ready")
        must_count(name, "test_v3_consumptions", 1)
        assert sql(name, attempt_sql(f, sleep=0)).stdout.count("WON") == 0
        print("PG18 isolated B1 V3: replay still denied after PG process restart PASS")
        print("PASS: model-only PG18 transactional harness; NOT live Factory authority")
    finally:
        if created:
            removal = docker("rm", "-f", name, timeout=20, must_succeed=False)
            if removal.returncode and "No such container" not in removal.stderr:
                raise AssertionError("CLEANUP FAILED: manual rootless inspection required")
            leftover = docker("ps", "-a", "--format", "{{.Names}}", "--filter", f"name={name}")
            if name in leftover.stdout.splitlines():
                raise AssertionError("CLEANUP FAILED: test container still exists")
            print("CLEANUP: ephemeral rootless container absent")


if __name__ == "__main__":
    main()
