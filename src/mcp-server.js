#!/usr/bin/env node
// MCP server over the Markdown training database.
//
// The Markdown files are the database, so every read tool simply parses them —
// there is no second source of truth to drift. Write tools shell out to the same
// code paths the CLI uses, so a refresh through MCP and a refresh through
// `npm run paths` produce identical files.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ACTIVITY_COMPLETED,
  ACTIVITY_IN_PROGRESS,
  ACTIVITY_MISSING,
  ACTIVITY_NOT_STARTED,
  ACTIVITY_UNKNOWN,
  PATH_FINISHED,
  PATH_NOT_STARTED,
  PATH_OPEN,
  PATH_UNKNOWN
} from "./path-status.js";
import { canonicalActivityUrl, parseActivitiesMarkdown, parsePathsMarkdown, updatePathsDb } from "./paths-db.js";
import { buildWorklist, formatDuration, updateNextUp } from "./next-up.js";

// Where the database lives. Set TRAINING_DIR when the server runs from
// somewhere other than the repository.
const ROOT = process.env.TRAINING_DIR ? resolve(process.env.TRAINING_DIR) : process.cwd();
const file = (name) => resolve(ROOT, name);

async function readDb() {
  const [pathsMd, activitiesMd] = await Promise.all([
    readFile(file("paths.md"), "utf8").catch(() => ""),
    readFile(file("activities.md"), "utf8").catch(() => "")
  ]);
  const paths = parsePathsMarkdown(pathsMd);
  const activities = parseActivitiesMarkdown(activitiesMd);
  if (!paths.length) {
    throw new Error(
      `No training database found in ${ROOT}. Run "npm run paths" or `
      + `"npm run paths-import -- <scan.json>" first, or set TRAINING_DIR.`
    );
  }
  return { paths, activities };
}

const text = (body) => ({ content: [{ type: "text", text: body }] });

const isBlocked = (activity) => /access denied/i.test(String(activity.issue || ""));

function activityLine(activity) {
  const bits = [activity.status];
  if (activity.duration) bits.push(activity.duration);
  if (activity.issue) bits.push(activity.issue);
  return `- ${activity.name} — ${bits.join(" · ")}`;
}

const server = new McpServer({ name: "partner-training", version: "1.0.0" });

server.registerTool("training_summary", {
  title: "Training summary",
  description: "Overall progress: how many learning paths are finished, open, or blocked, and how much work is outstanding. Start here.",
  inputSchema: {}
}, async () => {
  const { paths, activities } = await readDb();
  const work = buildWorklist(paths, activities);
  const count = (list, status) => list.filter((item) => item.status === status).length;
  const blocked = activities.filter(isBlocked);
  const blockedPaths = new Set(blocked.map((a) => a.pathId));

  return text([
    `# Training summary (${ROOT})`,
    "",
    `**Paths** — ${count(paths, PATH_FINISHED)} finished · ${count(paths, PATH_OPEN)} open · `
      + `${count(paths, PATH_NOT_STARTED)} not started · ${count(paths, PATH_UNKNOWN)} unknown `
      + `(${paths.length} total)`,
    `**Activities** — ${count(activities, ACTIVITY_COMPLETED)} completed · `
      + `${count(activities, ACTIVITY_NOT_STARTED)} not started · `
      + `${count(activities, ACTIVITY_IN_PROGRESS)} started but stalled · `
      + `${count(activities, ACTIVITY_MISSING)} missing · ${count(activities, ACTIVITY_UNKNOWN)} unreadable`,
    "",
    `**Outstanding**: ${work.slots} slots = ${work.unique} distinct activities (~${Math.round(work.totalMinutes / 60)}h). `
      + "The gap is the same course appearing in several paths.",
    `**Blocked**: ${blocked.length} activities are access-denied, holding up ${blockedPaths.size} paths.`,
    `**Nearly done**: ${work.nearMiss.length} paths are within 2 activities of finished.`,
    "",
    `Top recommendation: ${work.quickWins[0]
      ? `${work.quickWins[0].name} (${formatDuration(work.quickWins[0].minutes)}, finishes ${work.quickWins[0].completes.length} path(s))`
      : "nothing outstanding"}`
  ].join("\n"));
});

