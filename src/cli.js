#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { runScrape, runScan } from "./scraper.js";
import { runPathsScrape, runPathsScan } from "./paths-scraper.js";
import { updateMarkdownDb } from "./markdown-db.js";
import { updatePathsDb } from "./paths-db.js";
import { updateNextUp } from "./next-up.js";
import {
  ACTIVITY_COMPLETED,
  ACTIVITY_MISSING,
  ACTIVITY_IN_PROGRESS,
  ACTIVITY_UNKNOWN,
  PATH_FINISHED,
  PATH_OPEN
} from "./path-status.js";

const program = new Command();
program.name("dri-course-checker").description("Check DRI-linked Google Partner Skills course completion");

program.command("auth")
  .description("open separate persistent browsers for portal and Skills authentication")
  .option("--readiness-profile <directory>", "Delivery Readiness browser profile", ".browser-profile-readiness")
  .option("--skills-profile <directory>", "Partner Skills browser profile", ".browser-profile-skills")
  .option("--skills-browser-profile <name>", "Chromium profile inside the Skills user-data directory", "Profile 1")
  .action(async (raw) => {
    const readinessProfile = resolve(raw.readinessProfile);
    const skillsProfile = resolve(raw.skillsProfile);
    const readinessContext = await chromium.launchPersistentContext(readinessProfile, {
      headless: false,
      viewport: { width: 1440, height: 1000 }
    });
    const skillsContext = await chromium.launchPersistentContext(skillsProfile, {
      headless: false,
      args: [`--profile-directory=${raw.skillsBrowserProfile}`],
      viewport: { width: 1440, height: 1000 }
    });
    try {
      const portal = readinessContext.pages()[0] || await readinessContext.newPage();
      await portal.goto("https://delivery-readiness-portal.cloud.google/app/gcp-projects/manage-dri-attribute", {
        waitUntil: "commit"
      }).catch(() => {});
      const skills = skillsContext.pages()[0] || await skillsContext.newPage();
      await skills.goto("https://partner.cloudskillsboost.google/paths", { waitUntil: "commit" }).catch(() => {});
      const courseCheck = await skillsContext.newPage();
      await courseCheck.goto("https://partner.cloudskillsboost.google/course_templates/829", { waitUntil: "commit" }).catch(() => {});
      console.log("\nAuthenticate in the two browser windows. Make sure course 829 loads completely in the Partner Skills window.");
      const prompt = createInterface({ input, output });
      await prompt.question("When both sites work, return here and press Enter to save the session... ");
      prompt.close();
    } finally {
      await Promise.allSettled([readinessContext.close(), skillsContext.close()]);
    }
    console.log(`Readiness authentication saved in ${readinessProfile}`);
    console.log(`Partner Skills authentication saved in ${skillsProfile}`);
  });

program.command("scrape")
  .description("scrape course links from Delivery Readiness Portal and save to a JSON cache")
  .option("--portal-url <url>", "Delivery Readiness Portal page URL")
  .option("--profile <directory>", "Delivery Readiness browser profile", ".browser-profile-readiness")
  .option("--course-selector <selector>", "CSS selector used to find course links", "a[href]")
  .option("--auth-timeout <seconds>", "time allowed for interactive sign-in", "300")
  .option("--channel <name>", "Playwright browser channel, e.g. chrome")
  .option("--headless", "run without a visible browser (after profile is signed in)")
  .option("--output <file>", "JSON file to save extracted course links", "courses.json")
  .option("--tab <name>", "name of portal tab to switch to", "LABS")
  .action(async (raw) => {
    const options = {
      ...raw,
      profile: resolve(raw.profile),
      headless: Boolean(raw.headless),
      authTimeout: Number(raw.authTimeout) * 1000,
      tab: raw.tab ? String(raw.tab).trim() : "LABS"
    };
    const links = await runScrape(options);
    const outputPath = resolve(raw.output);
    let cumulative = [];
    try {
      const { readFileSync } = await import("node:fs");
      const { existsSync } = await import("node:fs");
      if (existsSync(outputPath)) {
        cumulative = JSON.parse(readFileSync(outputPath, "utf-8"));
      }
    } catch {}

    const { normalizeCourseLinks } = await import("./course-links.js");
    const merged = normalizeCourseLinks([...cumulative, ...links]);
    await writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`Scraped ${links.length} course links from Readiness Portal. Merged total unique courses: ${merged.length}. Saved to: ${outputPath}`);
  });

