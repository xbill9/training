#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { runScrape, runScan } from "./scraper.js";
import { updateMarkdownDb } from "./markdown-db.js";

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

program.parseAsync().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