server.registerTool("next_up", {
  title: "What to do next",
  description: "Ranked work recommendations. Sections: quick_wins (finishes a path outright, ranked by time per path completed), leverage (shared across many paths), stalled (already part-finished), blocked (access denied — an access request, not study), near_miss (paths within 2 activities of done).",
  inputSchema: {
    section: z.enum(["quick_wins", "leverage", "stalled", "blocked", "near_miss"]).default("quick_wins")
      .describe("Which ranking to return"),
    limit: z.number().int().min(1).max(100).default(10).describe("How many entries")
  }
}, async ({ section, limit }) => {
  const { paths, activities } = await readDb();
  const work = buildWorklist(paths, activities);

  if (section === "near_miss") {
    const rows = work.nearMiss.slice(0, limit)
      .map((path) => `- **${path.left} left** — ${path.title} (${path.url})`);
    return text([`# Paths within 2 activities of done (${work.nearMiss.length})`, "", ...rows].join("\n"));
  }

  const groups = work[section] || [];
  const rows = groups.slice(0, limit).map((group) => {
    const notes = [];
    if (group.completes.length) notes.push(`finishes ${group.completes.length} path(s)`);
    if (group.paths.length > group.completes.length) notes.push(`in ${group.paths.length} paths`);
    if (group.percent) notes.push(`${group.percent}% done`);
    const url = canonicalActivityUrl(group.url, (group.completes[0] || group.paths[0] || {}).id);
    return `- **${formatDuration(group.minutes)}** — ${group.name}${notes.length ? ` — ${notes.join(", ")}` : ""}\n  ${url}`;
  });

  const header = section === "blocked"
    ? `# Blocked — access denied (${groups.length})\n\nVerified 403: the content exists but this account cannot open it.`
    : `# ${section.replace("_", " ")} (${groups.length} total, showing ${rows.length})`;
  return text([header, "", ...(rows.length ? rows : ["_Nothing here._"])].join("\n"));
});

server.registerTool("find_activity", {
  title: "Find a course or lab",
  description: "Search activities by name. Returns status, duration, an openable URL, and every path the activity belongs to.",
  inputSchema: {
    query: z.string().min(2).describe("Substring of the activity name, case-insensitive"),
    limit: z.number().int().min(1).max(25).default(5)
  }
}, async ({ query, limit }) => {
  const { activities } = await readDb();
  const needle = query.toLowerCase();
  const matches = activities.filter((activity) => activity.name.toLowerCase().includes(needle));
  if (!matches.length) return text(`No activity matching "${query}".`);

  // One activity sits in many paths; group so the answer is per activity.
  const byName = new Map();
  for (const activity of matches) {
    const key = activity.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { ...activity, paths: [] });
    byName.get(key).paths.push(activity);
  }

  const blocks = [...byName.values()].slice(0, limit).map((group) => {
    const url = canonicalActivityUrl(group.url, group.paths[0].pathId);
    return [
      `## ${group.name}`,
      `${group.type} · ${group.duration || "duration unknown"} · ${group.status}${group.issue ? ` · ${group.issue}` : ""}`,
      url,
      "",
      `In ${group.paths.length} path(s):`,
      ...group.paths.map((p) => `- ${p.pathTitle} (${p.pathUrl})`)
    ].join("\n");
  });
  return text(blocks.join("\n\n"));
});

server.registerTool("list_paths", {
  title: "List learning paths",
  description: "List paths, optionally filtered by status or a title search.",
  inputSchema: {
    status: z.enum(["FINISHED", "OPEN", "NOT STARTED", "UNKNOWN", "any"]).default("any"),
    query: z.string().optional().describe("Substring of the path title"),
    limit: z.number().int().min(1).max(250).default(25)
  }
}, async ({ status, query, limit }) => {
  const { paths } = await readDb();
  let rows = status === "any" ? paths : paths.filter((path) => path.status === status);
  if (query) {
    const needle = query.toLowerCase();
    rows = rows.filter((path) => String(path.title).toLowerCase().includes(needle));
  }
  const body = rows.slice(0, limit).map((path) => {
    const percent = path.progress === null ? "—" : `${Math.round(path.progress * 100)}%`;
    return `- ${path.title} — ${path.status} · ${percent} · ${path.done}/${path.total}${path.issue ? ` · ${path.issue}` : ""}\n  ${path.url}`;
  });
  return text([`# Paths (${rows.length} matched, showing ${body.length})`, "", ...body].join("\n"));
});

