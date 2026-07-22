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

## Notes

- The tool supports the current `partner.skills.google` and legacy `partner.cloudskillsboost.google` course URLs.
- It never stores passwords. Authentication is performed directly in Google's browser pages.
- Portal markup can change. Use the selector options rather than editing code when possible.
- If Google Skills pauses on a sign-in or account-selection page, complete it in the opened browser. The terminal now prints the exact course and URL being processed.
