# CLAUDE.md

Guidance for Claude Code when working in the `training` repository.

## What this project is

A **training assistant for Google Partner Skills**. It helps a partner engineer see, in one place, what training they still owe:

- Which **courses** linked from the Delivery Readiness Portal (DRI) are completed on Google Skills for Partners.
- Which **learning paths** in the Skills catalog are finished, and which individual **activities** inside them are still outstanding.

It is a local Node.js CLI (`dri-course-checker`, ESM, Node >= 20) driving Playwright/Chromium against the user's own signed-in sessions. Results land in human-readable Markdown trackers that double as the database — earlier findings are merged forward, never dropped.

There is also an optional `chrome-extension/` (MV3) that performs the course check inside the user's existing Chrome session, for when Playwright automation is inconvenient.

## Layout

| Path | Role |
| --- | --- |
| `src/cli.js` | Commander entrypoint; all commands and flags |
| `src/scraper.js` | Playwright: portal scrape, Skills course scan, session handling |
| `src/course-links.js` | Recognize/normalize/dedupe Skills course URLs |
| `src/status.js` | `detectCompletion` — course completed / not / unknown |
| `src/markdown-db.js` | Read+merge+render `completions.md` |
| `src/paths-scraper.js` | Playwright: catalog path discovery, path page reads, link verification |
| `src/path-status.js` | Path and activity status vocabulary + classification |
| `src/paths-db.js` | Read+merge+render `paths.md` and `activities.md` |
| `src/next-up.js` | Rank outstanding work into `next-up.md` (quick wins, leverage, stalled) |
| `src/mcp-server.js` | MCP server (stdio) exposing the database as tools |
| `src/profile-lock.js` | Detect and clear stale Chromium `SingletonLock` files |
| `mcp-server/` | Python MCP server (stdio) wrapping the whole CLI; every tool is named `partner_*` |
| `mcp-server/worklist.mjs` | The only bridge from the Python server to `src/next-up.js` ranking |
| `docs/chrome-scan.md` | Zero-Playwright capture: DevTools snippet + `paths-import` |
| `test/` | `node --test` unit tests over the pure modules |
| `courses.json`, `paths.json` | Cumulative JSON caches of discovered links |
| `ISSUES.md` | Write-up of the auth/redirect problems and how they were solved — **read this before touching session handling** |

## Commands

```bash
npm run auth      # interactive: sign in to both sites, save profiles
npm run scrape    # DRI portal -> courses.json
npm run scan      # courses.json -> completions.md
npm run check     # scrape + scan (default command)
npm test          # node --test
npm run mcp       # Node MCP stdio server over the Markdown database
npm run mcp:py    # Python MCP stdio server over the whole CLI (mcp-server/)
python3 -m unittest discover -s mcp-server -t mcp-server   # its tests

node src/cli.js paths-scrape   # Skills catalog -> paths.json
node src/cli.js paths-scan     # paths.json -> paths.md + activities.md
node src/cli.js paths          # both in one run
node src/cli.js paths-import f.json   # build the DB from a browser-captured scan
```

Exit codes: `0` all complete, `2` something outstanding/unknown, `1` scraper or config error. The `2` is meaningful output, not a failure — don't "fix" it.

## Working in this repo

- **Never run `npm run auth` yourself.** It opens browser windows and blocks on an interactive Enter prompt; it needs the user at the keyboard. Ask them to run it with `! npm run auth`.
- Scans only work headless once a signed-in profile exists: `npm run check -- --headless`, `node src/cli.js paths --headless`. Without a session they will stall on a sign-in page.
- Scans are slow and hit Google's servers. When iterating, scope them: `--course-id 1722`, `--path-id 12`, `--limit 5`, `--offset`.
- **Session data is secret.** `.browser-profile-readiness/`, `.browser-profile-skills/` (including `skills-storage-state.json` inside it) are live logins. They are gitignored — never commit, print, or copy them.
- Prefer the selector flags (`--course-selector`, `--status-selector`) over hardcoding new markup assumptions; portal HTML changes often.
- The tool must keep supporting both `partner.skills.google` and legacy `partner.cloudskillsboost.google` URLs, and the cookie replication between them.
- Markdown DBs must be **idempotent**: importing the same scan twice must not change row counts. Escaping has to round-trip through render→parse for unlinked rows too (a name like `[DEPRECATED] Foo` gained a backslash per run until this was fixed).
- **Canonicalize activity URLs before fetching or linking** (`canonicalActivityUrl` in `paths-db.js`). Path-scoped URLs (`/paths/70/course_templates/822`) always `403`; the bare `/course_templates/822` works. A bare `/focuses/<id>` redirects to the dashboard; `/focuses/<id>?parent=catalog&path=<pathId>` works.
- Lab (`/focuses/`) requests take ~30s because they provision an environment. Use a 60s timeout; anything shorter reports healthy labs as failures.
- Google never 404s missing content — it answers `200` and redirects to the dashboard. Detect retirement by the redirect, not the status code.
- Never report a `403` as a broken link. Google returns it both for unentitled content and for rate limiting; parallel verification produces a page of false failures. Verify one request at a time.
- Markdown DBs are append-and-merge. Any change to `markdown-db.js` / `paths-db.js` must preserve rows from prior runs and must not downgrade a definitive status to `UNKNOWN` on an inconclusive check (see commit `d0eca8e`).
- **Never use a virtualenv or any other sandboxed dependency environment** (`venv`, `virtualenv`, `conda`, `pipenv`). Install into the system/global environment.
- **Always aim for the latest stack** — newest packages, runtimes, compilers. When a current version breaks something, **fix the breakage; never downgrade or pin back**. Chasing old packages accumulates upgrade debt that turns into a painful migration later.
- The MCP server's read tools must parse the Markdown files, never a side cache — the files are the database. Its write tools must call the same `updatePathsDb` / `updateNextUp` the CLI uses, so both entry points produce identical output. Keep the Playwright import lazy so read tools stay cheap.
- The Python server in `mcp-server/` follows the same rule from the other side: it never writes a tracker and never ranks work itself. Actions shell out to `src/cli.js`, and `partner_next_up` shells out to `mcp-server/worklist.mjs`, which calls `buildWorklist` — so the tool cannot disagree with `next-up.md`. Its parsers mirror `paths-db.js` / `markdown-db.js`; change a column and `mcp-server/test_server.py` should fail.
- Keep the two servers' tool names disjoint. The Node server owns the bare names (`next_up`, `list_paths`, …); everything in `mcp-server/` is `partner_*` so both — plus a server for the public `skills.google` catalog — can be registered at once.
- `test/mcp-server.test.js` drives the server over real stdio JSON-RPC. It spawns a child per test, so it is sensitive to a loaded machine — a heavy background job can push startup past the 20s timeout.
- Put logic worth testing in the pure modules (`course-links`, `status`, `path-status`, `*-db`) rather than inside Playwright callbacks — that is where the test suite can reach it.

## Docs

`README.md` is the user-facing guide. `GEMINI.md` provides Gemini / AGY pair-programming guidance and details the [`.geminiignore`](.geminiignore) context-exclusion setup.