server.registerTool("path_detail", {
  title: "Path detail",
  description: "Every activity inside one path, with completion status. Accepts a path id or part of its title.",
  inputSchema: { path: z.string().describe("Path id (e.g. 4343) or part of the title") }
}, async ({ path }) => {
  const { paths, activities } = await readDb();
  const needle = String(path).toLowerCase();
  const found = paths.find((item) => item.id === String(path))
    || paths.find((item) => String(item.title).toLowerCase().includes(needle));
  if (!found) return text(`No path matching "${path}".`);

  const inPath = activities.filter((activity) => activity.pathId === found.id);
  const outstanding = inPath.filter((activity) => activity.status !== ACTIVITY_COMPLETED);
  return text([
    `# ${found.title}`,
    `${found.status} · ${found.done}/${found.total} done · ${found.url}`,
    "",
    `## Outstanding (${outstanding.length})`,
    ...(outstanding.length ? outstanding.map(activityLine) : ["_Nothing left._"]),
    "",
    `## Completed (${inPath.length - outstanding.length})`,
    ...inPath.filter((a) => a.status === ACTIVITY_COMPLETED).map((a) => `- ${a.name}`)
  ].join("\n"));
});

server.registerTool("import_scan", {
  title: "Import a browser-captured scan",
  description: "Rebuild the database from a scan JSON captured in the browser (see docs/chrome-scan.md). Fast, no browser automation. Merges forward: nothing previously recorded is lost.",
  inputSchema: { file: z.string().describe("Path to the scan JSON, e.g. ~/Downloads/skills-scan.json") }
}, async ({ file: scanFile }) => {
  const target = resolve(scanFile.replace(/^~/, process.env.HOME || "~"));
  const scanned = JSON.parse(await readFile(target, "utf8"));
  const results = Array.isArray(scanned) ? scanned : scanned.results;
  if (!Array.isArray(results)) throw new Error(`${target} does not contain a scan array`);

  const failed = (Array.isArray(scanned?.failed) ? scanned.failed : []).map(([id, reason]) => ({
    id: String(id),
    title: `Path ${id}`,
    url: `https://partner.skills.google/paths/${id}`,
    activities: [],
    progress: null,
    unreadable: true,
    evidence: typeof reason === "number" ? `HTTP ${reason} for /paths/${id}` : String(reason)
  }));

  const { paths, activities } = await updatePathsDb(
    file("paths.md"), file("activities.md"), [...results, ...failed],
    new Date().toISOString(), scanned?.linkStatus || null
  );
  const work = await updateNextUp(file("next-up.md"), paths, activities);
  return text(
    `Imported ${results.length} paths (${failed.length} unreadable). `
    + `Database now holds ${paths.length} paths and ${activities.length} activities; `
    + `${work.unique} distinct activities outstanding.`
  );
});

server.registerTool("refresh_from_site", {
  title: "Rescan Google Skills",
  description: "Re-read the live catalog with Playwright and rebuild the database. SLOW — a full run takes about 3 minutes and opens a browser window. Use `limit` to scan only the first N paths. Requires a signed-in profile from `npm run auth`.",
  inputSchema: {
    limit: z.number().int().min(0).max(500).default(0).describe("Scan only the first N paths (0 = all 207)"),
    headless: z.boolean().default(false).describe("Run without a visible window. Google often rejects headless sessions.")
  }
}, async ({ limit, headless }) => {
  // Imported lazily: pulling in Playwright at startup would make every
  // read-only tool pay for a browser dependency it never uses.
  const { runPathsScrape, runPathsScan } = await import("./paths-scraper.js");
  const options = {
    profile: resolve(ROOT, ".browser-profile-skills"),
    browserProfile: "Profile 1",
    headless,
    authTimeout: 300000,
    settleTime: 2500,
    maxPages: 50,
    limit,
    offset: 0,
    pathId: null,
    replicateCookies: false
  };

  const discovered = await runPathsScrape(options);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file("paths.json"), `${JSON.stringify(discovered, null, 2)}\n`);
  const results = await runPathsScan(file("paths.json"), options);
  const { paths, activities } = await updatePathsDb(file("paths.md"), file("activities.md"), results);
  const work = await updateNextUp(file("next-up.md"), paths, activities);
  return text(
    `Rescanned ${results.length} paths. Database holds ${paths.length} paths, ${activities.length} activities; `
    + `${work.unique} distinct activities outstanding, ${work.blocked.length} blocked.`
  );
});

const transport = new StdioServerTransport();
await server.connect(transport);
