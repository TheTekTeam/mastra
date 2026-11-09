#!/usr/bin/env python3
"""Fail closed on byte drift in the uninstalled proposed PG18 migration pair."""
import hashlib
import json
from pathlib import Path

folder = Path(__file__).resolve().parent
manifest = json.loads((folder / "GP-B1-V3-PROPOSED-MANIFEST.json").read_text())
assert manifest["status"] == "uninstalled-source-only-proposal"
for key, sha in (
    ("upFile", "upSha256"),
    ("downFile", "downSha256"),
):
    filename = manifest[key]
    assert filename in (
        "GP-B1-V3-PROPOSED-UP.sql",
        "GP-B1-V3-PROPOSED-DOWN.sql",
    )
    content = (folder / filename).read_bytes()
    actual = hashlib.sha256(content).hexdigest()
    if actual != manifest[sha]:
        raise SystemExit(f"FAIL: source byte hash drift for {filename}")
print("PASS: exact UP/DOWN SHA256 match pinned uninstalled migration manifest")
