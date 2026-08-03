#!/usr/bin/env python3
"""Partner Skills training assistant — MCP stdio server.

Wraps the ``dri-course-checker`` Node CLI and its Markdown trackers so an
assistant can answer "what partner training do I still owe?" without shelling out
by hand.

Two kinds of tool live here:

* **Read tools** parse ``paths.md`` / ``activities.md`` / ``completions.md``.
  They are instant, touch no network, and are the right answer to almost every
  question.
* **Action tools** run the CLI. They drive a real browser against Google's
  servers, take minutes, and return a job handle you poll.

Every tool name is prefixed ``partner_`` so this server can be registered
alongside the public ``skills.google`` server and the repo's own Node MCP server
(``src/mcp-server.js``) without a name collision.

House rules this server enforces:

* Partner ``partner.skills.google`` only. The public catalog is a separate ID
  namespace and is rejected, never rewritten (see ``links.py``).
* ``auth`` is never run for you — it needs a human at the keyboard.
* One browser job at a time; concurrent Playwright runs deadlock on the shared
  Chromium profile lock.
* Exit code 2 means "something is outstanding", which is a result, not a
  failure.
* Ranking is never re-implemented here: ``partner_next_up`` runs the CLI's own
  ``src/next-up.js`` through ``worklist.mjs``, so it cannot disagree with
  ``next-up.md``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp.server.fastmcp import FastMCP  # noqa: E402

import trackers as tracker_lib  # noqa: E402
from jobs import EXIT_MEANING, JobError, JobRegistry  # noqa: E402
from links import canonical_activity_url, classify_url  # noqa: E402
from session import profile_report  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO = Path(os.environ.get("PARTNER_SKILLS_REPO", HERE.parent)).resolve()
NODE = os.environ.get("PARTNER_SKILLS_NODE", "node")
JOB_DIR = Path(os.environ.get("PARTNER_SKILLS_JOB_DIR", REPO / ".mcp-jobs")).resolve()

DEFAULT_WAIT = 60.0
SCAN_TIMEOUT = 3600
QUICK_TIMEOUT = 600

if not (REPO / "src" / "cli.js").exists():
    raise SystemExit(
        f"{REPO} does not look like the dri-course-checker repository "
        "(no src/cli.js). Set PARTNER_SKILLS_REPO to its path."
    )

mcp = FastMCP("partner-skills")
registry = JobRegistry(cwd=REPO, log_dir=JOB_DIR)


# ---------------------------------------------------------------- helpers


def _load() -> tracker_lib.Trackers:
    return tracker_lib.load_trackers(REPO)


def _cli(*args: str) -> list[str]:
    return [NODE, str(REPO / "src" / "cli.js"), *args]


def _page(records: list[dict], limit: int, offset: int) -> dict:
    window = records[offset: offset + limit] if limit else records[offset:]
    return {"total_matching": len(records), "returned": len(window), "offset": offset, "items": window}


def _launch(
    label: str,
    steps: list[list[str]],
    *,
    uses_browser: bool,
    wait_seconds: float,
    timeout_s: int,
    env: dict[str, str] | None = None,
    note: str | None = None,
) -> dict:
    try:
        job = registry.start(label, steps, uses_browser=uses_browser, timeout_s=timeout_s, env=env)
    except JobError as error:
        return {"started": False, "error": str(error)}
    finished = registry.wait(job, wait_seconds)
    result = {"started": True, "finished": finished, **registry.describe(job)}
    if not finished:
        result["hint"] = (
            f"Still running. Poll with partner_job_status(job_id='{job.id}') or read "
            f"more output with partner_job_log(job_id='{job.id}')."
        )
    elif job.exit_code == 2:
        result["hint"] = "Exit 2 is the CLI saying work is outstanding — not an error."
    if note:
        result["note"] = note
    return result


# ------------------------------------------------------------- read tools


@mcp.tool()
def partner_tracker_summary() -> dict[str, Any]:
    """Overall partner training status: path, activity and course counts plus tracker freshness.

    Start here. Reads the Markdown trackers only — instant, no browser.
    """
    data = _load()
    blocked = data.blocked_activities
    return {
        "repository": str(REPO),
        "catalog": "partner.skills.google only",
        "paths": {
            "tracked": len(data.paths),
            "by_status": tracker_lib.counts(data.paths),
            "with_issues": sum(1 for p in data.paths if p["issue"]),
        },
        "activities": {
            "tracked": len(data.activities),
            "by_status": tracker_lib.counts(data.activities),
            "outstanding": len(data.outstanding_activities),
            "blocked": len(blocked),
            "blocked_paths": len({item["path_id"] for item in blocked}),
        },
        "courses": {
            "tracked": len(data.courses),
            "by_status": tracker_lib.counts(data.courses),
            "outstanding": len(data.outstanding_courses),
        },
        "files": data.files,
        "note": (
            "Blocked activities are a verified 403: the content exists but this "
            "account is not entitled to it. They are an access request, not study, "
            "and no amount of work clears them. Rows marked UNKNOWN could not be "
            "read; they are never counted as complete and never dropped."
        ),
    }


@mcp.tool()
def partner_next_up(limit: int = 10, section: str | None = None) -> dict[str, Any]:
    """The short answer to "what partner training should I do next?".

    Ranked by the CLI's own ``src/next-up.js``, so it cannot disagree with
    next-up.md. Sections: quick_wins (finishes a path outright, cheapest time per
    path completed), leverage (one activity shared across 3+ paths), stalled
    (already part-finished), blocked (access denied — an access request, not
    study), near_miss (paths within 2 activities of done). Reads nothing from the
    network; use partner_refresh_next_up to rewrite next-up.md on disk.
    """
    sections = ("quick_wins", "leverage", "stalled", "blocked", "near_miss")
    if section and section not in sections:
        return {"error": f"Unknown section {section!r}. Try one of: {', '.join(sections)}."}
    try:
        completed = subprocess.run(
            [NODE, str(HERE / "worklist.mjs"), "--limit", str(max(1, limit))],
            cwd=REPO, capture_output=True, text=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {"error": f"Could not run the worklist ({NODE} worklist.mjs): {error}"}
    # 2 is "something is outstanding" — the normal answer, not a failure.
    if completed.returncode not in (0, 2):
        return {"error": completed.stderr.strip() or f"worklist.mjs exited {completed.returncode}"}
    work = json.loads(completed.stdout)
    if section:
        return {"section": section, "outstanding_activities": work["outstanding_activities"], **work[section]}
    return work


@mcp.tool()
def partner_list_paths(
    status: str | None = None,
    query: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """List learning paths from paths.md.

    status: finished | open | not started | unknown | outstanding | all
    query: case-insensitive substring of the path title.
    """
    data = _load()
    wanted = tracker_lib.resolve_status(status, tracker_lib.PATH_ALIASES)
    matched = [
        path for path in data.paths
        if (not wanted or path["status"] in wanted) and tracker_lib.matches(path, query, ("title",))
    ]
    return {"status_filter": wanted or "all", **_page(matched, limit, offset)}


@mcp.tool()
def partner_get_path(path_id: str) -> dict[str, Any]:
    """One learning path with every activity recorded inside it.

    path_id is the number in the path URL, e.g. 4023 for /paths/4023. Activity
    URLs come back in the form Google actually answers, not the path-scoped form
    that always 403s.
    """
    data = _load()
    identifier = str(path_id).strip()
    path = next((item for item in data.paths if item["id"] == identifier), None)
    if not path:
        return {
            "found": False,
            "path_id": identifier,
            "error": f"No path {identifier} in paths.md. Use partner_list_paths to browse, "
                     "or partner_discover_paths to re-read the catalog.",
        }
    activities = [
        {**item, "fetch_url": canonical_activity_url(item["url"], identifier)}
        for item in data.activities if item["path_id"] == identifier
    ]
    return {
        "found": True,
        "path": path,
        "activities": activities,
        "outstanding": [item for item in activities if item["status"] != "COMPLETED"],
    }


@mcp.tool()
def partner_list_activities(
    status: str | None = "outstanding",
    path_id: str | None = None,
    query: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """List activities inside learning paths, from activities.md.

    Defaults to outstanding work. status: completed | in progress | not started |
    missing | unknown | outstanding | needs attention | all. The same course
    appears in several paths, so a name can legitimately match more than once.
    """
    data = _load()
    wanted = tracker_lib.resolve_status(status, tracker_lib.ACTIVITY_ALIASES)
    matched = [
        {**activity, "fetch_url": canonical_activity_url(activity["url"], activity["path_id"])}
        for activity in data.activities
        if (not wanted or activity["status"] in wanted)
        and (not path_id or activity["path_id"] == str(path_id).strip())
        and tracker_lib.matches(activity, query, ("name", "path_title", "type"))
    ]
    return {"status_filter": wanted or "all", **_page(matched, limit, offset)}


@mcp.tool()
def partner_list_courses(
    status: str | None = "outstanding",
    query: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """List the Delivery Readiness Portal courses tracked in completions.md.

    These are the courses linked from the DRI portal, checked on Partner Skills —
    a different list from the activities inside learning paths.
    status: completed | not completed | unknown | outstanding | all.
    """
    data = _load()
    wanted = tracker_lib.resolve_status(status, tracker_lib.COURSE_ALIASES)
    matched = [
        course for course in data.courses
        if (not wanted or course["status"] in wanted)
        and tracker_lib.matches(course, query, ("course", "url"))
    ]
    return {"status_filter": wanted or "all", **_page(matched, limit, offset)}


@mcp.tool()
def partner_validate_url(url: str) -> dict[str, Any]:
    """Check whether a URL belongs to the Partner Skills catalog this project tracks.

    The public skills.google catalog is a separate catalog with its own ID
    namespace: the same /course_templates/1090 is a different course there.
    Public URLs are rejected rather than rewritten, because rewriting relabels
    public content as partner content and corrupts the trackers. For an activity
    URL this also returns the fetchable form — the path-scoped form Google prints
    on a path page always answers 403.
    """
    return classify_url(url)


@mcp.tool()
def partner_session_health() -> dict[str, Any]:
    """Report on the saved browser profiles: presence, age, and any Chromium lock.

    Metadata only — session files are live logins and are never read or printed.
    """
    return profile_report(REPO)


# ----------------------------------------------------------- action tools


@mcp.tool()
def partner_scan_paths(
    path_id: str | None = None,
    limit: int = 0,
    offset: int = 0,
    verify_links: bool = False,
    headless: bool = False,
    wait_seconds: float = DEFAULT_WAIT,
) -> dict[str, Any]:
    """Re-read cached learning paths in a browser and update paths.md + activities.md.

    Slow: it hits Google's servers per path, and verify_links adds ~30s per lab
    because Google provisions an environment before answering. Scope it while
    iterating — path_id='12' for one path, or limit=5. headless is opt-in because
    Google often rejects a perfectly good session when the browser says it is
    headless. Needs a signed-in profile (see partner_session_health /
    partner_auth_help).
    """
    args = ["paths-scan"]
    if path_id:
        args += ["--path-id", str(path_id).strip()]
    if limit:
        args += ["--limit", str(limit)]
    if offset:
        args += ["--offset", str(offset)]
    if verify_links:
        args.append("--verify-links")
    if headless:
        args.append("--headless")
    return _launch(
        "paths-scan",
        [_cli(*args)],
        uses_browser=True,
        wait_seconds=wait_seconds,
        timeout_s=SCAN_TIMEOUT,
        note=(
            "Trackers are merged, never overwritten, and next-up.md is rewritten in "
            "the same run. Read the result with partner_tracker_summary or partner_next_up."
        ),
    )


@mcp.tool()
def partner_discover_paths(
    max_pages: int = 50,
    headless: bool = False,
    wait_seconds: float = DEFAULT_WAIT,
) -> dict[str, Any]:
    """Walk the Partner Skills catalog for learning paths and merge them into paths.json.

    Discovery only — it finds paths, it does not read their status. Follow with
    partner_scan_paths.
    """
    args = ["paths-scrape", "--max-pages", str(max_pages)]
    if headless:
        args.append("--headless")
    return _launch(
        "paths-scrape",
        [_cli(*args)],
        uses_browser=True,
        wait_seconds=wait_seconds,
        timeout_s=SCAN_TIMEOUT,
    )


@mcp.tool()
def partner_scan_courses(
    course_id: str | None = None,
    limit: int = 0,
    offset: int = 0,
    headless: bool = True,
    wait_seconds: float = DEFAULT_WAIT,
) -> dict[str, Any]:
    """Check the cached DRI portal courses (courses.json) on Partner Skills and update completions.md.

    Scope it while iterating: course_id='1722', or limit=5. Exit code 2 means
    something is not complete, which is the expected result most days.
    """
    args = ["scan"]
    if course_id:
        args += ["--course-id", str(course_id).strip()]
    if limit:
        args += ["--limit", str(limit)]
    if offset:
        args += ["--offset", str(offset)]
    if not headless:
        args.append("--no-headless")
    return _launch(
        "scan",
        [_cli(*args)],
        uses_browser=True,
        wait_seconds=wait_seconds,
        timeout_s=SCAN_TIMEOUT,
    )


@mcp.tool()
def partner_scrape_portal(
    portal_url: str | None = None,
    tab: str = "LABS",
    headless: bool = False,
    wait_seconds: float = DEFAULT_WAIT,
) -> dict[str, Any]:
    """Collect course links from the Delivery Readiness Portal and merge them into courses.json.

    Uses the separate readiness browser profile. Links on the public Skills hosts
    are dropped during normalization, by design.
    """
    if portal_url:
        verdict = classify_url(portal_url)
        if verdict["verdict"] == "public":
            return {"started": False, "error": verdict["reason"]}
    args = ["scrape", "--tab", tab]
    if portal_url:
        args += ["--portal-url", portal_url]
    if headless:
        args.append("--headless")
    return _launch(
        "scrape",
        [_cli(*args)],
        uses_browser=True,
        wait_seconds=wait_seconds,
        timeout_s=SCAN_TIMEOUT,
    )


@mcp.tool()
def partner_import_scan_json(file: str, wait_seconds: float = 120.0) -> dict[str, Any]:
    """Build the paths trackers from a scan JSON captured in the browser (no Playwright).

    Takes the JSON produced by the DevTools snippet in docs/chrome-scan.md — the
    route to use when the stored Playwright session has expired. Paths the
    capture could not read are recorded as UNKNOWN rather than dropped, and
    importing the same file twice does not change the row count.
    """
    target = Path(file).expanduser()
    if not target.is_absolute():
        target = REPO / target
    if not target.exists():
        return {"started": False, "error": f"No such file: {target}"}
    try:
        json.loads(target.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        return {"started": False, "error": f"{target} is not readable JSON: {error}"}
    return _launch(
        "paths-import",
        [_cli("paths-import", str(target))],
        uses_browser=False,
        wait_seconds=wait_seconds,
        timeout_s=QUICK_TIMEOUT,
    )


@mcp.tool()
def partner_refresh_next_up(wait_seconds: float = 120.0) -> dict[str, Any]:
    """Regenerate next-up.md from the trackers.

    Pure derivation from paths.md / activities.md through the CLI's own
    src/next-up.js — it reads no network. Ticked-off items in the existing
    next-up.md are preserved.
    """
    return _launch(
        "next-up",
        [[NODE, str(HERE / "worklist.mjs"), "--write"]],
        uses_browser=False,
        wait_seconds=wait_seconds,
        timeout_s=QUICK_TIMEOUT,
    )


@mcp.tool()
def partner_run_tests(wait_seconds: float = 300.0) -> dict[str, Any]:
    """Run the project's unit tests (node --test over the pure modules)."""
    return _launch(
        "tests",
        [[NODE, "--test"]],
        uses_browser=False,
        wait_seconds=wait_seconds,
        timeout_s=QUICK_TIMEOUT,
    )


