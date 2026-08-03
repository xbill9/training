import { readFile, writeFile } from "node:fs/promises";
import {
  ACTIVITY_COMPLETED,
  ACTIVITY_IN_PROGRESS,
  ACTIVITY_MISSING,
  ACTIVITY_NOT_STARTED,
  ACTIVITY_UNKNOWN,
  PATH_FINISHED,
  PATH_NOT_STARTED,
  PATH_OPEN,
  PATH_UNKNOWN,
  activityStatusLabel,
  classifyActivity,
  classifyPath,
  formatPercent,
  parseActivityStatus,
  parsePathStatus,
  pathProgress,
  pathStatusLabel
} from "./path-status.js";

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function link(label, url) {
  const text = escapeCell(label || url).replaceAll("[", "\\[").replaceAll("]", "\\]");
  return url ? `[${text}](${url})` : text;
}

// Split a table row on unescaped pipes so course titles containing "|" survive.
function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = [];
  let current = "";
  for (let i = 1; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) cells.push(current.trim());
  return cells;
}

function unescapeLabel(text) {
  return String(text).replaceAll("\\[", "[").replaceAll("\\]", "]");
}

function parseLink(cell) {
  const match = String(cell).match(/^\[(.*)\]\((\S+)\)$/);
  // An activity with no URL renders as a bare label, but it is escaped just the
  // same. Unescaping only the linked form let backslashes accumulate on every
  // run — "\[DEPRECATED\]" became "\\[DEPRECATED\\]" — which changed the row's
  // identity each time and grew the table without bound.
  if (!match) return { label: unescapeLabel(cell), url: "" };
  return { label: unescapeLabel(match[1]), url: match[2] };
}

export function pathIdFromUrl(url) {
  const match = String(url || "").match(/\/paths\/(\d+)/);
  return match ? match[1] : "";
}

// Activity URLs as they appear on a path page are path-scoped, and Google
// refuses those to any programmatic request:
//
//   /paths/70/course_templates/822          -> 403 always
//   /course_templates/822                   -> the real answer
//   /focuses/48936                          -> redirects to the dashboard
//   /focuses/48936?parent=catalog&path=98   -> the real answer (~30s, it
//                                              provisions a lab environment)
//
// Rewrite to the form that answers before fetching or linking anything.
export function canonicalActivityUrl(url, pathId) {
  const value = String(url || "");
  if (!value) return "";
  const origin = "https://partner.skills.google";
  const template = value.match(/\/course_templates\/(\d+)/);
  if (template) return `${origin}/course_templates/${template[1]}`;
  const focus = value.match(/\/focuses\/(\d+)/);
  if (focus) {
    return pathId
      ? `${origin}/focuses/${focus[1]}?parent=catalog&path=${pathId}`
      : `${origin}/focuses/${focus[1]}`;
  }
  return value.startsWith("http") ? value : `${origin}${value}`;
}

export function activityKey(record) {
  return `${record.pathId || pathIdFromUrl(record.pathUrl)}::${String(record.name || "").trim().toLowerCase()}`;
}

// ---------------------------------------------------------------- paths.md

export function renderPathsMarkdown(paths, checkedAt = new Date().toISOString()) {
  const counts = {
    [PATH_FINISHED]: 0,
    [PATH_OPEN]: 0,
    [PATH_NOT_STARTED]: 0,
    [PATH_UNKNOWN]: 0
  };
  let activityTotal = 0;
  let activityDone = 0;
  let withIssues = 0;
  const rows = paths.map((path) => {
    counts[path.status] = (counts[path.status] || 0) + 1;
    activityTotal += path.total || 0;
    activityDone += path.done || 0;
    if (path.issue) withIssues += 1;
    return [
      link(path.title, path.url),
      pathStatusLabel(path.status),
      path.progress === null || path.progress === undefined ? "—" : formatPercent(path.progress),
      `${path.done ?? 0}/${path.total ?? 0}`,
      escapeCell(path.issue),
      path.checkedAt || checkedAt
    ].join(" | ");
  });
  return [
    "# Learning paths tracker",
    "",
    `Last updated: ${checkedAt}`,
    "",
    `**${paths.length} paths** — ✅ ${counts[PATH_FINISHED]} finished · 🔄 ${counts[PATH_OPEN]} open · `
      + `⬜ ${counts[PATH_NOT_STARTED]} not started · ❔ ${counts[PATH_UNKNOWN]} unknown · ⚠️ ${withIssues} with issues`,
    "",
    `**${activityTotal} activities** — ${activityDone} completed, ${activityTotal - activityDone} outstanding `
      + "(see [activities.md](activities.md))",
    "",
    "| Path | Status | Progress | Done | Issue | Last checked |",
    "|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    ""
  ].join("\n");
}

