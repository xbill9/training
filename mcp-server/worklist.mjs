#!/usr/bin/env node
// The ranked worklist, as JSON — and optionally as a rewritten next-up.md.
//
// The MCP server does not rank work itself. Ranking lives in src/next-up.js and
// this script is the only way the server reaches it, so "what should I do next"
// through MCP and `node src/cli.js paths` can never disagree.
//
//   node mcp-server/worklist.mjs             # JSON to stdout, writes nothing
//   node mcp-server/worklist.mjs --write     # also regenerate next-up.md
//   node mcp-server/worklist.mjs --limit 5   # entries per section (default 10)
//
// Exit codes follow the CLI: 0 nothing outstanding, 2 something outstanding,
// 1 no database to read.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalActivityUrl, parseActivitiesMarkdown, parsePathsMarkdown } from "../src/paths-db.js";
import { buildWorklist, formatDuration, updateNextUp } from "../src/next-up.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number.parseInt(args[index + 1], 10) || fallback;
};

const root = resolve(process.env.TRAINING_DIR || process.cwd());
const file = (name) => resolve(root, name);
const read = (name) => readFile(file(name), "utf8").catch(() => "");

const paths = parsePathsMarkdown(await read("paths.md"));
const activities = parseActivitiesMarkdown(await read("activities.md"));
if (!paths.length) {
  console.error(
    `No training database in ${root}. Run "node src/cli.js paths" or `
    + `"node src/cli.js paths-import <scan.json>" first, or set TRAINING_DIR.`
  );
  process.exit(1);
}

const limit = value("--limit", 10);
const work = flag("--write")
  ? await updateNextUp(file("next-up.md"), paths, activities)
  : buildWorklist(paths, activities);

// One activity sits in several paths; the group is the unit of work, so report
// which paths it unblocks rather than repeating the activity per path.
const entry = (group) => ({
  name: group.name,
  url: canonicalActivityUrl(group.url, (group.completes[0] || group.paths[0] || {}).id),
  type: group.type,
  duration: group.duration || "",
  minutes: group.minutes,
  time: formatDuration(group.minutes),
  percent_done: group.percent || 0,
  in_paths: group.paths.length,
  completes: group.completes.map((path) => path.title)
});

const section = (name) => ({
  total: work[name].length,
  items: work[name].slice(0, limit).map(entry)
});

console.log(JSON.stringify({
  root,
  wrote_next_up: flag("--write") ? file("next-up.md") : null,
  outstanding_activities: work.unique,
  outstanding_slots: work.slots,
  estimated_hours: Math.round(work.totalMinutes / 60),
  quick_wins: section("quickWins"),
  leverage: section("leverage"),
  stalled: section("stalled"),
  blocked: section("blocked"),
  near_miss: {
    total: work.nearMiss.length,
    items: work.nearMiss.slice(0, limit).map((path) => ({
      title: path.title,
      url: path.url,
      left: path.left,
      progress: `${path.done}/${path.total}`
    }))
  }
}, null, 2));

process.exit(work.unique > 0 ? 2 : 0);
