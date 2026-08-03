# GEMINI.md

AI integration guidelines and context-optimization configuration for pair-programming in the `training` repository.

For user-facing CLI documentation, see [README.md](README.md). For Claude Code specific instructions, see [CLAUDE.md](CLAUDE.md).

## What this project is

A **training assistant for Google Partner Skills**. It helps a partner engineer track training completions and outstanding requirements:

- **DRI Courses**: Courses linked from the Delivery Readiness Portal (DRI) and completed on Google Skills for Partners.
- **Learning Paths**: Catalog learning paths, individual courses, and labs in Google Skills for Partners.

It is a local Node.js CLI (`dri-course-checker`, ESM, Node >= 20) driving Playwright/Chromium against the user's signed-in sessions. Data resides in human-readable Markdown trackers (`completions.md`, `paths.md`, `activities.md`, `next-up.md`) that act as an idempotent database.

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
| `src/mcp-server.js` | Node MCP server (stdio) exposing the database as tools |
| `src/profile-lock.js` | Detect and clear stale Chromium `SingletonLock` files |
| `mcp-server/` | Python MCP server (stdio) wrapping the whole CLI (`partner_*` tools) |
| `mcp-server/worklist.mjs` | Bridge from Python server to `src/next-up.js` ranking |
| `docs/chrome-scan.md` | Zero-Playwright capture: DevTools snippet + `paths-import` |
| `test/` | Unit tests for pure modules (`node --test`) |
| `.geminiignore` | Context exclusion rules for Gemini / AI agents |

## Context Exclusions (FinOps & Token Optimization)

A [`.geminiignore`](.geminiignore) file at the repository root filters out noise, lock files, and binary assets while retaining full visibility into source code, Markdown trackers, and configuration.

Exclusions follow the **geminiignore-finops** pattern:
- **Dependency lock files**: `package-lock.json` and `node_modules/` (saves thousands of redundant tokens).
- **Browser sessions**: `.browser-profile-readiness/` and `.browser-profile-skills/`. These store live login sessions — exclusion protects credentials and context space.
- **Environment secrets**: `.env` and `.env.*` (if present).
- **Job logs & python caches**: `.mcp-jobs/`, `__pycache__/`.
- **Media, logs, & scan dumps**: `*.png`, `*.pdf`, `*.log`, `*.csv`, `*.jsonl`, `sample-*-results.json`.

## Commands & Capabilities

```bash
npm run auth      # interactive: sign in to both sites (User interactive ONLY)
npm run scrape    # DRI portal -> courses.json
npm run scan      # courses.json -> completions.md
npm run check     # scrape + scan
npm test          # Node unit tests (node --test)
npm run mcp       # Node MCP stdio server over Markdown database
npm run mcp:py    # Python MCP stdio server over CLI (mcp-server/)
npm run test:py   # Python MCP server unit tests

node src/cli.js paths-scrape   # Skills catalog -> paths.json
node src/cli.js paths-scan     # paths.json -> paths.md + activities.md
node src/cli.js paths          # both in one run
node src/cli.js paths-import f.json   # build DB from browser capture
```

> **Note on Exit Codes**: Exit status `0` means all items complete, `2` means outstanding/unknown items remain, and `1` indicates execution/scraper errors. Exit code `2` represents valid output state, not a script crash.

## Rules for Gemini / AI Agents

1. **Do not run `npm run auth` directly**: It opens browser windows and blocks on interactive terminal input. Request the user to execute `npm run auth` if credentials need refreshing.
2. **Headless Execution**: Scans can run in non-interactive / headless mode when valid sessions exist:
   ```bash
   npm run check -- --headless
   node src/cli.js paths --headless
   ```
3. **No Virtual Environments**: Do not create or use Python virtual environments (`venv`, `conda`). Use system/global Python packages (`pip install --user`).
4. **Session Confidentiality**: Never output or commit contents from `.browser-profile-readiness/` or `.browser-profile-skills/` (`skills-storage-state.json`).
5. **URL Canonicalization**: Activity URLs must be canonicalized (`/course_templates/<id>` or `/focuses/<id>?parent=catalog&path=<pathId>`). Raw path-scoped URLs (`/paths/X/course_templates/Y`) respond with `403`.
6. **Markdown DB Idempotency**: Updates to Markdown trackers must merge cleanly, preserve prior records, and avoid dropping historical statuses to `UNKNOWN` on inconclusive runs.

