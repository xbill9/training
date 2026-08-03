# GEMINI.md

AI integration guidelines and context-optimization configuration for pair-programming in the `training` repository.

For what this project is and how to work in it, see [CLAUDE.md](CLAUDE.md) — it is the fuller guide and applies regardless of which assistant you use.

## Context Exclusions (FinOps & Token Optimization)

A [`.geminiignore`](.geminiignore) file at the repository root filters out noise, lock files, and binary assets while retaining full visibility into the source code, the Markdown trackers, and the main configuration.

The exclusions follow the **geminiignore-finops** pattern:
- **Dependency lock files**: `package-lock.json` and `node_modules/` are ignored (saves thousands of redundant tokens).
- **Browser sessions**: `.browser-profile-readiness/` and `.browser-profile-skills/` are ignored. These hold live logins — the exclusion is a safety measure, not just a cost one.
- **Environment config secrets**: `.env` and `.env.*` are ignored; `!.env.example` remains visible. The repo has none today; the rule is pre-emptive.
- **Media, logs, and bulk output**: binary assets (`*.png`, `*.pdf`, etc.), log files, and the `sample-*-results.json` scan dumps are ignored.

## Tool Capabilities & Setup

This repository is a Node.js project using Playwright to scrape and report Google Partner Skills training status — DRI-linked course completions plus learning-path and activity progress.

### Running with Gemini / AI Tools
When prompting a Gemini agent or running automation tasks:
- Do not run `npm run auth` inside standard non-interactive environments; it requires manual login in an open Chromium browser window and blocks on a terminal prompt.
- Scans can be run in headless mode when valid browser sessions exist:
  ```bash
  npm run check -- --headless
  node src/cli.js paths --headless
  ```
