# DRI course checker

This local CLI opens the Google Delivery Readiness Portal, extracts Google Skills for Partners course links, and reports whether each course is completed. The two sites use separate browser profiles so one site's authentication cannot disturb the other.

## Install

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm run auth
npm run check
```

Every successful run updates [`completions.md`](completions.md), a lightweight database with clickable course links, completion statuses, evidence, and check times. Courses found by earlier runs are retained.

Run `npm run auth` first. It opens separate browser windows for Partner Readiness and Partner Skills. Sign in to each, verify that the sample Skills course loads, and then press Enter in the terminal. Sessions are retained in `.browser-profile-readiness/` and `.browser-profile-skills/`; protect those directories like login sessions and never commit or share them.

Once `courses.json` has been built, routine checks do not need the Readiness Portal or its authentication:

```bash
npm run scan -- --no-headless
```

The Skills launcher explicitly reopens Chromium's managed `Profile 1`, where the work-account session is stored. Override this only if Chromium shows a different profile name:

```bash
npm run scan -- --no-headless --browser-profile "Profile 2"
```

Partner Skills uses session-only cookies. Before closing, the scanner saves them inside the ignored Skills profile directory as `skills-storage-state.json`, then explicitly restores them on the next run. Treat this file as an active login session and never share or commit it.

Useful options:

```bash
# Save a machine-readable report
npm run check -- --json results.json

# Use a different Markdown database file
npm run check -- --markdown team-training.md

# Reuse the signed-in Skills profile without opening a window
npm run check -- --headless

# Narrow extraction if the portal contains unrelated Skills links
npm run check -- --course-selector 'table a[href*="skills.google"]'

# Add a site-specific completion indicator
npm run check -- --status-selector '[data-testid="course-completed"]'
```

Exit status is `0` when every discovered course is complete, `2` when any course is incomplete or unknown, and `1` for scraper/configuration errors.

## Learning paths

The commands above track individual courses reached from the Readiness Portal. The `paths` commands track the whole Google Skills for Partners path catalog instead — every path plus the courses and labs inside it:

```bash
npm run paths
```

That does two things:

1. **Discovery** — fetches `catalog?format[]=learning_plans` (8 paths per page, ~207 paths today) and caches every path id in `paths.json`. About 15 seconds.
2. **Scan** — reads every path page and its activity cards. About 2.5 minutes.

A path page already carries the completion state of every course and lab inside it, so one page load per path covers all 1000+ activities. There is no need to open each course.

Better still, Google renders those activity cards server-side: `name`, `type`, `duration`, `completed` and `progress` are plain attributes in the HTML. So neither stage navigates — both `fetch` from inside a single authenticated page, four requests at a time. Measured against the live catalog: 207 paths and 1438 activities in about two and a half minutes, versus roughly 15 minutes when each page is opened and waited on.

Progress prints every 20 paths, so a long stage never looks like a hang. Pass `--navigate` to force the old page-by-page mode; the scanner falls back to it automatically if the markup ever stops yielding cards.

Three Markdown files are written and merged across runs:

- [`paths.md`](paths.md) — one row per path: ✅ FINISHED / 🔄 OPEN / ⬜ NOT STARTED / ❔ UNKNOWN, percent complete, and how many activities are done.
- [`activities.md`](activities.md) — one row per course or lab, with the path it belongs to: ✅ COMPLETED / ❌ NOT STARTED / 🔄 IN PROGRESS / ⚠️ MISSING / ❔ UNKNOWN.
- [`next-up.md`](next-up.md) — a ranked worklist regenerated from the other two. Because the same course sits in many paths, it groups by distinct activity and ranks by *time spent per path completed*, so the top of the list is the cheapest route to finishing paths. Sections: activities that finish a path outright, high-leverage activities shared across many paths, work already part-finished, and paths within two activities of done. Tick a `- [ ]` box and the tick survives regeneration.

A path counts as finished only when every activity inside it is complete — never from the headline percentage alone. The Progress column shows that headline percentage, which also counts progress *inside* an activity, so a path can read 40% while the Done column still says 0/2.

Three things are reported as issues:

- **🔄 started but stalled** — the activity shows partial progress (e.g. "Started but stalled at 42%").
- **❔ unreadable** — the page failed to load or Google served its error page. As in `completions.md`, an inconclusive check never overwrites a status an earlier run established.
- **⚠️ missing or retired** — an activity that a previously scanned path no longer lists. Add `--verify-links` to also fetch each outstanding activity URL and flag dead ones: `404`, `410`, Google's error page, and network failures. Activities already in progress are skipped, so no live lab sessions are touched.

  Getting this right took several wrong turns, all measured against the live site:

  **URLs must be canonicalized first.** The URLs on a path page are path-scoped, and Google refuses them to any programmatic request. `/paths/70/course_templates/822` returns `403` always; `/course_templates/822` returns the real answer. A bare `/focuses/48936` redirects to the dashboard; `/focuses/48936?parent=catalog&path=98` returns the real answer. Checking the raw URLs flags the entire catalog as broken.

  **Lab pages take ~30 seconds.** A `/focuses/` request provisions a lab environment before responding — 26–30s is normal. Verification allows 60s for labs and 20s for courses. A short timeout reports healthy labs as failures, and the aborted requests show up red in DevTools, which looks like the site is failing when it is not.

  **Google never returns 404 for missing content.** A nonexistent course answers `200` and redirects to the dashboard. Retirement is detected by that redirect, not by status code.

  **`403` is never treated as broken.** It means the account is not entitled to that content. It is also what Google returns when throttling a burst of parallel requests, which is why verification is serial.

  **A failure only counts if it repeats.** The site serves intermittent `503`s during ordinary browsing, so a single bad response proves nothing. A failing URL is retried up to 3 times with growing backoff, and only one that fails every attempt is recorded — reported as what was seen ("HTTP 500 on 3 attempts") rather than as missing content.

Useful options:

```bash
# Refresh the path list without scanning
npm run paths-scrape