export function parsePathsMarkdown(markdown) {
  const records = [];
  for (const line of String(markdown).split("\n")) {
    const cells = splitRow(line);
    if (!cells || cells.length < 6) continue;
    const { label, url } = parseLink(cells[0]);
    const id = pathIdFromUrl(url);
    if (!id) continue;
    const [done, total] = String(cells[3]).split("/").map((value) => Number.parseInt(value, 10));
    records.push({
      id,
      title: label,
      url,
      status: parsePathStatus(cells[1]),
      progress: cells[2] === "—" ? null : Number.parseInt(cells[2], 10) / 100,
      done: Number.isFinite(done) ? done : 0,
      total: Number.isFinite(total) ? total : 0,
      issue: cells[4] === "" ? "" : cells[4],
      checkedAt: cells[5]
    });
  }
  return records;
}

// ----------------------------------------------------------- activities.md

export function renderActivitiesMarkdown(activities, checkedAt = new Date().toISOString()) {
  const counts = {
    [ACTIVITY_COMPLETED]: 0,
    [ACTIVITY_IN_PROGRESS]: 0,
    [ACTIVITY_NOT_STARTED]: 0,
    [ACTIVITY_MISSING]: 0,
    [ACTIVITY_UNKNOWN]: 0
  };
  const rows = activities.map((activity) => {
    counts[activity.status] = (counts[activity.status] || 0) + 1;
    return [
      link(activity.name, activity.url),
      escapeCell(activity.type),
      link(activity.pathTitle, activity.pathUrl),
      activityStatusLabel(activity.status),
      escapeCell(activity.issue),
      escapeCell(activity.duration),
      activity.checkedAt || checkedAt
    ].join(" | ");
  });
  const issues = counts[ACTIVITY_IN_PROGRESS] + counts[ACTIVITY_MISSING] + counts[ACTIVITY_UNKNOWN];
  return [
    "# Path activities tracker",
    "",
    `Last updated: ${checkedAt}`,
    "",
    `**${activities.length} activities** — ✅ ${counts[ACTIVITY_COMPLETED]} completed · `
      + `❌ ${counts[ACTIVITY_NOT_STARTED]} not started · 🔄 ${counts[ACTIVITY_IN_PROGRESS]} started but stalled · `
      + `⚠️ ${counts[ACTIVITY_MISSING]} missing/retired · ❔ ${counts[ACTIVITY_UNKNOWN]} unreadable`,
    "",
    `**${issues} need attention** (stalled, missing, or unreadable).`,
    "",
    "| Activity | Type | Path | Status | Issue | Duration | Last checked |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    ""
  ].join("\n");
}

export function parseActivitiesMarkdown(markdown) {
  const records = [];
  for (const line of String(markdown).split("\n")) {
    const cells = splitRow(line);
    if (!cells || cells.length < 7) continue;
    const activity = parseLink(cells[0]);
    const path = parseLink(cells[2]);
    const pathId = pathIdFromUrl(path.url);
    if (!pathId) continue;
    records.push({
      name: activity.label,
      url: activity.url,
      type: cells[1],
      pathId,
      pathTitle: path.label,
      pathUrl: path.url,
      status: parseActivityStatus(cells[3]),
      issue: cells[4],
      duration: cells[5],
      checkedAt: cells[6]
    });
  }
  return records;
}

// ---------------------------------------------------------------- updates

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

// Turn a scraped path (with its raw activity cards) into the two row shapes the
// Markdown files store.
export function toRecords(scrapedPath, checkedAt) {
  const { status, issue } = classifyPath(scrapedPath);
  const activities = (scrapedPath.activities || []).map((activity) => {
    const classified = classifyActivity(activity);
    return {
      name: activity.name,
      url: activity.url,
      type: activity.credentialType === "skill_badge" ? "skill badge" : activity.type || "activity",
      pathId: scrapedPath.id,
      pathTitle: scrapedPath.title,
      pathUrl: scrapedPath.url,
      status: classified.status,
      issue: classified.issue,
      duration: activity.duration || "",
      checkedAt
    };
  });
  const path = {
    id: scrapedPath.id,
    title: scrapedPath.title,
    url: scrapedPath.url,
    status,
    progress: pathProgress(scrapedPath),
    done: activities.filter((a) => a.status === ACTIVITY_COMPLETED).length,
    total: activities.length,
    issue,
    checkedAt
  };
  return { path, activities };
}

