#!/usr/bin/env python3
"""Execute UNINSTALLED proposed B1 V3 raw DDL and rollback in an isolated PG18.

This invokes only UID995 rootless Docker, ephemeral containers, no network.
It does NOT connect to any live Factory Postgres or execute Factory StorageOps.
"""
import hashlib
import os
from pathlib import Path
import secrets
import subprocess
import time
import uuid

IMAGE = "postgres@sha256:300ebd02c6d4de9ee27ad7f6855d5d21b4d3a4a5117767c1197d284c635d9736"
SOCKET = "unix:///var/lib/mastra-ci/run/docker.sock"
ENABLED = "FACTORY_GP_B1_V3_MIGRATION_PG18_EPHEMERAL"
HERE = Path(__file__).resolve().parent
IMAGE_ONLY = ("sudo", "-n", "-u", "mastra-ci", "env", "DOCKER_HOST=" + SOCKET, "docker")


def docker(*args, stdin=None, timeout=25, require=True):
    run = subprocess.run(
        [*IMAGE_ONLY, *args], text=True, input=stdin,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
    )
    if require and run.returncode:
        raise AssertionError(f"rootless docker {args[:2]} failed: {run.stderr[-500:]}")
    return run


def sql(container, source, db="postgres", require=True):
    return docker("exec", "-i", container, "psql", "-X", "-q", "-t", "-A",
                  "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db,
                  stdin=source, require=require)


ORIGINAL = """
CREATE TABLE factory_gp_pg_handover_revocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id text NOT NULL, factory_project_id text NOT NULL,
 lease_intent_id text NOT NULL UNIQUE, writer_owner_id text NOT NULL,
 owner_epoch text NOT NULL, created_at timestamptz NOT NULL
);
"""


def verify(container):
    assert sql(container, "SELECT current_setting('server_version_num');").stdout.strip().startswith("180")
    up = (HERE / "GP-B1-V3-PROPOSED-UP.sql").read_text()
    down = (HERE / "GP-B1-V3-PROPOSED-DOWN.sql").read_text()
    sql(container, ORIGINAL)
    sql(container, up)
    oid = str(uuid.uuid4())
    project = str(uuid.uuid4())
    lease = str(uuid.uuid4())
    writer = str(uuid.uuid4())
    revoke = str(uuid.uuid4())
    sql(container, f"""INSERT INTO factory_gp_pg_handover_revocations
       (id,org_id,factory_project_id,lease_intent_id,writer_owner_id,owner_epoch,created_at)
       VALUES ('{oid}','org','{project}','{lease}','{writer}','epoch',clock_timestamp());""")
    invalid = sql(container, f"""INSERT INTO factory_gp_pg_b1_v3_tombstones
      (org_id,factory_project_id,lease_intent_id,old_writer_owner_id,owner_epoch,
       original_revocation_row_id,revoke_request_id,pg_epoch_revision,
       pg_committed_at_ms,tombstone_sha256,created_at)
      VALUES ('org','{project}','{str(uuid.uuid4())}','{writer}','epoch',
      '{oid}','{str(uuid.uuid4())}',1,1762704000000,'{'e'*64}',clock_timestamp());""",
      require=False)
    assert invalid.returncode != 0, "cross-scope original FK must reject"
    sql(container, f"""INSERT INTO factory_gp_pg_b1_v3_tombstones
      (org_id,factory_project_id,lease_intent_id,old_writer_owner_id,owner_epoch,
       original_revocation_row_id,revoke_request_id,pg_epoch_revision,
       pg_committed_at_ms,tombstone_sha256,created_at)
      VALUES ('org','{project}','{lease}','{writer}','epoch',
      '{oid}','{revoke}',1,1762704000000,'{'a'*64}',clock_timestamp());""")
    assert sql(container, "SELECT count(*) FROM factory_gp_pg_b1_v3_tombstones;").stdout.strip() == "1"
    for statement in (
        "UPDATE factory_gp_pg_handover_revocations SET owner_epoch='forged';",
        "DELETE FROM factory_gp_pg_b1_v3_tombstones;",
    ):
        assert sql(container, statement, require=False).returncode != 0
    assert sql(container, down, require=False).returncode != 0, "nonempty ledger rollback must fail"
    assert sql(container, "SELECT count(*) FROM factory_gp_pg_b1_v3_tombstones;").stdout.strip() == "1"
    docker("restart", "-t", "2", container)
    for _ in range(50):
        if sql(container, "SELECT 1;", require=False).returncode == 0:
            break
        time.sleep(.2)
    else:
        raise AssertionError("PG18 restart failed")
    assert sql(container, "SELECT count(*) FROM factory_gp_pg_b1_v3_tombstones;").stdout.strip() == "1"
    # Verify the actual down transaction on a *separate empty database*.
    sql(container, "CREATE DATABASE gp_b1_v3_empty_rollback;")
    sql(container, ORIGINAL, db="gp_b1_v3_empty_rollback")
    sql(container, up, db="gp_b1_v3_empty_rollback")
    sql(container, down, db="gp_b1_v3_empty_rollback")
    after = sql(container, "SELECT to_regclass('factory_gp_pg_b1_v3_tombstones') IS NULL;",
                db="gp_b1_v3_empty_rollback").stdout.strip()
    assert after == "t", f"empty rollback must remove extension tables, got {after!r}"
    assert sql(container, "SELECT to_regclass('factory_gp_pg_handover_revocations') IS NOT NULL;",
               db="gp_b1_v3_empty_rollback").stdout.strip() == "t"
    print("PASS: PG18 raw proposed UP/FK/append-only/restart/rollback-deny/empty-DOWN")
    print("NOT PROVEN: actual Factory StorageOps schema integration, live GP or PM authority")


