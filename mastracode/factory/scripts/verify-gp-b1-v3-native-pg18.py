#!/usr/bin/env python3
"""Opt-in disposable native FactoryStorageOps PostgreSQL 18.6 test.

Uninstalled proposed SQL only, UID995 rootless pinned container, random DB,
127.0.0.1-only ephemeral port. No Factory service/DB/migration is touched.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import uuid

IMAGE = "postgres@sha256:300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736"
SOCKET = "unix:///var/lib/mastra-ci/run/docker.sock"
DOCKER = ("sudo", "-n", "-u", "mastra-ci", "env", "DOCKER_HOST=" + SOCKET, "docker")
ENABLED = "FACTORY_GP_B1_V3_NATIVE_PG18_EPHEMERAL"
ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "migrations"


def docker(*args, stdin=None, timeout=30, check=True):
    r = subprocess.run([*DOCKER, *args], input=stdin, capture_output=True,
                       text=True, timeout=timeout)
    if check and r.returncode:
        raise AssertionError(f"rootless Docker {args[:2]} failed: {r.stderr[-600:]}")
    return r


def sql(container, statement, *, db="postgres", check=True):
    return docker("exec", "-i", container, "psql", "-X", "-q", "-t", "-A",
                  "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db,
                  stdin=statement, check=check)


ORIGINAL = """
CREATE TABLE factory_gp_pg_handover_revocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id text NOT NULL, factory_project_id text NOT NULL,
 lease_intent_id text NOT NULL UNIQUE, writer_owner_id text NOT NULL,
 owner_epoch text NOT NULL, created_at timestamptz NOT NULL
);
"""


def verify_migration():
    m = json.loads((MIGRATIONS / "GP-B1-V3-PROPOSED-MANIFEST.json").read_text())
    for file_key, sha_key in (("upFile", "upSha256"), ("downFile", "downSha256")):
        actual = hashlib.sha256((MIGRATIONS / m[file_key]).read_bytes()).hexdigest()
        assert actual == m[sha_key], f"proposed migration hash drift: {file_key}"
    return (MIGRATIONS / m["upFile"]).read_text()


def main():
    if os.environ.get(ENABLED) != "I_ACK_SOURCE_ONLY_EPHEMERAL":
        raise SystemExit("DENIED: explicit isolated PG18 native test acknowledgement required")
    if os.geteuid() == 0:
        raise SystemExit("DENIED: do not run test orchestrator as root")
    assert "rootless" in docker("info", "--format", "{{.SecurityOptions}}").stdout
    assert docker("image", "inspect", IMAGE, check=False).returncode == 0, "pinned PG18 image not cached"
    up = verify_migration()
    name = "factory-b1-v3-native-" + uuid.uuid4().hex[:16]
    db = "factory_b1_v3_" + uuid.uuid4().hex[:16]
    password = secrets.token_urlsafe(36)
    try:
        # Rootless bridge: ONLY host loopback ephemeral port is published.
        # --internal disables host port mapping on this Docker implementation.
        docker("run", "--pull", "never", "--rm", "-d", "--name", name,
               "--network", "bridge", "-p", "127.0.0.1::5432",
               "--memory", "512m", "--pids-limit", "100", "--cpus", "1",
               "--security-opt", "no-new-privileges", "--user", "999:999",
               "-e", "PGDATA=/tmp/pgdata", "-e", "POSTGRES_DB=" + db,
               "-e", "POSTGRES_PASSWORD=" + password, IMAGE, timeout=40)
        for _ in range(80):
            complete = "PostgreSQL init process complete" in docker("logs", name).stdout
            if complete and sql(name, "SELECT 1;", check=False).returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise AssertionError("ephemeral PostgreSQL 18 boot timed out")
        version = sql(name, "SELECT current_setting('server_version_num');").stdout.strip()
        assert version.startswith("180"), f"not PG18: {version}"
        sql(name, ORIGINAL, db=db, check=True)
        sql(name, up, db=db, check=True)
        # Mounted only in this disposable database. No actual migration installed.
        mapped = docker("port", name, "5432/tcp").stdout.strip()
        match = re.fullmatch(r"127\.0\.0\.1:(\d+)", mapped)
        assert match, "refusing any non-loopback or ambiguous mapped port"
        port = int(match.group(1))
        env = dict(os.environ)
        env["FACTORY_GP_B1_V3_NATIVE_PG_TEST_URL"] = (
            f"postgresql://postgres:{password}@127.0.0.1:{port}/{db}")
        env["FACTORY_GP_B1_V3_NATIVE_EPHEMERAL_MARKER"] = db
        test_path = "src/storage/domains/execution-epochs/gp-pg-b1-v3-native-pg18.integration.test.ts"
        result = subprocess.run(["pnpm", "exec", "vitest", "run", test_path,
                                 "--maxWorkers=1", "--no-file-parallelism",
                                 "--reporter=verbose"],
                                cwd=ROOT, env=env, timeout=180)
        if result.returncode:
            print("DIAGNOSTIC trigger names:", sql(name,
                  "SELECT tgname FROM pg_trigger WHERE tgrelid='factory_gp_pg_b1_v3_tombstones'::regclass AND NOT tgisinternal;", db=db).stdout.strip())
            print("DIAGNOSTIC tomb count:", sql(name,
                  "SELECT COUNT(*) FROM factory_gp_pg_b1_v3_tombstones;", db=db).stdout.strip())
            raise AssertionError(f"native FactoryStorageOps Vitest failed ({result.returncode})")
        docker("restart", "-t", "2", name, timeout=35)
        for _ in range(60):
            if sql(name, "SELECT 1;", check=False).returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise AssertionError("PG18 did not recover after restart")
        # Fresh PG process retains native StorageOps tombstones AND unique CAS.
        persisted = sql(name, "SELECT COUNT(*) FROM factory_gp_pg_b1_v3_tombstones;", db=db).stdout.strip()
        assert int(persisted) >= 1, "native StorageOps tombstone not persisted across restart"
        consumed = sql(name, "SELECT COUNT(*) FROM factory_gp_pg_b1_v3_consumed_nonces;", db=db).stdout.strip()
        assert consumed == "1", "native StorageOps nonce must be exactly one after restart"
        # New PG session after restart: identical nonce insertion must hit
        # the physical unique constraint even without an in-memory cache.
        columns = ("challenge_id,revoke_request_id,rebind_nonce_sha256,"
                   "nonce_scope_sha256,signed_packet_digest,org_id,"
                   "factory_project_id,lease_intent_id,old_writer_owner_id,"
                   "old_writer_epoch,new_writer_owner_id,new_writer_epoch,"
                   "transition_chain_sha256,created_at")
        replay = sql(name, f"INSERT INTO factory_gp_pg_b1_v3_consumed_nonces ({columns}) "
                     f"SELECT {columns} FROM factory_gp_pg_b1_v3_consumed_nonces LIMIT 1;",
                     db=db, check=False)
        assert replay.returncode != 0, "PG18 unique nonce replay was incorrectly admitted"
        assert sql(name, "SELECT COUNT(*) FROM factory_gp_pg_b1_v3_consumed_nonces;",
                   db=db).stdout.strip() == "1"
        immutable = sql(name, "DELETE FROM factory_gp_pg_b1_v3_consumed_nonces;", db=db, check=False)
        assert immutable.returncode != 0, "PG18 immutable nonce trigger missing after restart"
        print("PASS: PG18 restart preserved native tombstone + exactly one CAS nonce; "
              "replay/DELETE still denied")
    finally:
        removed = docker("rm", "-f", name, check=False)
        if removed.returncode and "No such container" not in removed.stderr:
            raise AssertionError("CLEANUP FAILURE: rootless Docker container retained")
        leftover = docker("ps", "-a", "--format", "{{.Names}}", "--filter", f"name={name}")
        if name in leftover.stdout.splitlines():
            raise AssertionError("CLEANUP FAILURE: rootless container still present")
        print("CLEANUP: ephemeral PG18 container absent; no live DB touched")


if __name__ == "__main__":
    main()