program.command("scan")
  .description("scan cached course links against Partner Skills site for completion status")
  .option("--input <file>", "JSON file containing scraped course links", "courses.json")
  .option("--profile <directory>", "Partner Skills browser profile", ".browser-profile-skills")
  .option("--browser-profile <name>", "Chromium profile inside the user-data directory", "Profile 1")
  .option("--status-selector <selector>", "additional CSS selector for completion status", "")
  .option("--auth-timeout <seconds>", "time allowed for interactive sign-in", "300")
  .option("--settle-time <milliseconds>", "wait for client-rendered course status", "2000")
  .option("--channel <name>", "Playwright browser channel, e.g. chrome")
  .option("--no-headless", "run with a visible browser (non-headless)")
  .option("--json <file>", "also save results as JSON")
  .option("--markdown <file>", "Markdown completion database", "completions.md")
  .option("--course-id <id>", "check a single course matching the ID (e.g. 1722)")
  .option("--offset <count>", "skip the first N cached courses", "0")
  .option("--limit <count>", "limit scanning to the first N courses", "0")
  .action(async (raw) => {
    const options = {
      ...raw,
      profile: resolve(raw.profile),
      browserProfile: raw.browserProfile,
      headless: raw.headless !== false,
      authTimeout: Number(raw.authTimeout) * 1000,
      settleTime: Number(raw.settleTime),
      courseId: raw.courseId ? String(raw.courseId).trim() : null,
      offset: Number(raw.offset) || 0,
      limit: Number(raw.limit) || 0
    };
    const results = await runScan(resolve(raw.input), options);
    console.table(results.map(({ course, completed, evidence, url }) => ({
      course,
      status: completed === true ? "COMPLETED" : completed === false ? "NOT COMPLETED" : "UNKNOWN",
      evidence,
      url
    })));
    if (raw.json) await writeFile(raw.json, `${JSON.stringify(results, null, 2)}\n`);
    await updateMarkdownDb(resolve(raw.markdown), results);
    console.log(`Updated clickable completion tracker: ${resolve(raw.markdown)}`);
    if (results.some((item) => item.completed !== true)) process.exitCode = 2;
  });

program.command("check", { isDefault: true })
  .description("run scrape and scan sequentially")
  .option("--portal-url <url>", "Delivery Readiness Portal page URL")
  .option("--readiness-profile <directory>", "Delivery Readiness browser profile", ".browser-profile-readiness")
  .option("--skills-profile <directory>", "Partner Skills browser profile", ".browser-profile-skills")
  .option("--skills-browser-profile <name>", "Chromium profile inside the Skills user-data directory", "Profile 1")
  .option("--course-selector <selector>", "CSS selector used to find course links", "a[href]")
  .option("--status-selector <selector>", "additional CSS selector for completion status", "")
  .option("--auth-timeout <seconds>", "time allowed for interactive sign-in", "300")
  .option("--settle-time <milliseconds>", "wait for client-rendered course status", "2000")
  .option("--channel <name>", "Playwright browser channel, e.g. chrome")
  .option("--headless", "run without a visible browser (after profile is signed in)")
  .option("--json <file>", "also save results as JSON")
  .option("--markdown <file>", "Markdown completion database", "completions.md")
  .option("--course-id <id>", "check a single course matching the ID (e.g. 1722)")
  .option("--tab <name>", "name of portal tab to switch to", "LABS")
  .action(async (raw) => {
    const cacheFile = resolve("courses.json");
    const options = {
      ...raw,
      headless: Boolean(raw.headless),
      authTimeout: Number(raw.authTimeout) * 1000,
      settleTime: Number(raw.settleTime),
      courseId: raw.courseId ? String(raw.courseId).trim() : null,
      tab: raw.tab ? String(raw.tab).trim() : "LABS"
    };
    if (!Number.isFinite(options.authTimeout) || !Number.isFinite(options.settleTime)) {
      throw new Error("Timeout values must be numbers");
    }
    const links = await runScrape({ ...options, profile: resolve(raw.readinessProfile) });
    let cumulative = [];
    try {
      const { readFileSync } = await import("node:fs");
      const { existsSync } = await import("node:fs");
      if (existsSync(cacheFile)) {
        cumulative = JSON.parse(readFileSync(cacheFile, "utf-8"));
      }
    } catch {}

    const { normalizeCourseLinks } = await import("./course-links.js");
    const merged = normalizeCourseLinks([...cumulative, ...links]);
    await writeFile(cacheFile, `${JSON.stringify(merged, null, 2)}\n`);
    const results = await runScan(cacheFile, {
      ...options,
      profile: resolve(raw.skillsProfile),
      browserProfile: raw.skillsBrowserProfile
    });
    console.table(results.map(({ course, completed, evidence, url }) => ({
      course,
      status: completed === true ? "COMPLETED" : completed === false ? "NOT COMPLETED" : "UNKNOWN",
      evidence,
      url
    })));
    if (raw.json) await writeFile(raw.json, `${JSON.stringify(results, null, 2)}\n`);
    await updateMarkdownDb(resolve(raw.markdown), results);
    console.log(`Updated clickable completion tracker: ${resolve(raw.markdown)}`);
    if (results.some((item) => item.completed !== true)) process.exitCode = 2;
  });