def main():
    if os.environ.get(ENABLED) != "I_ACK_SOURCE_ONLY_EPHEMERAL":
        raise SystemExit("DENIED: explicit isolated-migration test opt-in missing")
    if os.geteuid() == 0:
        raise SystemExit("DENIED: do not run orchestrator as root")
    info = docker("info", "--format", "{{.SecurityOptions}}").stdout
    assert "rootless" in info, "DENIED: only UID995 rootless Docker allowed"
    assert docker("image", "inspect", IMAGE, "--format", "{{.Id}}",
                  require=False).returncode == 0, "pinned PG18 image must be cached"
    manifest = __import__("json").loads((HERE / "GP-B1-V3-PROPOSED-MANIFEST.json").read_text())
    for file_key, sha_key in (("upFile", "upSha256"), ("downFile", "downSha256")):
        assert hashlib.sha256((HERE / manifest[file_key]).read_bytes()).hexdigest() == manifest[sha_key]
    name = "factory-gp-b1-v3-mig-" + uuid.uuid4().hex[:16]
    try:
        docker("run", "--pull", "never", "--rm", "-d", "--name", name,
               "--network", "none", "--memory", "512m", "--pids-limit", "100",
               "--cpus", "1", "--security-opt", "no-new-privileges",
               "--user", "999:999", "-e", "PGDATA=/tmp/pgdata",
               "-e", "POSTGRES_PASSWORD=" + secrets.token_urlsafe(32), IMAGE)
        for _ in range(50):
            complete = "PostgreSQL init process complete" in docker("logs", name).stdout
            if complete and sql(name, "SELECT 1;", require=False).returncode == 0:
                break
            time.sleep(.2)
        else:
            raise AssertionError("PG18 initialization not ready")
        verify(name)
    finally:
        gone = docker("rm", "-f", name, require=False)
        if gone.returncode and "No such container" not in gone.stderr:
            raise AssertionError("FAILED TO CLEANUP isolated migration container")
        check = docker("ps", "-a", "--format", "{{.Names}}", "--filter", f"name={name}")
        if name in check.stdout.splitlines():
            raise AssertionError("FAILED TO CLEANUP lingering isolated container")
        print("CLEANUP: isolated rootless migration container absent")


if __name__ == "__main__":
    main()
