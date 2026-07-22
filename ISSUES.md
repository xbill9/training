# Browser Session and Redirect Issues in Google Skills Checker

During the implementation of the Delivery Readiness Portal course checking tool, we encountered persistent authentication issues when scanning courses on `partner.skills.google` / `partner.cloudskillsboost.google`. 

Below is an overview of the root causes and how the tool resolves them.

---

## 1. Single Sign-On (SSO) Redirect handshakes
**Symptoms:** 
When navigating directly to a course template URL (e.g. `https://partner.cloudskillsboost.google/course_templates/829`), the scraper would be immediately redirected to the unauthenticated landing page (`https://partner.skills.google/`) showing `"Please sign in to access this content."`, despite cookies having been recently saved.

**Root Causes:**
* **Asynchronous Compilation:** Google's login checks compile asynchronously via client-side Angular/JavaScript after DOM load. 
* **Handshake Delay:** Playwright was evaluating the page structure immediately upon navigation loading, before the client could check cookies and validate the session, causing false-positive redirect hits.

**Resolution:**
We introduced a **2.5-second settle timeout** (`page.waitForTimeout(2500)`) immediately following all navigations. This gives the browser engine time to complete cookie checks and handle SSO redirects before status evaluation occurs.

---

## 2. Multi-Domain Cookie Disconnects
**Symptoms:**
Authenticating on `partner.skills.google` would still result in being prompted to log in when the script loaded `partner.cloudskillsboost.google/course_templates/829`.

**Root Causes:**
Cookies saved in the persistent browser profile or `state.json` were scoped strictly to one domain name, causing the session to fail when matching across domain variants.

**Resolution:**
We updated `runScan` inside `scraper.js` to **bi-directionally replicate** session cookies. Any session cookies scoped to `partner.skills.google` (or its subdomains) are duplicated and mapped to `partner.cloudskillsboost.google`, and vice versa, keeping both domains in sync.

---

## 3. Headless vs. Headful Profile Desync
**Symptoms:**
Running with `--headless` would occasionally discard active session files, throwing redirect prompts, while runs using `--no-headless` succeeded.

**Root Causes:**
Chromium's headless mode isolated cookie storage or discarded session states because `launchPersistentContext` configuration omitted target local disk states, or closed browser instances before disk synchronization completed.

**Resolution:**
* We linked the absolute path to `state.json` directly back to `storageState` on context creation.
* When executing in headless mode, if the session is found to have expired, the script now **temporarily pops open a GUI browser** to let the user log in interactively. It pauses, waits for authentication to finalize, sleeps for 2 seconds to let cookies sync, writes them to disk, closes the GUI window, and seamlessly restarts the scan back in headless mode.

---

## 4. Repeated re-authentication loop (root-cause fix, 2026-07-21)

**Symptoms:**
Every run demanded a fresh sign-in even seconds after a successful login; headless runs kept popping the GUI login browser. Risk of the account being flagged for suspicious auth activity.

**Root Causes (three separate bugs compounding):**

1. **`isExpectedHost` ignored its `expectedHost` argument.** It only ever accepted the two `partner.*` hosts, so `runScrape`'s wait for authentication on `delivery-readiness-portal.cloud.google` could *never* succeed — even after a correct sign-in it printed "Sign in in the opened browser", waited out the full timeout, and failed. Every `check` run therefore looked like an auth failure and prompted a new login.

2. **Bi-directional cookie replication clobbered live sessions.** Both partner domains use the same session cookie names. `context.addCookies` overwrites same name+domain+path cookies, so on *every* scan run each domain's valid session token was replaced with the *other* domain's token. Google rejected the mismatched tokens, invalidated the sessions server-side, and redirected to sign-in — forcing a re-login on every single run, and presenting token reuse patterns that look like session hijacking.

3. **`storageState` is silently ignored by `launchPersistentContext`.** The Playwright protocol schema for `BrowserTypeLaunchPersistentContextParams` has no `storageState` field, and unknown options are dropped by the validator. `state.json` was written on every run but *never actually loaded* — the profile directory was always the only real session store, making the Section 3 resolution above a no-op.

**Resolution:**

* `isExpectedHost` now honors `expectedHost`: partner hosts keep the landing/sign-in-page checks, any other host (the portal) is satisfied by simply being back on that hostname off a sign-in path.
* Cookie replication is now **fill-only**: a cookie is copied to the sibling domain only when that domain has no cookie with the same name+path. A domain's own live session is never overwritten. (If one domain's session genuinely dies, one interactive SSO click restores it — after which runs stay stable.)
* All `storageState` options and `state.json` reads/writes were removed. The persistent profile directory (`.browser-profile/`) is the single source of truth; `.browser-profile/state.json` is obsolete and has been deleted.
* The scan's session-validity probe now **polls for up to 15 s** (URL + rendered content) instead of taking one snapshot after a fixed 2.5 s, so a slow SSO handshake no longer misreads as an expired session and triggers a needless GUI re-login.

---

## 5. Google rejects valid sessions in headless mode (2026-07-21)

**Symptoms:**
Even after the Section 4 fixes, headless scans were redirected to the logged-out landing page on every course, while the same profile worked immediately in a visible browser. The old "spawn a GUI browser to re-authenticate" flow then asked the user to sign in again even though the session was perfectly valid.

