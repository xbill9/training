import { readFileSync } from "node:fs";
import { canonicalActivityUrl } from "./paths-db.js";
import {
  isGoogleServerErrorPage,
  launchSkillsContext,
  navigate,
  saveSkillsState,
  verifySkillsSession
} from "./scraper.js";

const SKILLS_ORIGIN = "https://partner.skills.google";

// The catalog filtered to learning plans is the only complete list of paths;
// the /paths landing page only shows a handful per category.
const PATHS_CATALOG_URL = `${SKILLS_ORIGIN}/catalog?format%5B%5D=learning_plans`;
const PATHS_PER_CATALOG_PAGE = 8;

export function pathUrl(id) {
  return `${SKILLS_ORIGIN}/paths/${id}`;
}

// Everything on Skills is rendered by lit web components, so the interesting
// nodes live in shadow roots that document.querySelectorAll cannot see. This
// walker is injected into the page by every extraction below.
const WALK_SHADOW_DOM = `
  function* walk(root) {
    for (const el of root.querySelectorAll("*")) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
    }
  }
`;

async function isUnreadable(page) {
  const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (isGoogleServerErrorPage(body)) return "Google served its server-error page";
  if (/page you were looking for doesn't exist|404/i.test(body) && body.length < 600) return "Page not found (404)";
  if (body.length < 200) return "Page failed to load or render";
  return "";
}

async function readCatalogPage(page, pageNumber, settleTime) {
  await navigate(page, `${PATHS_CATALOG_URL}&page=${pageNumber}`);
  await page.waitForTimeout(settleTime);
  return page.evaluate(`(() => {
    ${WALK_SHADOW_DOM}
    const els = [...walk(document)];
    const ids = new Map();
    for (const el of els) {
      if (el.tagName !== "A") continue;
      const href = el.getAttribute("href") || "";
      const match = href.match(/^\\/paths\\/(\\d+)/);
      if (!match) continue;
      const title = el.getAttribute("title") || (el.innerText || "").trim().split("\\n")[0] || "";
      if (!ids.has(match[1]) || (title && !ids.get(match[1]))) ids.set(match[1], title);
    }
    let total = null;
    for (const el of els) {
      if (el.children.length) continue;
      const found = (el.textContent || "").match(/\\d+\\s*-\\s*\\d+\\s+of\\s+(\\d+)/);
      if (found) { total = Number.parseInt(found[1], 10); break; }
    }
    return { paths: [...ids].map(([id, title]) => ({ id, title })), total };
  })()`);
}

// Catalog listings are rendered client-side, so a fetched page has no anchors
// to parse — but the path ids are still in the payload. Scraping them out with
// a regex turns 26 navigations (~2 minutes of settle waits) into 26 fetches
// (~15 seconds). Titles come from each path page's <h1> during the scan.
export async function discoverPathsByFetch(page, options = {}) {
  const maxPages = options.maxPages ?? 50;
  const found = new Set();

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 4) {
    const batch = [pageNumber, pageNumber + 1, pageNumber + 2, pageNumber + 3]
      .filter((number) => number <= maxPages);
    const ids = await page.evaluate(async ({ pages }) => {
      const readOne = async (number) => {
        const response = await fetch(`/catalog?format%5B%5D=learning_plans&page=${number}`, { credentials: "include" });
        if (!response.ok) return [];
        const html = await response.text();
        return [...html.matchAll(/\/paths\/(\d+)/g)].map((match) => match[1]);
      };
      const results = await Promise.all(pages.map(readOne));
      return results.flat();
    }, { pages: batch });

    const before = found.size;
    ids.forEach((id) => found.add(id));
    process.stderr.write(`[catalog pages ${batch[0]}-${batch[batch.length - 1]}] ${found.size} paths discovered\n`);
    // The catalog serves the last page again once the page number runs past
    // the end, so a batch that adds nothing means we have them all.
    if (found.size === before) break;
  }

  return [...found].map((id) => ({ id, title: "", url: pathUrl(id) }));
}

