"""Read the Markdown trackers that are this project's database.

``paths.md``, ``activities.md`` and ``completions.md`` are written by the Node
CLI and are the source of truth. Everything here is read-only: the parsers
mirror ``src/paths-db.js`` and ``src/markdown-db.js`` exactly — including their
escaped-pipe row splitting and escaped-bracket labels — so a row this server
reports always means what the CLI meant when it wrote it. Writing is left to the
CLI, which owns the append-and-merge rules (nothing seen before is dropped, and
an inconclusive check never downgrades a definitive status).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from links import path_id as path_id_from_url

# Mirrors PATH_ICONS / ACTIVITY_ICONS in src/path-status.js and COURSE_ICONS in
# src/markdown-db.js.
PATH_ICONS = {"FINISHED": "✅", "OPEN": "🔄", "NOT STARTED": "⬜", "UNKNOWN": "❔"}
ACTIVITY_ICONS = {
    "COMPLETED": "✅",
    "IN PROGRESS": "🔄",
    "NOT STARTED": "❌",
    "MISSING": "⚠️",
    "UNKNOWN": "❔",
}
COURSE_ICONS = {"COMPLETED": "✅", "NOT COMPLETED": "❌", "UNKNOWN": "❔"}

_LINK = re.compile(r"^\[(.*)\]\((\S+)\)$")


def split_row(line: str) -> list[str] | None:
    """Split a Markdown table row on unescaped pipes.

    Course titles legitimately contain ``|``; the CLI escapes those as ``\\|``
    when it renders a row, so a naive ``split("|")`` would tear such a row in
    half and silently mis-file it.
    """
    trimmed = line.strip()
    if not trimmed.startswith("|"):
        return None
    cells: list[str] = []
    current = ""
    index = 1
    while index < len(trimmed):
        char = trimmed[index]
        if char == "\\" and index + 1 < len(trimmed) and trimmed[index + 1] == "|":
            current += "|"
            index += 2
            continue
        if char == "|":
            cells.append(current.strip())
            current = ""
            index += 1
            continue
        current += char
        index += 1
    if current.strip():
        cells.append(current.strip())
    return cells


def parse_link(cell: str) -> tuple[str, str]:
    """Split a ``[label](url)`` cell, unescaping the label either way.

    Unlinked cells are escaped too, so they must be unescaped too — that is the
    bug that grew a backslash per run on names like ``[DEPRECATED] Foo``.
    """
    text = str(cell)
    match = _LINK.match(text)
    if not match:
        return text.replace("\\[", "[").replace("\\]", "]"), ""
    return match.group(1).replace("\\[", "[").replace("\\]", "]"), match.group(2)


def _status_from_label(label: str, icons: dict[str, str], fallback: str) -> str:
    text = str(label or "")
    for status, icon in icons.items():
        if icon in text and status in text:
            return status
    # Icons alone are enough: a hand-edited cell may have lost the word.
    for status, icon in icons.items():
        if icon in text:
            return status
    return fallback


def _percent(cell: str) -> float | None:
    text = str(cell).strip()
    if not text or text == "—":
        return None
    match = re.match(r"(\d+)", text)
    return int(match.group(1)) / 100 if match else None


def parse_paths_markdown(markdown: str) -> list[dict]:
    records = []
    for line in str(markdown).split("\n"):
        cells = split_row(line)
        if not cells or len(cells) < 6:
            continue
        title, url = parse_link(cells[0])
        identifier = path_id_from_url(url)
        if not identifier:
            continue
        done, _, total = cells[3].partition("/")
        records.append({
            "id": identifier,
            "title": title,
            "url": url,
            "status": _status_from_label(cells[1], PATH_ICONS, "UNKNOWN"),
            "progress": _percent(cells[2]),
            "done": int(done) if done.strip().isdigit() else 0,
            "total": int(total) if total.strip().isdigit() else 0,
            "issue": cells[4],
            "checked_at": cells[5],
        })
    return records


def parse_activities_markdown(markdown: str) -> list[dict]:
    records = []
    for line in str(markdown).split("\n"):
        cells = split_row(line)
        if not cells or len(cells) < 7:
            continue
        name, url = parse_link(cells[0])
        path_title, path_url = parse_link(cells[2])
        identifier = path_id_from_url(path_url)
        if not identifier:
            continue
        records.append({
            "name": name,
            "url": url,
            "type": cells[1],
            "path_id": identifier,
            "path_title": path_title,
            "path_url": path_url,
            "status": _status_from_label(cells[3], ACTIVITY_ICONS, "UNKNOWN"),
            "issue": cells[4],
            "duration": cells[5],
            "checked_at": cells[6],
        })
    return records


def parse_completions_markdown(markdown: str) -> list[dict]:
    records = []
    for line in str(markdown).split("\n"):
        cells = split_row(line)
        if not cells or len(cells) < 4:
            continue
        course, url = parse_link(cells[0])
        if not url.startswith("https://"):
            continue
        records.append({
            "course": course,
            "url": url,
            "status": _status_from_label(cells[1], COURSE_ICONS, "UNKNOWN"),
            "evidence": cells[2],
            "checked_at": cells[3],
        })
    return records


# ------------------------------------------------------------------ filters

# Friendly aliases, so a caller can ask for "outstanding" without knowing the
# exact vocabulary each tracker uses.
PATH_ALIASES = {
    "finished": ["FINISHED"],
    "complete": ["FINISHED"],
    "completed": ["FINISHED"],
    "open": ["OPEN"],
    "in progress": ["OPEN"],
    "not started": ["NOT STARTED"],
    "unknown": ["UNKNOWN"],
    "outstanding": ["OPEN", "NOT STARTED"],
    "all": [],
}
ACTIVITY_ALIASES = {
    "completed": ["COMPLETED"],
    "complete": ["COMPLETED"],
    "in progress": ["IN PROGRESS"],
    "stalled": ["IN PROGRESS"],
    "not started": ["NOT STARTED"],
    "missing": ["MISSING"],
    "unknown": ["UNKNOWN"],
    "outstanding": ["IN PROGRESS", "NOT STARTED", "MISSING", "UNKNOWN"],
    "needs attention": ["IN PROGRESS", "MISSING", "UNKNOWN"],
    "all": [],
}
COURSE_ALIASES = {
    "completed": ["COMPLETED"],
    "complete": ["COMPLETED"],
    "not completed": ["NOT COMPLETED"],
    "outstanding": ["NOT COMPLETED"],
    "unknown": ["UNKNOWN"],
    "all": [],
}


def resolve_status(value: str | None, aliases: dict[str, list[str]]) -> list[str]:
    """Turn a status filter into the concrete statuses it selects.

    ``None`` means no filter. An unrecognised value is an error rather than a
    silent empty result, which would read as "nothing outstanding".
    """
    if value is None:
        return []
    key = str(value).strip().lower()
    if key in aliases:
        return list(aliases[key])
    upper = str(value).strip().upper()
    known = {status for statuses in aliases.values() for status in statuses}
    if upper in known:
        return [upper]
    raise ValueError(
        f"Unknown status {value!r}. Try one of: {', '.join(sorted(aliases))}."
    )


def matches(record: dict, query: str | None, fields: tuple[str, ...]) -> bool:
    if not query:
        return True
    needle = query.strip().lower()
    return any(needle in str(record.get(field, "")).lower() for field in fields)


def is_blocked(record: dict) -> bool:
    """An access-denied activity: verified 403, so studying will not clear it."""
    return bool(re.search(r"access denied", str(record.get("issue", "")), re.IGNORECASE))


# ------------------------------------------------------------------ loading


@dataclass
class Trackers:
    """A snapshot of the three Markdown trackers."""

    root: Path
    paths: list[dict] = field(default_factory=list)
    activities: list[dict] = field(default_factory=list)
    courses: list[dict] = field(default_factory=list)
    files: dict[str, dict] = field(default_factory=dict)

    @property
    def outstanding_activities(self) -> list[dict]:
        return [a for a in self.activities if a["status"] != "COMPLETED"]

    @property
    def blocked_activities(self) -> list[dict]:
        return [a for a in self.activities if is_blocked(a)]

    @property
    def outstanding_courses(self) -> list[dict]:
        return [c for c in self.courses if c["status"] == "NOT COMPLETED"]


def _file_info(path: Path) -> dict:
    if not path.exists():
        return {"path": str(path), "exists": False}
    stat = path.stat()
    modified = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
    age = datetime.now(timezone.utc) - modified
    return {
        "path": str(path),
        "exists": True,
        "modified": modified.isoformat(timespec="seconds"),
        "age_days": round(age.total_seconds() / 86400, 1),
        "bytes": stat.st_size,
    }


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def load_trackers(root: Path) -> Trackers:
    paths_file = root / "paths.md"
    activities_file = root / "activities.md"
    completions_file = root / "completions.md"
    return Trackers(
        root=root,
        paths=parse_paths_markdown(_read(paths_file)),
        activities=parse_activities_markdown(_read(activities_file)),
        courses=parse_completions_markdown(_read(completions_file)),
        files={
            "paths.md": _file_info(paths_file),
            "activities.md": _file_info(activities_file),
            "completions.md": _file_info(completions_file),
            "next-up.md": _file_info(root / "next-up.md"),
        },
    )


def counts(records: list[dict], key: str = "status") -> dict[str, int]:
    tally: dict[str, int] = {}
    for record in records:
        tally[record[key]] = tally.get(record[key], 0) + 1
    return dict(sorted(tally.items()))


def parse_duration_minutes(text: str) -> int:
    """Minutes from a duration cell like "1 hour 30 minutes". Mirrors src/next-up.js."""
    raw = str(text or "")
    hours = re.search(r"(\d+)\s*hour", raw, re.IGNORECASE)
    minutes = re.search(r"(\d+)\s*minute", raw, re.IGNORECASE)
    return (int(hours.group(1)) * 60 if hours else 0) + (int(minutes.group(1)) if minutes else 0)