**Root Cause:**
Cookie storage is identical in both modes (Playwright always launches Chromium with `--password-store=basic` / `--use-mock-keychain`, so headful and headless share the same cookie store). The session was never lost — Google simply **refuses to honor the session when the browser identifies as headless** (`HeadlessChrome` user agent). Every headless run therefore looked logged-out, which the tool misread as an expired session, prompting a pointless re-login on each run. Repeatedly presenting valid session cookies from a bot-flagged user agent is also exactly the traffic pattern that risks an account flag.

**Resolution:**
When a headless run's session check fails, the scan no longer assumes expiry and no longer asks the user to sign in. It **automatically restarts itself with a visible browser** and re-checks there. Only if the session is rejected in the visible browser too does it wait for an interactive sign-in. In practice: headless invocations transparently fall back to a visible scan, with zero authentication prompts while the session is alive.

---

## 6. Isolate Readiness and Partner Skills authentication (2026-07-21)

The portal scraper and completion scanner previously shared one Chromium profile. They now use `.browser-profile-readiness/` and `.browser-profile-skills/` respectively. The `auth` command opens a separate browser context for each site, and `check` passes only the corresponding profile to each phase.

After the course cache has been built, run `npm run scan -- --no-headless` to check `courses.json` without opening or authenticating against the Delivery Readiness Portal at all.

The managed Google login creates an inner Chromium profile (`Profile 1`) beneath the Skills user-data directory. The scanner must explicitly launch that profile; otherwise Chromium opens `Default`, which lacks the Skills session and causes a fresh login on every invocation even though the authenticated cookies remain safely stored in `Profile 1`.

Skills' actual authentication values (`_cvl…session`, `user.id`, and `user.expires_at`) are session-only cookies. Chromium records them but does not reliably reactivate them after Playwright performs a normal shutdown. The scanner now saves storage state before closing and explicitly adds the saved cookies to the next context before navigation; it also requests Chromium's last-session restoration. This is explicit cookie restoration, not the unsupported `storageState` launch option described in Section 4.

Completion is determined by requesting the canonical `/course_templates/<id>/badge` URL and inspecting the final URL after redirects. If the badge page remains loaded, the course is complete. If Google redirects back to the course overview, no badge exists and the course is incomplete. The overview's numeric progress display is not used as the completion authority.

Each scan permits at most one interactive Skills reauthentication attempt. After that attempt it validates rendered authenticated course content rather than hostname alone. If authentication is still rejected, the scan stops with an error instead of reopening authentication or entering a prompt loop.

---

## 7. `catalog_lab` redirects misdiagnosed as expired sessions (2026-07-22)

**Symptoms:**
The entire `catalog_lab` batch (courses 341–360) errored with `page.goto: Navigation ... is interrupted by another navigation to .../focuses/<id>?parent=catalog`, plus one `net::ERR_CONNECTION_CLOSED` and one `chrome-error://chromewebdata` failure. Scans whose first course was a `catalog_lab` URL demanded a fresh sign-in in both headless and visible browsers even though the session was alive (the server kept issuing fresh two-hour `user.expires_at` values throughout).

**Root Causes (four separate bugs):**

1. **Unhandled redirect interruption.** With an authenticated session, `catalog_lab/<id>` is canonicalized to `focuses/<id>?parent=catalog` by a navigation that interrupts the requested one. `navigate()` only recovered from `net::ERR_ABORTED`, so the interruption error escaped and every `catalog_lab` course was recorded as an error. (Logged out, the same URLs redirect cleanly to `/catalog?filter=labs` — which is why this never showed up before labs were scanned while signed in.)

2. **Google's own 500 page read as "logged out".** The `catalog_lab` → `focuses` redirect intermittently lands on Google's Rails error page (`We're sorry, but something went wrong.` — 38 chars), even though a direct load of the same `focuses` URL immediately succeeds. The session-validity probe used `courses[0]`; when that was a `catalog_lab` course, the tiny error body failed the `body.length > 200` check, the probe declared the session expired, and the scan demanded an interactive sign-in the account did not need.

3. **Failed runs destroyed the good session snapshot.** `runScan`'s `finally` saved `skills-storage-state.json` unconditionally, so any failed/logged-out run overwrote the snapshot of a working session — turning one transient server error into a genuinely lost login on the next run.

4. **Transient network drops were not retried.** `ERR_CONNECTION_CLOSED` and navigations displaced to `chrome-error://chromewebdata` were thrown as course errors instead of being retried once.

**Resolution:**

* `navigate()` now recovers from "interrupted by another navigation": it waits up to 5 s for the displacing redirect to land and treats its target as the destination. Connection-level failures (`ERR_CONNECTION_CLOSED`, `ERR_CONNECTION_RESET`, `ERR_TIMED_OUT`, …) and `chrome-error://` landings get one retry.
* The session probe now uses a `course_templates` page (the first one in the course list, else the same course 829 the auth flow verifies) — never a `catalog_lab` URL. `skillsSessionExpired` also refuses to treat Google's 500 page as evidence of expiry.
* Each course that lands on the Google error page is retried once by loading the final `focuses` URL directly (which reliably works); if the error persists, the result is recorded as a server error, clearly distinguished from authentication failure.
* The Skills session snapshot is only saved when the run actually verified an authenticated session; failed runs keep the existing snapshot intact.

After these fixes, the previously failing lab courses scan with zero authentication prompts, including in headless mode — suggesting the Section 5 headless "rejection" was at least partly this same misdiagnosis.