// Walk the learning-plan catalog and return every path id. Titles are captured
// when the card exposes one; the path page is authoritative and fills the rest.
export async function discoverPaths(page, options = {}) {
  const settleTime = options.settleTime ?? 2500;
  const maxPages = options.maxPages ?? 50;
  const found = new Map();
  let total = null;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const result = await readCatalogPage(page, pageNumber, settleTime);
    if (result.total !== null) total = result.total;
    const before = found.size;
    for (const item of result.paths) {
      if (!found.has(item.id) || (item.title && !found.get(item.id).title)) {
        found.set(item.id, { id: item.id, title: item.title, url: pathUrl(item.id) });
      }
    }
    process.stderr.write(
      `[catalog page ${pageNumber}] ${result.paths.length} paths on page, ${found.size}`
      + `${total ? `/${total}` : ""} discovered\n`
    );
    if (!result.paths.length) break;
    // A page that adds nothing new means the catalog looped back to the last
    // page instead of erroring on an out-of-range page number.
    if (found.size === before) break;
    if (total && found.size >= total) break;
    if (total && pageNumber >= Math.ceil(total / PATHS_PER_CATALOG_PAGE)) break;
  }

  if (total && found.size < total) {
    process.stderr.write(`[WARN] Catalog reports ${total} paths but only ${found.size} were extracted.\n`);
  }
  return [...found.values()];
}

// Read one path page: its headline progress plus every activity card, each of
// which already carries its own completion state. This is why a path scan can
// cover 1000+ activities without opening a single course page.
export async function readPathPage(page, path, options = {}) {
  const settleTime = options.settleTime ?? 2500;
  await navigate(page, path.url);
  await page.waitForTimeout(settleTime);

  let problem = await isUnreadable(page);
  // The 500s cluster under rapid sequential requests, so back off and retry
  // rather than recording a fabricated "not started".
  for (let retry = 1; retry <= 2 && problem; retry += 1) {
    process.stderr.write(`  ${problem}; retry ${retry}/2 after a pause...\n`);
    await page.waitForTimeout(5000);
    await navigate(page, path.url);
    await page.waitForTimeout(settleTime);
    problem = await isUnreadable(page);
  }
  if (problem) {
    return { ...path, activities: [], progress: null, unreadable: true, evidence: problem };
  }

  const scraped = await page.evaluate(`(() => {
    ${WALK_SHADOW_DOM}
    const els = [...walk(document)];
    const cards = els.filter((el) => el.tagName === "QL-ACTIVITY-CARD");
    const cardBars = new Set();

    const progressOf = (el) => {
      const raw = el.getAttribute("progress");
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : null;
    };

    const activities = cards.map((card) => {
      const inside = [card, ...walk(card), ...(card.shadowRoot ? [...walk(card.shadowRoot)] : [])];
      const bar = inside.find((el) => el.tagName === "QL-PROGRESS-BAR");
      if (bar) cardBars.add(bar);
      const href = card.getAttribute("path") || "";
      return {
        name: card.getAttribute("name") || "",
        type: card.getAttribute("type") || "",
        credentialType: card.getAttribute("credential-type") || "",
        duration: card.getAttribute("duration") || "",
        url: href ? new URL(href, location.origin).href : "",
        completed: card.hasAttribute("completed"),
        progress: bar ? progressOf(bar) : null
      };
    });

    const headlineBar = els.find((el) => el.tagName === "QL-PROGRESS-BAR" && !cardBars.has(el));
    const heading = document.querySelector("h1");
    const activityCount = (document.body.innerText.match(/(\\d+)\\s+activities/) || [])[1];

    return {
      title: (heading && heading.innerText.trim())
        || document.title.replace(/\\s*\\|\\s*Google Skills.*$/, "").trim(),
      progress: headlineBar ? progressOf(headlineBar) : null,
      reportedActivityCount: activityCount ? Number.parseInt(activityCount, 10) : null,
      activities
    };
  })()`);

  // Cards render progressively; a page that shows fewer cards than its own
  // "N activities" header was read too early to trust as a full listing.
  const reread = options.reread ?? 0;
  if (reread < 2 && scraped?.reportedActivityCount && (scraped.activities?.length ?? 0) < scraped.reportedActivityCount) {
    process.stderr.write(
      `  Only ${scraped.activities?.length ?? 0}/${scraped.reportedActivityCount} activity cards rendered; waiting...\n`
    );
    await page.waitForTimeout(3000);
    const retried = await page.evaluate(`(() => {
      ${WALK_SHADOW_DOM}
      return [...walk(document)].filter((el) => el.tagName === "QL-ACTIVITY-CARD").length;
    })()`);
    if (retried > (scraped.activities?.length ?? 0)) {
      return readPathPage(page, path, { ...options, settleTime: settleTime + 2000, reread: reread + 1 });
    }
  }

  // Never hand back a record without an activities array: callers count and
  // filter it, and a malformed extraction should read as "nothing found here"
  // rather than crashing the whole scan.
  return {
    ...path,
    title: scraped?.title || path.title || `Path ${path.id}`,
    progress: scraped?.progress ?? null,
    activities: Array.isArray(scraped?.activities) ? scraped.activities : [],
    unreadable: false,
    evidence: ""
  };
}

