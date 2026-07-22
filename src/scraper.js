import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeCourseLinks } from "./course-links.js";
import { detectCompletion } from "./status.js";

const DEFAULT_PORTAL_URL = "https://delivery-readiness-portal.cloud.google/app/gcp-projects/manage-dri-attribute";

const PARTNER_SKILLS_HOSTS = new Set(["partner.skills.google", "partner.cloudskillsboost.google"]);

// Same course the interactive auth flow verifies. Used to probe session
// validity because it renders authenticated content reliably, unlike
// catalog_lab URLs whose canonical redirect intermittently hits Google's 500
// page and falsely reads as "logged out".
const SESSION_PROBE_URL = "https://partner.skills.google/course_templates/829";

// Google's Rails error page: a server fault that says nothing about whether
// the session is authenticated.
function isGoogleServerErrorPage(body) {
  return body.length < 400 && /we.re sorry, but something went wrong/i.test(body);
}

export function isCourseBadgePage(actualUrl, courseId) {
  try {
    const url = new URL(actualUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    return PARTNER_SKILLS_HOSTS.has(url.hostname)
      && normalizedPath === `/course_templates/${courseId}/badge`;
  } catch {
    return false;
  }
}

function isExpectedHost(actualUrl, expectedHost) {
  try {
    const parsed = new URL(actualUrl);
    if (parsed.pathname.includes("/users/sign_in")) return false;
    if (PARTNER_SKILLS_HOSTS.has(expectedHost)) {
      // Either partner domain counts, but an authenticated session never sits on the landing page
      return PARTNER_SKILLS_HOSTS.has(parsed.hostname) && parsed.pathname !== "/";
    }
    // Non-Skills hosts (e.g. the Delivery Readiness Portal): being back on the
    // expected host means the sign-in redirect chain is finished
    return parsed.hostname === expectedHost;
  } catch {
    return false;
  }
}

async function waitForAuthenticatedPage(page, expectedHost, timeoutMs) {
  try {
    if (isExpectedHost(page.url(), expectedHost)) return;
  } catch {}
  process.stderr.write(`Sign in in the opened browser. Waiting up to ${Math.round(timeoutMs / 60000)} minutes...\n`);
  await page.waitForURL((url) => isExpectedHost(url.href, expectedHost), { timeout: timeoutMs });
}

// Poll instead of sampling once: the SSO handshake can briefly show the
// unauthenticated landing page before cookies validate. Only declare the
// session expired if we never reach authenticated course content.
async function skillsSessionExpired(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const signInPrompt = /please sign in to access|sign in or join/i.test(body);
    if (isExpectedHost(page.url(), "partner.cloudskillsboost.google") && body.length > 200 && !signInPrompt) {
      return false;
    }
    if (Date.now() >= deadline) {
      // A Google 500 page carries no authentication signal; declaring the
      // session expired here is what caused sign-in prompts the account did
      // not need.
      return !isGoogleServerErrorPage(body);
    }
    await page.waitForTimeout(1000);
  }
}