@mcp.tool()
def partner_auth_help() -> dict[str, Any]:
    """How to sign in. This server will not do it for you, and that is deliberate.

    `npm run auth` opens two browser windows a human has to sign in to, and then
    blocks on an Enter prompt; nothing automated can complete it.
    """
    return {
        "can_run_here": False,
        "why": (
            "auth opens visible browsers for the Delivery Readiness Portal and "
            "Partner Skills and waits for a human to sign in, then blocks on an "
            "interactive Enter prompt. An MCP tool call cannot type a password, "
            "pass a 2FA challenge, or press Enter, so this server never starts it."
        ),
        "ask_the_user_to_run": "npm run auth",
        "where": str(REPO),
        "then": "Re-run the scan you wanted; the saved profiles are reused, headless or not.",
        "if_auth_is_inconvenient": (
            "Capture a scan from a Chrome tab that is already signed in "
            "(docs/chrome-scan.md), then call partner_import_scan_json — it needs "
            "no Playwright session at all. The chrome-extension/ directory does the "
            "course check the same way."
        ),
        "expired_session_symptom": (
            "A scan that stalls on a Google sign-in page rather than failing. That "
            "is an expired profile, not a transient error to retry around."
        ),
    }


# -------------------------------------------------------------- job tools


@mcp.tool()
def partner_list_jobs(limit: int = 20) -> dict[str, Any]:
    """Recent CLI jobs started by this server, newest first."""
    jobs = registry.all()[:limit]
    return {
        "jobs": [
            {
                "job_id": job.id,
                "label": job.label,
                "state": job.state,
                "started_at": job.started_at,
                "finished_at": job.finished_at,
                "exit_code": job.exit_code,
            }
            for job in jobs
        ],
        "exit_codes": EXIT_MEANING,
    }


@mcp.tool()
def partner_job_status(job_id: str, wait_seconds: float = 0.0) -> dict[str, Any]:
    """Check a job, optionally blocking up to wait_seconds for it to finish."""
    try:
        job = registry.get(job_id)
    except JobError as error:
        return {"error": str(error)}
    if wait_seconds:
        registry.wait(job, wait_seconds)
    return registry.describe(job)


@mcp.tool()
def partner_job_log(job_id: str, tail_lines: int = 200) -> dict[str, Any]:
    """Read the tail of a job's output log."""
    try:
        job = registry.get(job_id)
    except JobError as error:
        return {"error": str(error)}
    return {
        "job_id": job.id,
        "state": job.state,
        "log_file": str(job.log_path),
        "output": registry.tail(job, tail_lines),
    }


@mcp.tool()
def partner_cancel_job(job_id: str) -> dict[str, Any]:
    """Stop a running job and its browser.

    Safe: the trackers are only written at the end of a run, so a cancelled scan
    leaves them exactly as they were.
    """
    try:
        job = registry.cancel(job_id)
    except JobError as error:
        return {"error": str(error)}
    return registry.describe(job, tail_lines=20)


if __name__ == "__main__":
    mcp.run()