# Rescan cached paths only (no catalog walk)
npm run paths-scan

# Work through the catalog in chunks
npm run paths-scan -- --offset 100 --limit 50

# Re-check one path
npm run paths-scan -- --path-id 12

# Also flag dead activity links
npm run paths -- --verify-links

# Try it without a browser window (Google often rejects headless sessions)
npm run paths -- --headless
```

### Authentication

The paths commands deliberately run a **visible browser by default** — the opposite of `scan`. Google refuses sessions from a browser that identifies as headless often enough that the headless path costs a wasted launch plus a retry, so it is opt-in via `--headless`.

They also **do not replicate cookies** between `partner.skills.google` and `partner.cloudskillsboost.google`. The paths scanner only ever requests `partner.skills.google`, and copying session tokens onto a domain it never talks to is what made Google invalidate sessions server-side in the first place (see [`ISSUES.md`](ISSUES.md) §4).

If a run still asks you to sign in:

```bash
# 1. Confirm the stored session by hand — this opens the exact page the scanner probes
npm run paths-scan -- --limit 1

# 2. If that prompts, refresh the session once and retry
npm run auth

# 3. Still stuck? Skip Playwright entirely and capture from a tab you are already signed into
#    (see docs/chrome-scan.md), then:
npm run paths-import -- ~/Downloads/skills-scan.json
```

The scanner asks for an interactive sign-in **at most once per run** and then fails rather than looping, so a bad session cannot turn into repeated login attempts against your account.

Both commands reuse the Skills browser profile from `npm run auth`, so sign in there first. Exit status is `2` while any activity is still outstanding.

### Importing a scan captured in the browser

The same fetch loop runs fine pasted into DevTools on an already signed-in Skills tab, which skips Playwright and its separate login entirely. Save what it produces and hand it over:

```bash
npm run paths-import -- scan.json
```

`paths-import` accepts either the JSON `paths-scan --json` writes or the compact `{id, title, progress, cards: [[name, type, credentialType, completed, progress, duration, href], ...]}` form that is convenient to build in the browser. Both feed the same merge logic, so the two collection routes can be mixed run to run.

## MCP server

The same database is exposed over the Model Context Protocol, so an assistant can answer "what should I do next?" without you opening any files.

```bash
npm run mcp          # stdio server
```

Register it with Claude Code:

```bash
claude mcp add partner-training -- node /absolute/path/to/training/src/mcp-server.js
```

Set `TRAINING_DIR` if the server runs from outside the repository; it defaults to the working directory.

| Tool | What it does |
| --- | --- |
| `training_summary` | Progress overview: paths finished/open, work outstanding, blocked count. Start here. |
| `next_up` | Ranked recommendations — `quick_wins`, `leverage`, `stalled`, `blocked`, `near_miss` |
| `find_activity` | Search a course or lab; returns status, an openable URL, and every path holding it |
| `list_paths` | Filter paths by status or title |
| `path_detail` | One path's activities, split into outstanding and completed |
| `import_scan` | Rebuild the database from a browser-captured scan (fast, no browser) |
| `refresh_from_site` | Rescan the live catalog with Playwright (**slow**, ~3 minutes, opens a window) |

Read tools parse the Markdown files directly — the files remain the only source of truth, and a refresh through MCP writes exactly what `npm run paths` writes. Playwright is imported lazily, so read-only tools never pay for it.

### Python MCP server (`mcp-server/`)

A second, wider server lives in [`mcp-server/`](mcp-server/README.md). It covers the whole CLI rather than just the paths database — portal scrape, course scan, path discovery, browser-capture import — and runs each of those as a background job you poll, because a scan takes minutes. It also reports session health and validates URLs against the partner-only rule.

```bash
pip install --user -r mcp-server/requirements.txt
npm run mcp:py   # shortcut to launch the Python MCP server

# Register with Claude Code:
claude mcp add partner-skills -- python3 /absolute/path/to/training/mcp-server/server.py
```

Every tool there is prefixed `partner_` (`partner_next_up`, `partner_scan_paths`, …), so it can be registered next to the Node server above — and next to a server for the public `skills.google` catalog — without a name collision. Set `PARTNER_SKILLS_REPO` if it runs from outside the repository.

## Notes

- The tool supports the current `partner.skills.google` and legacy `partner.cloudskillsboost.google` course URLs.
- It never stores passwords. Authentication is performed directly in Google's browser pages.
- Portal markup can change. Use the selector options rather than editing code when possible.
- If Google Skills pauses on a sign-in or account-selection page, complete it in the opened browser. The terminal now prints the exact course and URL being processed.
- When a lab's "Check my progress" refuses to mark work you know is done, see [`docs/lab-marking.md`](docs/lab-marking.md) — how Qwiklabs grading actually works, and how to make a failing check tell you what it wants.

## AI Configuration

For guidelines on pair-programming with AI tools, see [CLAUDE.md](CLAUDE.md) for general/Claude instructions and [GEMINI.md](GEMINI.md) for Gemini AI guidelines and [`.geminiignore`](.geminiignore) context-optimization rules.