async function extractLinks(page, selector, timeoutMs) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000); // Give Angular components/Bootstrap time to render tables

  // Try finding and adjusting items-per-page dropdown pager controls to show 100 items at once
  try {
    const dropdownSelectors = [
      "select[aria-label*='items' i]",
      "select[aria-label*='page' i]",
      "select[class*='page' i]",
      "select[class*='size' i]",
      ".mat-mdc-select", // Material Design dropdown selector
      ".mat-select"
    ];
    for (const dSel of dropdownSelectors) {
      const selectLoc = page.locator(dSel).first();
      if (await selectLoc.isVisible().catch(() => false)) {
        if (dSel.startsWith("select")) {
          // Standard HTML dropdown
          const has100 = await selectLoc.locator("option").evaluateAll((options) => options.some((o) => o.value === "100" || o.textContent.includes("100")));
          if (has100) {
            process.stderr.write("Setting table pagination limit to 100 items per page...\n");
            await selectLoc.selectOption("100").catch(() => {});
            await page.waitForTimeout(2000);
            break;
          }
        } else {
          // Material select trigger
          process.stderr.write("Opening pagination dropdown trigger...\n");
          await selectLoc.click({ force: true }).catch(() => {});
          await page.waitForTimeout(1500);

          // Query possible option containers in DOM overlay
          const optionsLocator = page.locator(".mat-mdc-option, .mat-option, mat-option, [role='option']");
          const optionTexts = await optionsLocator.evaluateAll((elements) => elements.map(el => el.textContent.trim()));
          process.stderr.write(`Dropdown options found: ${JSON.stringify(optionTexts)}\n`);

          const targetOption = optionsLocator.filter({ hasText: /^(100|100\b)/ }).first();
          if (await targetOption.isVisible().catch(() => false)) {
            process.stderr.write("Selecting '100' option element...\n");
            await targetOption.click().catch(() => {});
            await page.waitForTimeout(3000);
            await page.keyboard.press("Escape").catch(() => {});
            break;
          } else {
            // Option element containing 100 text (fallback click)
            const fallbackOption = page.locator("[role='option']").filter({ hasText: "100" }).first();
            if (await fallbackOption.isVisible().catch(() => false)) {
              process.stderr.write("Selecting '100' option via role element...\n");
              await fallbackOption.click().catch(() => {});
              await page.waitForTimeout(3000);
              break;
            }
            await page.keyboard.press("Escape").catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[DEBUG] Items per page adjustment skipped: ${err.message}\n`);
  }

  const deadline = Date.now() + timeoutMs;
  const allLinks = new Map();

  while (Date.now() < deadline) {
    let pageLinksFound = [];
    for (const frame of page.frames()) {
      try {
        pageLinksFound.push(...await frame.locator(selector).evaluateAll((anchors) => anchors.map((anchor) => ({
          href: anchor.href,
          label: anchor.textContent || anchor.getAttribute("aria-label") || ""
        }))));
      } catch { /* frame navigation / cross-origin */ }
    }
    const courses = normalizeCourseLinks(pageLinksFound);
    let addedNew = false;
    for (const course of courses) {
      if (!allLinks.has(course.href)) {
        allLinks.set(course.href, course);
        addedNew = true;
      }
    }

    // Try finding pagination controls (e.g. "Next", ">", page numbers, button/element containing 'next' class or text)
    const paginationSelectors = [
      "button[aria-label*='Next' i]",
      "a[aria-label*='Next' i]",
      "button:has-text('Next')",
      "a:has-text('Next')",
      "[class*='next' i] button",
      "[class*='next' i] a",
      "button[class*='next' i]",
      "a[class*='next' i]"
    ];

    let nextBtn = null;
    for (const pSel of paginationSelectors) {
      try {
        const loc = page.locator(pSel).first();
        if (await loc.isVisible().catch(() => false)) {
          const isDomEnabled = await loc.isEnabled().catch(() => false);
          const hasDisabledAttr = await loc.evaluate((el) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.classList.contains("disabled")).catch(() => false);
          if (isDomEnabled && !hasDisabledAttr) {
            nextBtn = loc;
            break;
          }
        }
      } catch {}
    }

    if (nextBtn) {
      process.stderr.write("Navigating to next page of Readiness Portal...\n");
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    } else {
      break; // No active next page button found, done crawling
    }
  }

  return [...allLinks.values()];
}

async function completionSnapshot(page, statusSelector) {
  const frameSnapshots = [];
  for (const frame of page.frames()) {
    try {
      // Evaluate within frame content
      const snap = await frame.evaluate((selector) => {
        const selectors = [
          selector,
          "[aria-label*='complete' i]",
          "[data-testid*='complete' i]",
          "[class*='progress' i]",
          "[class*='complete' i]"
        ].filter(Boolean);

        // Find visible matching elements in this frame
        const nodes = [...new Set(selectors.flatMap((item) => [...document.querySelectorAll(item)]))];
        const progressValues = [...document.querySelectorAll("progress, [role='progressbar']")]
          .map((node) => node.value ?? node.getAttribute("aria-valuenow"))
          .filter((value) => value != null);

        // Checkbox inputs or matching checked attributes
        const checkboxes = [...document.querySelectorAll("input[type='checkbox'], [role='checkbox'], [class*='checkbox' i]")];
        let hasCheckedCheckbox = checkboxes.some((el) => {
          if (el.tagName === "INPUT" && el.checked) return true;
          if (el.getAttribute("aria-checked") === "true") return true;
          if (el.classList.contains("checked") || el.getAttribute("data-checked") === "true") return true;
          return false;
        });

        // Common SVG checkmarks specifically inside course content details or status badges
        const hasSvgCheck = document.querySelector(".completed svg, .course-status svg, svg.completed, svg.complete, svg.checkmark, svg[class*='complete' i], .complete-badge svg") !== null
          || [...document.querySelectorAll("svg.checkmark, .completed svg")].length > 0;

        // Match graphic/badge containers specifically indicating completion, or if URL is badge completion page
        const hasGraphicCheck = document.querySelector(".completion-graphic, .completion-badge, img[src*='badge' i], img[src*='complete' i]") !== null;

        // If a badge completion link is linked directly on the course page template
        const hasBadgeLink = Array.from(document.querySelectorAll("a[href]")).some((a) => {
          try {
            const path = new URL(a.href).pathname;
            return path.endsWith("/badge") || path.includes("/badge/");
          } catch {
            return a.href.includes("/badge");
          }
        });

        return {
          bodyText: document.body?.innerText || "",
          signals: nodes.map((node) => [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title")]
            .filter(Boolean).join(" ")),
          progressValues,
          hasCheckedCheckbox: hasCheckedCheckbox || hasSvgCheck || hasGraphicCheck || hasBadgeLink
        };
      }, statusSelector).catch(() => null);

      if (snap) {
        frameSnapshots.push(snap);
      }
    } catch { /* Ignore cross-origin frame errors */ }
  }

  // Combine results across all frames
  return {
    bodyText: frameSnapshots.map((s) => s.bodyText).join("\n"),
    signals: frameSnapshots.flatMap((s) => s.signals),
    progressValues: frameSnapshots.flatMap((s) => s.progressValues),
    hasCheckedCheckbox: frameSnapshots.some((s) => s.hasCheckedCheckbox)
  };
}

async function navigate(page, url, timeoutMs = 60000) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const previousUrl = page.url();
    try {
      await page.goto(url, { waitUntil: "commit", timeout: timeoutMs });
      break;
    } catch (error) {
      if (error.name === "TimeoutError") {
        process.stderr.write(`Navigation is still loading after ${Math.round(timeoutMs / 1000)}s; checking the rendered page anyway.\n`);
        break;
      }
      const message = String(error.message);
      const aborted = message.includes("net::ERR_ABORTED");
      // An authenticated session makes Google replace catalog_lab/<id> style
      // URLs with their canonical page (e.g. focuses/<id>?parent=catalog) via a
      // client-side navigation that interrupts the requested one.
      const interrupted = message.includes("interrupted by another navigation");
      // Transient network drops surface as connection errors or a navigation to
      // Chromium's chrome-error://chromewebdata page; they deserve one retry.
      const connectionDropped = /net::ERR_(CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_ABORTED|NETWORK_CHANGED|EMPTY_RESPONSE|TIMED_OUT)/.test(message);
      if (!aborted && !interrupted && !connectionDropped) throw error;

      if (aborted || interrupted) {
        // Wait for the redirect that displaced our navigation to land, then
        // treat its target as the destination.
        const redirectDeadline = Date.now() + 5000;
        let landedUrl = "";
        while (Date.now() < redirectDeadline) {
          await page.waitForTimeout(500);
          const current = page.url();
          if (current !== previousUrl && current !== url && !current.startsWith("chrome-error://")) {
            landedUrl = current;
            break;
          }
        }
        if (landedUrl) {
          process.stderr.write(`Google redirected navigation to ${landedUrl}\n`);
          break;
        }
      }
      if (attempt === 2) throw error;
      process.stderr.write("Navigation was cancelled before reaching a page; retrying once...\n");
      await page.waitForTimeout(1500);
    }
  }
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
  } catch { /* client-rendered Google pages can keep navigation pending */ }
}

export async function runScrape(options) {
  // The persistent profile directory is the single source of truth for the
  // session. launchPersistentContext silently ignores storageState, so loading
  // state.json here never worked and is intentionally not attempted.
  const context = await chromium.launchPersistentContext(options.profile, {
    headless: options.headless,
    channel: options.channel || undefined,
    viewport: { width: 1440, height: 1000 }
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const portalUrl = options.portalUrl || DEFAULT_PORTAL_URL;
    await navigate(page, portalUrl);
    await waitForAuthenticatedPage(page, new URL(portalUrl).hostname, options.authTimeout);
    await page.waitForTimeout(4000); // Wait for Angular to compile headers and tab groups

    // Switch to the requested tab if it exists on the Delivery Readiness Portal (e.g. 'LABS', 'TECHNICAL TRAINING')
    const targetTab = options.tab || "LABS";
    const cleanTab = targetTab.trim();
    const upperTab = cleanTab.toUpperCase();
    const lowerTab = cleanTab.toLowerCase();
    const capitalizedTab = cleanTab.charAt(0).toUpperCase() + cleanTab.slice(1).toLowerCase();

    try {
      const tabSelectors = [
        `button:has-text('${upperTab}')`,
        `a:has-text('${upperTab}')`,
        `[role='tab']:has-text('${upperTab}')`,
        `.mat-mdc-tab:has-text('${upperTab}')`,
        `.mat-tab-label:has-text('${upperTab}')`,
        `span:has-text('${upperTab}')`,
        `button:has-text('${capitalizedTab}')`,
        `a:has-text('${capitalizedTab}')`,
        `[role='tab']:has-text('${capitalizedTab}')`,
        `.mat-mdc-tab:has-text('${capitalizedTab}')`,
        `.mat-tab-label:has-text('${capitalizedTab}')`,
        `span:has-text('${capitalizedTab}')`,
        `button:has-text('${lowerTab}')`,
        `a:has-text('${lowerTab}')`,
        `[role='tab']:has-text('${lowerTab}')`,
        `.mat-mdc-tab:has-text('${lowerTab}')`,
        `.mat-tab-label:has-text('${lowerTab}')`,
        `span:has-text('${lowerTab}')`
      ];
      let pageTab = null;
      for (const tSel of tabSelectors) {
        const loc = page.locator(tSel).first();
        if (await loc.isVisible().catch(() => false)) {
          pageTab = loc;
          break;
        }
      }
      if (pageTab) {
        process.stderr.write(`Switching to '${cleanTab}' tab...\n`);
        await pageTab.click().catch(() => {});
        await page.waitForTimeout(4000); // Wait for the tab animation and table items to load
      } else {
        process.stderr.write(`[DEBUG] '${cleanTab}' tab trigger not found, staying on default tab.\n`);
      }
    } catch (err) {
      process.stderr.write(`[DEBUG] Tab switching failed: ${err.message}\n`);
    }

    const bodyDump = await page.evaluate(() => document.body.innerHTML).catch(() => "");
    process.stderr.write(`[DEBUG PORTAL] URL: ${page.url()}, Frames count: ${page.frames().length}, Body length: ${bodyDump.length}, Snippet: ${bodyDump.substring(0, 1000)}\n`);
    process.stderr.write("Waiting for authentication and course links in the Delivery Readiness Portal...\n");
    const courses = await extractLinks(page, options.courseSelector, options.authTimeout);
    return courses;
  } finally {
    await context.close();
  }
}

export async function runScan(inputPath, options) {
  let courses = JSON.parse(readFileSync(inputPath, "utf-8"));
  if (options.courseId) {
    courses = courses.filter((c) => {
      try {
        const pathname = new URL(c.href).pathname;
        return pathname.endsWith(`/${options.courseId}`) || pathname.includes(`/${options.courseId}/`);
      } catch {
        return c.href.includes(options.courseId);
      }
    });
    if (!courses.length) {
      throw new Error(`No Google Skills course matching ID "${options.courseId}" was found in the input list.`);
    }
  }

  if (options.offset > 0) {
    courses = courses.slice(options.offset);
  }

  if (options.limit > 0) {
    courses = courses.slice(0, options.limit);
  }

  const skillsStatePath = join(options.profile, "skills-storage-state.json");
  const browserArgs = ["--restore-last-session"];
  if (options.browserProfile) browserArgs.push(`--profile-directory=${options.browserProfile}`);
  const context = await chromium.launchPersistentContext(options.profile, {
    headless: options.headless,
    channel: options.channel || undefined,
    args: browserArgs,
    viewport: { width: 1440, height: 1000 }
  });

  let sessionVerified = false;
  try {
    // Skills keeps its login in session-only cookies. A normal Chromium close
    // does not reliably reactivate them, so restore our explicit snapshot.
    if (existsSync(skillsStatePath)) {
      try {
        const savedState = JSON.parse(readFileSync(skillsStatePath, "utf-8"));
        if (Array.isArray(savedState.cookies) && savedState.cookies.length) {
          await context.addCookies(savedState.cookies);
        }
      } catch (error) {
        process.stderr.write(`[WARN] Could not restore Skills session state: ${error.message}\n`);
      }
    }

    // Fill in session cookies that are missing on the sibling partner domain,
    // but NEVER overwrite a cookie the target domain already has. Both partner
    // sites use the same session cookie names; clobbering a live session with
    // the other domain's token invalidates it server-side and forces a fresh
    // sign-in on every run.
    const currentCookies = await context.cookies().catch(() => []);
    const cookieKey = (name, domain, path) => `${name}|${domain}|${path}`;
    const existing = new Set(currentCookies.map((c) => cookieKey(c.name, c.domain, c.path)));
    const replicated = [];
    for (const c of currentCookies) {
      const fromHost = [...PARTNER_SKILLS_HOSTS].find((host) => c.domain === host || c.domain === `.${host}`);
      if (!fromHost) continue;
      const toHost = fromHost === "partner.skills.google" ? "partner.cloudskillsboost.google" : "partner.skills.google";
      const altDomain = c.domain.replace(fromHost, toHost);
      if (existing.has(cookieKey(c.name, altDomain, c.path))) continue;
      replicated.push({
        name: c.name,
        value: c.value,
        domain: altDomain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite
      });
    }
    if (replicated.length) {
      process.stderr.write(`[DEBUG] Copying ${replicated.length} session cookies missing on the sibling partner domain...\n`);
      await context.addCookies(replicated).catch(() => {});
    }

    const page = context.pages()[0] || await context.newPage();

    // Check if session is authenticated on Skills site. Probe a
    // course_templates page: catalog_lab URLs redirect through Google's
    // canonicalizer, which intermittently serves its 500 page and would make a
    // live session look logged out.
    if (courses.length > 0) {
      const probeCourse = courses.find((c) => c.href.includes("/course_templates/"));
      const probeUrl = probeCourse ? probeCourse.href : SESSION_PROBE_URL;
      process.stderr.write(`Checking if Skills site session is valid via ${probeUrl} ...\n`);
      await navigate(page, probeUrl);
      if (await skillsSessionExpired(page, 15000)) {
        if (options.headless) {
          // Google frequently refuses an otherwise-valid session when the browser
          // identifies as headless (HeadlessChrome user agent). Retry the whole
          // scan with a visible browser before assuming the session is dead, so
          // the user is never prompted for a sign-in the account does not need.
          process.stderr.write("Session not accepted in headless mode; Google often rejects headless browsers. Retrying with a visible browser...\n");
          await context.close().catch(() => {});
          return runScan(inputPath, { ...options, headless: false });
        }
        process.stderr.write(`Skills session has expired. Sign in once in the opened browser; waiting up to ${Math.round(options.authTimeout / 60000)} minutes...\n`);
        // One interactive attempt only. Validate rendered authenticated content,
        // not merely the URL, because the logged-out landing page uses the same
        // Partner Skills hostname. Never restart or prompt again from here.
        if (await skillsSessionExpired(page, options.authTimeout)) {
          throw new Error("Skills authentication was not accepted after one interactive attempt; stopping to avoid a reauthentication loop.");
        }
      }
      sessionVerified = true;
    }

    const results = [];
    for (const [index, course] of courses.entries()) {
      try {
        process.stderr.write(`[${index + 1}/${courses.length}] Opening ${course.label}: ${course.href}\n`);
        await navigate(page, course.href);
        await page.waitForTimeout(2500); // Allow SSO redirects and cookie handshakes to finalize

        // catalog_lab redirects intermittently land on Google's 500 page even
        // though a direct load of the same final URL succeeds. Retry that URL
        // once, and if the error persists report it as a server error rather
        // than letting it masquerade as a completion or auth failure.
        let bodyNow = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        if (isGoogleServerErrorPage(bodyNow)) {
          const finalUrl = page.url().startsWith("http") ? page.url() : course.href;
          // The 500s cluster under rapid sequential requests, so back off
          // before each retry instead of hammering the endpoint again.
          for (let retry = 1; retry <= 2 && isGoogleServerErrorPage(bodyNow); retry += 1) {
            process.stderr.write(`[${index + 1}/${courses.length}] Google served its error page; retry ${retry}/2 for ${finalUrl} after a pause...\n`);
            await page.waitForTimeout(5000);
            await navigate(page, finalUrl);
            await page.waitForTimeout(2500);
            bodyNow = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
          }
          if (isGoogleServerErrorPage(bodyNow)) {
            results.push({
              course: course.label,
              url: course.href,
              completed: null,
              evidence: `Google Skills served "We're sorry, but something went wrong." at ${page.url()} (server-side error, not an authentication failure)`
            });
            process.stderr.write(`[${index + 1}/${courses.length}] UNKNOWN (Google server error)\n`);
            continue;
          }
        }

        // Let client-side javascript render checkboxes/completion state asynchronously
        let snapshot = await completionSnapshot(page, options.statusSelector);
        let status = detectCompletion(snapshot);
        const startSettle = Date.now();
        while (status.completed !== true && (Date.now() - startSettle) < options.settleTime) {
          await page.waitForTimeout(500);
          snapshot = await completionSnapshot(page, options.statusSelector);
          status = detectCompletion(snapshot);
        }

        // The course overview's progress widget is not authoritative. Google
        // exposes earned completion on the canonical Partner Skills badge page.
        // Probe it whenever the overview does not positively confirm completion.
        if (status.completed !== true) {
          const courseUrl = new URL(course.href);
          const templateMatch = courseUrl.pathname.match(/\/course_templates\/([^/]+)/);
          if (templateMatch) {
            const badgeUrl = `https://partner.skills.google/course_templates/${templateMatch[1]}/badge`;
            process.stderr.write(`[${index + 1}/${courses.length}] Checking completion badge: ${badgeUrl}\n`);
            await navigate(page, badgeUrl);
            await page.waitForTimeout(options.settleTime);
            const badgeSnapshot = await completionSnapshot(page, options.statusSelector);
            const badgePageLoaded = isCourseBadgePage(page.url(), templateMatch[1]);
            const badgeStatus = detectCompletion(badgeSnapshot);
            if (badgePageLoaded) {
              snapshot = badgeSnapshot;
              status = {
                completed: true,
                evidence: `Completion badge available${badgeStatus.completed === true ? `: ${badgeStatus.evidence}` : ""}`
              };
            } else {
              snapshot = badgeSnapshot;
              status = {
                completed: false,
                evidence: `No completion badge; redirected to ${page.url()}`
              };
            }
          }
        }

        process.stderr.write(`[DEBUG - ${course.label}] hasCheckedCheckbox: ${snapshot.hasCheckedCheckbox}, progressValues: ${JSON.stringify(snapshot.progressValues)}, signals: ${JSON.stringify(snapshot.signals)}, bodyText length: ${snapshot.bodyText.length}\n`);
        results.push({ course: course.label, url: course.href, ...status });
        process.stderr.write(`[${index + 1}/${courses.length}] ${status.completed === true ? "COMPLETED" : status.completed === false ? "NOT COMPLETED" : "UNKNOWN"}\n`);
      } catch (err) {
        process.stderr.write(`[ERROR - ${course.label}] Failed to fetch completion status: ${err.message}\n`);
        results.push({ course: course.label, url: course.href, completed: null, evidence: `Error: ${err.message}` });
      }
    }
    return results;
  } finally {
    // Only persist the snapshot when this run actually saw an authenticated
    // session. Saving unconditionally used to overwrite a good snapshot with
    // logged-out cookies whenever a run failed, destroying the stored login.
    if (sessionVerified) {
      await context.storageState({ path: skillsStatePath }).catch((error) => {
        process.stderr.write(`[WARN] Could not save Skills session state: ${error.message}\n`);
      });
    } else {
      process.stderr.write("[DEBUG] Session was never verified this run; keeping the existing Skills session snapshot.\n");
    }
    await context.close();
  }
}