function skillsOptions(raw) {
  return {
    ...raw,
    profile: resolve(raw.profile),
    browserProfile: raw.browserProfile,
    // Opt-in, unlike `scan`. Google frequently refuses a perfectly good session
    // when the browser identifies as headless, and the recovery is a second
    // launch — so the reliable mode is the default one.
    headless: Boolean(raw.headless),
    authTimeout: Number(raw.authTimeout) * 1000,
    settleTime: Number(raw.settleTime)
  };
}

function addSkillsOptions(command) {
  return command
    .option("--profile <directory>", "Partner Skills browser profile", ".browser-profile-skills")
    .option("--browser-profile <name>", "Chromium profile inside the user-data directory", "Profile 1")
    .option("--auth-timeout <seconds>", "time allowed for interactive sign-in", "300")
    .option("--settle-time <milliseconds>", "wait for client-rendered content", "2500")
    .option("--channel <name>", "Playwright browser channel, e.g. chrome")
    .option("--headless", "run without a visible browser (Google often rejects headless sessions)");
}

async function discoverPathsToFile(options, outputFile) {
  const paths = await runPathsScrape(options);
  const outputPath = resolve(outputFile);
  let cumulative = [];
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    if (existsSync(outputPath)) cumulative = JSON.parse(readFileSync(outputPath, "utf-8"));
  } catch {}
  const byId = new Map(cumulative.map((path) => [String(path.id), path]));
  for (const path of paths) {
    const existing = byId.get(String(path.id));
    byId.set(String(path.id), { ...existing, ...path, title: path.title || existing?.title || "" });
  }
  const merged = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  await writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Discovered ${paths.length} paths. Merged total unique paths: ${merged.length}. Saved to: ${outputPath}`);
  return outputPath;
}

async function scanPathsToMarkdown(inputFile, options, raw, precomputed = null, linkStatus = null) {
  const results = precomputed || await runPathsScan(resolve(inputFile), options);
  if (raw.json) await writeFile(raw.json, `${JSON.stringify(results, null, 2)}\n`);
  const { paths, activities } = await updatePathsDb(
    resolve(raw.pathsMarkdown),
    resolve(raw.activitiesMarkdown),
    results,
    new Date().toISOString(),
    linkStatus
  );
  const worklist = await updateNextUp(resolve(raw.nextUp || "next-up.md"), paths, activities);
  const finished = paths.filter((path) => path.status === PATH_FINISHED).length;
  const open = paths.filter((path) => path.status === PATH_OPEN).length;
  const outstanding = activities.filter((activity) => activity.status !== ACTIVITY_COMPLETED).length;
  const issues = activities.filter((activity) => [ACTIVITY_IN_PROGRESS, ACTIVITY_MISSING, ACTIVITY_UNKNOWN]
    .includes(activity.status)).length;
  console.log(`\n${paths.length} paths tracked: ${finished} finished, ${open} open.`);
  console.log(`${activities.length} activities tracked: ${outstanding} outstanding, ${issues} needing attention.`);
  console.log(`Updated ${resolve(raw.pathsMarkdown)}, ${resolve(raw.activitiesMarkdown)} and ${resolve(raw.nextUp || "next-up.md")}`);
  const wins = worklist.quickWins.slice(0, 10);
  const winPaths = new Set(wins.flatMap((g) => g.completes.map((p) => p.id))).size;
  console.log(`Next up: ${worklist.unique} distinct activities left; top 10 would finish ${winPaths} paths.`);
  if (outstanding > 0) process.exitCode = 2;
}

addSkillsOptions(program.command("paths-scrape")
  .description("discover every learning path in the Skills catalog and cache it as JSON"))
  .option("--output <file>", "JSON file to save discovered paths", "paths.json")
  .option("--max-pages <count>", "safety limit on catalog pages to walk", "50")
  .action(async (raw) => {
    await discoverPathsToFile({ ...skillsOptions(raw), maxPages: Number(raw.maxPages) || 50 }, raw.output);
  });

addSkillsOptions(program.command("paths-scan")
  .description("read each cached path page and update the paths/activities Markdown database"))
  .option("--input <file>", "JSON file containing discovered paths", "paths.json")
  .option("--paths-markdown <file>", "Markdown database of paths", "paths.md")
  .option("--activities-markdown <file>", "Markdown database of path activities", "activities.md")
  .option("--next-up <file>", "ranked worklist generated from the database", "next-up.md")
  .option("--json <file>", "also save the raw scan as JSON")
  .option("--path-id <id>", "scan a single path by ID (e.g. 12)")
  .option("--offset <count>", "skip the first N cached paths", "0")
  .option("--limit <count>", "limit scanning to the first N paths", "0")
  .option("--verify-links", "also check that outstanding activity links still resolve")
  .option("--navigate", "open each path page instead of fetching it (slower fallback)")
  .action(async (raw) => {
    const options = {
      ...skillsOptions(raw),
      navigate: Boolean(raw.navigate),
      pathId: raw.pathId ? String(raw.pathId).trim() : null,
      offset: Number(raw.offset) || 0,
      limit: Number(raw.limit) || 0,
      verifyLinks: Boolean(raw.verifyLinks)
    };
    await scanPathsToMarkdown(raw.input, options, raw);
  });

addSkillsOptions(program.command("paths")
  .description("discover paths and scan them in one run"))
  .option("--input <file>", "JSON cache of discovered paths", "paths.json")
  .option("--paths-markdown <file>", "Markdown database of paths", "paths.md")
  .option("--activities-markdown <file>", "Markdown database of path activities", "activities.md")
  .option("--next-up <file>", "ranked worklist generated from the database", "next-up.md")
  .option("--json <file>", "also save the raw scan as JSON")
  .option("--offset <count>", "skip the first N cached paths", "0")
  .option("--limit <count>", "limit scanning to the first N paths", "0")
  .option("--max-pages <count>", "safety limit on catalog pages to walk", "50")
  .option("--verify-links", "also check that outstanding activity links still resolve")
  .option("--navigate", "open each path page instead of fetching it (slower fallback)")
  .action(async (raw) => {
    const base = { ...skillsOptions(raw), navigate: Boolean(raw.navigate) };
    const cacheFile = await discoverPathsToFile({ ...base, maxPages: Number(raw.maxPages) || 50 }, raw.input);
    await scanPathsToMarkdown(cacheFile, {
      ...base,
      pathId: null,
      offset: Number(raw.offset) || 0,
      limit: Number(raw.limit) || 0,
      verifyLinks: Boolean(raw.verifyLinks)
    }, raw);
  });

program.command("paths-import <file>")
  .description("build the Markdown database from a scan JSON captured in the browser (no Playwright)")
  .option("--paths-markdown <file>", "Markdown database of paths", "paths.md")
  .option("--activities-markdown <file>", "Markdown database of path activities", "activities.md")
  .option("--next-up <file>", "ranked worklist generated from the database", "next-up.md")
  .action(async (file, raw) => {
    const { readFileSync } = await import("node:fs");
    const scanned = JSON.parse(readFileSync(resolve(file), "utf-8"));
    const results = Array.isArray(scanned) ? scanned : scanned.results;
    if (!Array.isArray(results)) throw new Error(`${file} does not contain a scan array`);
    // Paths the capture could not read still belong in the database as UNKNOWN.
    // Dropping them would quietly shrink the catalog and hide, say, a path this
    // account is not entitled to open.
    const failed = (Array.isArray(scanned?.failed) ? scanned.failed : []).map(([id, reason]) => ({
      id: String(id),
      title: `Path ${id}`,
      url: `https://partner.skills.google/paths/${id}`,
      activities: [],
      progress: null,
      unreadable: true,
      evidence: typeof reason === "number" ? `HTTP ${reason} for /paths/${id}` : String(reason)
    }));
    if (failed.length) console.log(`${failed.length} path(s) could not be read; recording them as unknown.`);
    // Optional {url: status} map from a link check run alongside the scan.
    const linkStatus = scanned?.linkStatus && typeof scanned.linkStatus === "object" ? scanned.linkStatus : null;
    if (linkStatus) console.log(`Applying ${Object.keys(linkStatus).length} verified link statuses.`);
    await scanPathsToMarkdown(null, null, raw, [...results, ...failed], linkStatus);
  });

program.parseAsync().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
