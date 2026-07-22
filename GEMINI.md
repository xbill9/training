# GEMINI.md

This file details the AI integration guidelines and context optimization configurations for pair-programming in the `training` repository.

## Context Exclusions (FinOps & Token Optimization)

A `.geminiignore` file is configured at the repository root to optimize processing speed and reduce token costs. It filters out compiler noise, lock files, and binary assets while retaining full visibility into the source code and main configurations.

The exclusions follow the **geminiignore-finops** pattern:
- **Dependency lock files**: `package-lock.json` is ignored (saves thousands of redundant tokens).
- **Environment config secrets**: `.env` and `.env.*` are ignored; `!.env.example` remains visible.
- **Browser sessions**: `.browser-profile-readiness/` and `.browser-profile-skills/` are ignored.
- **Media and builds**: Binary assets (`*.png`, `*.pdf`, etc.) and log files are ignored.

## Tool Capabilities & Setup

This repository is a Node.js project using Playwright for automated web scraping and status reporting of training courses.

### Running with Gemini / AI Tools
When prompting a Gemini agent or running automation tasks:
- Do not run `npm run auth` inside standard non-interactive environments as it requires manual login in an open Chromium browser window.
- Scans can be run in headless mode when valid browser sessions exist:
  ```bash
  npm run check -- --headless
  ```
