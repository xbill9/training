# Partner Skills MCP server

A stdio [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes this project's partner training data and CLI as tools, so an assistant
can answer "what do I still owe?" and run a scan without shelling out by hand.

It is a thin, opinionated wrapper: the Node CLI still owns every write, the
Markdown trackers are still the database, and the ranking is still
`src/next-up.js`.

Every tool name is prefixed `partner_`, so this server can be registered
alongside a public `skills.google` server and alongside this repo's own Node MCP
server (`src/mcp-server.js`, tools `training_summary`, `next_up`, …) without a
collision.

## Install

Python >= 3.10, into the system environment (no virtualenv — see `../CLAUDE.md`):

```bash
pip install --user -r mcp-server/requirements.txt
```

Register it with Claude Code:

```bash
claude mcp add partner-skills -- python3 /home/xbill/training/mcp-server/server.py
```

Or, for any client that reads an `mcpServers` block:

```json
{
  "mcpServers": {
    "partner-skills": {
      "command": "python3",
      "args": ["/home/xbill/training/mcp-server/server.py"]
    }
  }
}
```

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PARTNER_SKILLS_REPO` | the repository this file lives in | Where the CLI and trackers are |
| `PARTNER_SKILLS_NODE` | `node` | Node binary used to run the CLI |
| `PARTNER_SKILLS_JOB_DIR` | `<repo>/.mcp-jobs` | Where job logs are written |

## Tools

### Read — instant, no browser, no network

These parse `paths.md`, `activities.md` and `completions.md`. They are the right
answer to almost every question.

| Tool | Answers |
| --- | --- |
| `partner_tracker_summary` | Path/activity/course counts, blocked count, and how stale each tracker is |
| `partner_next_up` | Ranked work: `quick_wins`, `leverage`, `stalled`, `blocked`, `near_miss` |
| `partner_list_paths` | Paths, filtered by status (`finished`, `open`, `outstanding`, `unknown`, …) or title |
| `partner_get_path` | One path and every activity inside it |
| `partner_list_activities` | Activities, defaulting to outstanding work |
| `partner_list_courses` | DRI portal courses from `completions.md` |
| `partner_validate_url` | Whether a URL is Partner Skills, public, or neither — and the fetchable form |
| `partner_session_health` | Browser-profile presence, age, and any Chromium lock (metadata only) |

`partner_next_up` does not rank anything itself: it runs `worklist.mjs`, which
calls the CLI's own `buildWorklist`. So the tool and `next-up.md` cannot
disagree.

### Act — runs the CLI, returns a job handle

| Tool | Runs | Browser |
| --- | --- | --- |
| `partner_scan_paths` | `paths-scan` → `paths.md` + `activities.md` + `next-up.md` | yes |
| `partner_discover_paths` | `paths-scrape` → `paths.json` | yes |
| `partner_scan_courses` | `scan` → `completions.md` | yes |
| `partner_scrape_portal` | `scrape` → `courses.json` | yes |
| `partner_import_scan_json` | `paths-import <file>` | no |
| `partner_refresh_next_up` | `worklist.mjs --write` → `next-up.md` | no |
| `partner_run_tests` | `node --test` | no |
| `partner_auth_help` | nothing — explains how to sign in | — |

Scans take minutes; a link-verification pass adds ~30s per lab, because Google
provisions an environment before answering. So each action starts a background
job, waits up to `wait_seconds` (default 60), and then hands back a `job_id`;
poll it with `partner_job_status`, read output with `partner_job_log`, stop it
with `partner_cancel_job`, and see recent runs with `partner_list_jobs`. Scope a
scan while iterating: `path_id="12"`, `course_id="1722"`, `limit=5`.

## What the server refuses to do

- **Run `auth`.** It opens two windows a human has to sign in to and then blocks
  on an Enter prompt. `partner_auth_help` explains the alternatives, including
  the browser-capture route that needs no Playwright session at all.
- **Accept public URLs.** `skills.google` is a separate catalog with its own ID
  namespace, so rewriting it to the partner host relabels public content as
  partner content. `partner_validate_url` says so explicitly instead of
  returning a bare false.
- **Hand back a path-scoped activity URL.** `/paths/70/course_templates/822`
  always answers 403; read tools return `fetch_url` in the form that works.
- **Run two browser jobs at once.** They share one Chromium profile directory
  and deadlock on its lock.
- **Read session files.** `partner_session_health` reports names, times and lock
  owners; the profiles themselves are live logins and are never opened or
  printed.

Exit code 2 from the CLI means "something is outstanding" — a result, not a
failure. Jobs report it as `completed_with_outstanding`.

## Tests

```bash
python3 -m unittest discover -s mcp-server -t mcp-server
```

The parsers, the partner-only URL rule, the activity-URL canonicalization and
the profile-lock logic are covered; they mirror `src/paths-db.js`,
`src/course-links.js` and `src/profile-lock.js`, so a drift in either direction
should fail here. The Node suite (`npm test`) is separate and unaffected.