// Accept the compact rows produced by the in-browser scan (see
// docs/chrome-scan.md) as well as the shape runPathsScan returns, so both
// collection routes feed the same database.
// A map of {activityUrl: status} from a link-verification pass. Statuses that
// mean "this content is gone" mark the activity broken; a 403 does not — it
// means this account cannot open it, which is an entitlement question, and
// Google also serves 403 when it is rate-limiting a burst of requests.
const DEAD_LINK_STATUSES = new Set([404, 410, "404", "410", "500page", "ERR", "gone"]);

export function applyLinkStatuses(scrapedPath, linkStatus) {
  if (!linkStatus || !scrapedPath.activities) return scrapedPath;
  return {
    ...scrapedPath,
    activities: scrapedPath.activities.map((activity) => {
      const status = linkStatus[activity.url];
      if (status === undefined) return activity;
      if (status === 403 || status === "403") return { ...activity, linkRestricted: true };
      if (!DEAD_LINK_STATUSES.has(status)) return activity;
      if (status === "gone") return { ...activity, linkBroken: "Retired — redirects to the dashboard" };
      return { ...activity, linkBroken: status === "500page" ? "Google server error" : `HTTP ${status}` };
    })
  };
}

export function normalizeScrapedPath(raw) {
  if (Array.isArray(raw.activities) || !Array.isArray(raw.cards)) return raw;
  return {
    id: String(raw.id),
    title: raw.title || `Path ${raw.id}`,
    url: raw.url || `https://partner.skills.google/paths/${raw.id}`,
    progress: raw.progress ?? null,
    unreadable: Boolean(raw.unreadable),
    evidence: raw.evidence || "",
    activities: raw.cards.map(([name, type, credentialType, completed, progress, duration, href]) => ({
      name,
      type,
      credentialType,
      completed: completed === 1 || completed === true,
      progress: progress ?? null,
      duration,
      url: href ? new URL(href, "https://partner.skills.google").href : ""
    }))
  };
}

// Merge rules, mirroring completions.md: keep everything ever seen, and never
// let an inconclusive check overwrite a definitive status — a failed page load
// says nothing about whether the work is done.
export function mergePaths(previous, current) {
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const item of current) {
    const existing = byId.get(item.id);
    if (item.status === PATH_UNKNOWN && existing && existing.status !== PATH_UNKNOWN) continue;
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function mergeActivities(previous, current, scannedPathIds = new Set()) {
  const byKey = new Map(previous.map((item) => [activityKey(item), item]));
  const currentKeys = new Set(current.map(activityKey));
  for (const item of current) {
    const key = activityKey(item);
    const existing = byKey.get(key);
    if (item.status === ACTIVITY_UNKNOWN && existing && existing.status !== ACTIVITY_UNKNOWN) continue;
    byKey.set(key, item);
  }
  // An activity that vanished from a path we just read successfully is retired
  // or moved — the cheapest reliable signal for missing content.
  for (const [key, item] of byKey) {
    if (currentKeys.has(key)) continue;
    if (!scannedPathIds.has(item.pathId)) continue;
    if (item.status === ACTIVITY_MISSING) continue;
    byKey.set(key, {
      ...item,
      status: ACTIVITY_MISSING,
      issue: "No longer listed in this path (retired or moved)"
    });
  }
  return [...byKey.values()].sort((a, b) => {
    const byPath = String(a.pathTitle).localeCompare(String(b.pathTitle));
    return byPath !== 0 ? byPath : String(a.name).localeCompare(String(b.name));
  });
}

export async function updatePathsDb(pathsFile, activitiesFile, scrapedPaths, checkedAt = new Date().toISOString(), linkStatus = null) {
  const records = scrapedPaths.map((path) => toRecords(applyLinkStatuses(normalizeScrapedPath(path), linkStatus), checkedAt));
  const scannedPathIds = new Set(
    records.filter((record) => record.path.status !== PATH_UNKNOWN).map((record) => record.path.id)
  );

  const paths = mergePaths(
    parsePathsMarkdown(await readIfPresent(pathsFile)),
    records.map((record) => record.path)
  );
  const activities = mergeActivities(
    parseActivitiesMarkdown(await readIfPresent(activitiesFile)),
    records.flatMap((record) => record.activities),
    scannedPathIds
  );

  await writeFile(pathsFile, renderPathsMarkdown(paths, checkedAt));
  await writeFile(activitiesFile, renderActivitiesMarkdown(activities, checkedAt));
  return { paths, activities };
}