// Bulk read: fetch path pages from inside one authenticated page instead of
// navigating to each. Google renders the activity cards server-side — name,
// type, duration, `completed` and `progress` are all attributes in the HTML —
// so a fetch returns exactly what a navigation would, minus the render cost.
// Measured against the live catalog: 207 paths in ~2.5 minutes, versus roughly
// a second per navigation.
export async function readPathsByFetch(page, paths, options = {}) {
  const concurrency = options.concurrency ?? 4;
  const pause = options.pause ?? 150;
  // Read in batches rather than one long evaluate: the work is identical, but
  // Node regains control between batches to print progress. A stage that runs
  // several minutes in silence is indistinguishable from a hang.
  const batchSize = options.batchSize ?? 20;
  const ids = paths.map((path) => String(path.id));
  const byId = new Map(paths.map((path) => [String(path.id), path]));

  const scraped = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize);
    const part = await readPathBatch(page, batch, concurrency, pause);
    if (!Array.isArray(part)) break;
    scraped.push(...part);
    const activities = scraped.reduce((sum, item) => sum + (item.activities?.length || 0), 0);
    process.stderr.write(`  ${scraped.length}/${ids.length} paths, ${activities} activities\n`);
  }

  if (!scraped.length) {
    process.stderr.write("[WARN] Fetch mode returned no usable result; falling back to navigation.\n");
    return [];
  }

  return scraped.map((result) => {
    const path = byId.get(String(result.id)) || { id: result.id };
    const url = path.url || pathUrl(result.id);
    if (result.unreadable) {
      return { ...path, url, activities: [], progress: null, unreadable: true, evidence: result.evidence };
    }
    return {
      ...path,
      url,
      title: result.title || path.title || `Path ${result.id}`,
      progress: result.progress,
      unreadable: false,
      evidence: "",
      activities: result.activities.map((activity) => ({
        ...activity,
        url: activity.url ? new URL(activity.url, SKILLS_ORIGIN).href : ""
      }))
    };
  });
}

