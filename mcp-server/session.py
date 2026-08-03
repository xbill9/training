"""Report on the browser profiles without ever reading what is inside them.

``.browser-profile-skills/`` and ``.browser-profile-readiness/`` are live logins,
including ``skills-storage-state.json``. This module looks at directory metadata
only — existence, modification times, and Chromium's ``SingletonLock`` symlink —
and never opens a cookie jar or a storage state file. Lock parsing mirrors
``src/profile-lock.js``: a lock is stale only when it belongs to this machine and
its process is gone, because stealing a lock from a live browser (or from another
host sharing the directory) corrupts the profile.
"""

from __future__ import annotations

import os
import re
import socket
from datetime import datetime, timezone
from pathlib import Path

PROFILE_DIRS = (
    (".browser-profile-skills", "Partner Skills"),
    (".browser-profile-readiness", "Delivery Readiness Portal"),
)

_LOCK_TARGET = re.compile(r"^(.*)-(\d+)$")


def parse_lock_target(target: str) -> dict | None:
    match = _LOCK_TARGET.match(str(target or ""))
    if not match:
        return None
    return {"host": match.group(1), "pid": int(match.group(2))}


def process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)  # Signal 0 checks existence and permission without signalling.
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def is_stale_lock(target: str, *, host: str | None = None, alive=process_is_alive) -> bool:
    parsed = parse_lock_target(target)
    if not parsed:
        return False
    if parsed["host"] != (host or socket.gethostname()):
        return False
    return not alive(parsed["pid"])


def _age_days(moment: datetime) -> float:
    return round((datetime.now(timezone.utc) - moment).total_seconds() / 86400, 1)


def _mtime(path: Path) -> dict | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
    return {"modified": modified.isoformat(timespec="seconds"), "age_days": _age_days(modified)}


def profile_report(root: Path) -> dict:
    profiles = []
    for name, label in PROFILE_DIRS:
        directory = root / name
        entry: dict = {"profile": name, "role": label, "exists": directory.is_dir()}
        if not entry["exists"]:
            profiles.append(entry)
            continue

        entry.update(_mtime(directory) or {})
        # The storage state's mtime is the best non-invasive proxy for "when was
        # this session last written". Its contents are secret and never read.
        state = directory / "skills-storage-state.json"
        if state.exists():
            entry["storage_state"] = {"present": True, **(_mtime(state) or {})}
        else:
            entry["storage_state"] = {"present": False}

        lock = directory / "SingletonLock"
        try:
            target = os.readlink(lock)
        except OSError:
            target = None
        if target is None:
            entry["lock"] = {"present": False}
        else:
            parsed = parse_lock_target(target) or {}
            stale = is_stale_lock(target)
            entry["lock"] = {
                "present": True,
                "owner": target,
                "pid": parsed.get("pid"),
                "stale": stale,
                "note": (
                    "Stale lock from a killed browser. The CLI clears this itself "
                    "before launching, so no action is needed."
                    if stale
                    else "A browser is holding this profile. Close it before scanning."
                ),
            }
        profiles.append(entry)

    return {
        "host": socket.gethostname(),
        "profiles": profiles,
        "note": (
            "Session freshness cannot be confirmed without opening a browser. If a "
            "scan stalls on a sign-in page, the stored session has expired: ask the "
            "user to run `npm run auth` themselves (it blocks on an interactive "
            "prompt), or capture a scan from a signed-in Chrome tab "
            "(docs/chrome-scan.md) and import it with partner_import_scan_json."
        ),
    }