function readPathBatch(page, ids, concurrency, pause) {
  return page.evaluate(
    async ({ ids, concurrency, pause }) => {
      const num = (value) => {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const results = [];
      const readOne = async (id) => {
        try {
          const response = await fetch(`/paths/${id}`, { credentials: "include" });
          if (!response.ok) {
            results.push({ id, unreadable: true, evidence: `HTTP ${response.status} for /paths/${id}` });
            return;
          }
          const doc = new DOMParser().parseFromString(await response.text(), "text/html");
          const cards = [...doc.querySelectorAll("ql-activity-card")];
          const cardBars = new Set(cards.flatMap((card) => [...card.querySelectorAll("ql-progress-bar")]));
          const headline = [...doc.querySelectorAll("ql-progress-bar")].find((bar) => !cardBars.has(bar));
          const heading = doc.querySelector("h1");
          const reported = (doc.body.textContent.match(/(\d+)\s+activities/) || [])[1];
          results.push({
            id,
            title: heading ? heading.textContent.trim() : "",
            progress: headline ? num(headline.getAttribute("progress")) : null,
            reportedActivityCount: reported ? Number.parseInt(reported, 10) : null,
            activities: cards.map((card) => ({
              name: card.getAttribute("name") || "",
              type: card.getAttribute("type") || "",
              credentialType: card.getAttribute("credential-type") || "",
              duration: card.getAttribute("duration") || "",
              url: (card.getAttribute("path") || "").split("?")[0],
              completed: card.hasAttribute("completed"),
              progress: num(card.getAttribute("progress"))
            }))
          });
        } catch (error) {
          results.push({ id, unreadable: true, evidence: `Error: ${String(error).slice(0, 120)}` });
        }
      };
      for (let index = 0; index < ids.length; index += concurrency) {
        await Promise.all(ids.slice(index, index + concurrency).map(readOne));
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
      return results;
    },
    { ids, concurrency, pause }
  );
}

// Optional pass: confirm that outstanding activities still resolve. Runs as
// same-origin fetches from the signed-in page, so it costs one request each and
// only touches work that is not already done.
export async function verifyActivityLinks(page, paths, options = {}) {
  // Slow and serial on purpose. Google serves 403 to bursts of parallel
  // requests, and intermittent 500s during ordinary browsing, so a fast pass
  // invents broken labs that are not broken.
  const pause = options.pause ?? 400;
  const attempts = options.attempts ?? 3;
  const targets = [];
  for (const path of paths) {
    for (const activity of path.activities || []) {
      if (activity.completed === true || !activity.url) continue;
      // Session-scoped URLs belong to activities already started, so they
      // demonstrably exist; fetching them would also poke at live lab sessions.
      if (activity.url.includes("/course_sessions/")) continue;
      targets.push(activity);
    }
  }
  if (!targets.length) return;
  process.stderr.write(`Verifying ${targets.length} outstanding activity links...\n`);
  // Lab pages provision an environment before responding — 30s is normal, so a
  // short timeout reports healthy labs as failures.
  const probe = (url) => page.evaluate(async ({ target, timeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(target, {
        credentials: "include",
        redirect: "follow",
        signal: controller.signal
      });
      if (!response.ok) return response.status;
      const body = await response.text();
      // Retired content answers 200 but lands on the dashboard; Google never
      // serves a 404 for a missing course.
      if (new URL(response.url).pathname === "/") return "gone";
      if (/we.re sorry, but something went wrong/i.test(body)) return "500page";
      return 200;
    } catch (error) {
      return error.name === "AbortError" ? "timeout" : 0;
    } finally {
      clearTimeout(timer);
    }
  }, { target: url, timeout: url.includes("/focuses/") ? 60000 : 20000 }).catch(() => 0);

  // Only a failure that repeats across spaced-out attempts counts. A transient
  // 500 or a throttled 403 clears on retry; genuinely dead content does not.
  // Google never 404s a missing course; it bounces to the dashboard instead.
  const isDead = (status) => status === 404 || status === 410 || status === "gone";
  const isFlaky = (status) => status === 0 || status === 500 || status === 502
    || status === 503 || status === "500page" || status === "timeout";

  for (const [index, activity] of targets.entries()) {
    let status = await probe(canonicalActivityUrl(activity.url, path.id));
    for (let attempt = 1; attempt < attempts && isFlaky(status); attempt += 1) {
      await page.waitForTimeout(pause * 5 * attempt);
      status = await probe(canonicalActivityUrl(activity.url, path.id));
    }
    if (status === "gone") {
      activity.linkBroken = "Retired — redirects to the dashboard";
    } else if (isDead(status)) {
      activity.linkBroken = `HTTP ${status}`;
    } else if (isFlaky(status)) {
      // Failed every attempt: report it, but say what it was rather than
      // claiming the content is gone.
      activity.linkBroken = status === "500page" ? `Google error page on ${attempts} attempts` : `HTTP ${status} on ${attempts} attempts`;
    }
    if ((index + 1) % 25 === 0) process.stderr.write(`  checked ${index + 1}/${targets.length}\n`);
    await page.waitForTimeout(pause);
  }
}

export async function runPathsScrape(options) {
  const context = await launchSkillsContext({ ...options, replicateCookies: false });
  let sessionVerified = false;
  try {
    const page = context.pages()[0] || await context.newPage();
    if (await verifySkillsSession(page, options) === "retry-headful") {
      await context.close().catch(() => {});
      return runPathsScrape({ ...options, headless: false });
    }
    sessionVerified = true;
    return options.navigate ? await discoverPaths(page, options) : await discoverPathsByFetch(page, options);
  } finally {
    await saveSkillsState(context, options, sessionVerified);
    await context.close();
  }
}

export async function runPathsScan(inputPath, options) {
  let paths = JSON.parse(readFileSync(inputPath, "utf-8"));
  if (options.pathId) {
    paths = paths.filter((path) => String(path.id) === String(options.pathId));
    if (!paths.length) throw new Error(`No path with ID "${options.pathId}" is cached in ${inputPath}.`);
  }
  if (options.offset > 0) paths = paths.slice(options.offset);
  if (options.limit > 0) paths = paths.slice(0, options.limit);

  const context = await launchSkillsContext({ ...options, replicateCookies: false });
  let sessionVerified = false;
  try {
    const page = context.pages()[0] || await context.newPage();
    if (await verifySkillsSession(page, options) === "retry-headful") {
      await context.close().catch(() => {});
      return runPathsScan(inputPath, { ...options, headless: false });
    }
    sessionVerified = true;

    if (!options.navigate) {
      process.stderr.write(`Fetching ${paths.length} path pages from the authenticated session...\n`);
      const fetched = await readPathsByFetch(page, paths, options);
      const unreadable = fetched.filter((path) => path.unreadable);
      for (const path of unreadable) process.stderr.write(`  ${path.id}: ${path.evidence}\n`);
      process.stderr.write(
        `Read ${fetched.length - unreadable.length}/${paths.length} paths, `
        + `${fetched.reduce((sum, path) => sum + path.activities.length, 0)} activities.\n`
      );
      // Fall back only when fetch mode itself is broken: either it returned
      // nothing at all, or every page that *did* load has no activity cards,
      // which means Google changed its markup. A run where the only failures
      // are per-path (a 403 on a path this account cannot open) is a correct
      // result, not a reason to re-read everything by navigation.
      const readable = fetched.filter((path) => !path.unreadable);
      const markupBroken = fetched.length === 0
        || (readable.length > 0 && readable.every((path) => !path.activities.length));
      if (!markupBroken) {
        if (options.verifyLinks) await verifyActivityLinks(page, fetched, options);
        return fetched;
      }
      process.stderr.write("No activity cards came back from fetch mode; falling back to navigation.\n");
    }

    const results = [];
    for (const [index, path] of paths.entries()) {
      const label = path.title || `Path ${path.id}`;
      process.stderr.write(`[${index + 1}/${paths.length}] ${label}: ${path.url}\n`);
      try {
        const result = await readPathPage(page, { ...path, url: path.url || pathUrl(path.id) }, options);
        const done = result.activities.filter((a) => a.completed === true).length;
        process.stderr.write(
          result.unreadable
            ? `  UNKNOWN (${result.evidence})\n`
            : `  ${done}/${result.activities.length} activities complete\n`
        );
        results.push(result);
      } catch (error) {
        process.stderr.write(`  [ERROR] ${error.message}\n`);
        results.push({
          ...path,
          url: path.url || pathUrl(path.id),
          activities: [],
          progress: null,
          unreadable: true,
          evidence: `Error: ${error.message}`
        });
      }
    }

    if (options.verifyLinks) await verifyActivityLinks(page, results, options);
    return results;
  } finally {
    await saveSkillsState(context, options, sessionVerified);
    await context.close();
  }
}
