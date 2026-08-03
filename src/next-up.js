import { readFile } from "node:fs/promises";
import { ACTIVITY_COMPLETED, ACTIVITY_IN_PROGRESS, ACTIVITY_MISSING } from "./path-status.js";

export function parseDurationMinutes(text) {
  const value = String(text || "");
  const hours = value.match(/(\d+)\s*hour/i);
  const minutes = value.match(/(\d+)\s*minute/i);
  if (!hours && !minutes) return 0;
  return (hours ? Number.parseInt(hours[1], 10) * 60 : 0) + (minutes ? Number.parseInt(minutes[1], 10) : 0);
}

export function formatDuration(totalMinutes) {
  if (!totalMinutes) return "—";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = totalMinutes / 60;
  return `${Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10}h`;
}

// Percent lives in the issue text ("Started but stalled at 43%") because that is
// what the Markdown row carries; the database is the file, not a side JSON.
function stalledPercent(activity) {
  const match = String(activity.issue || "").match(/(\d+)%/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function activityName(activity) {
  return String(activity.name || "").trim();
}

// The same course or lab appears in many paths, so the useful unit of work is
// the distinct activity, plus which paths it is blocking.
export function buildWorklist(paths, activities) {
  const outstanding = activities.filter(
    (a) => a.status !== ACTIVITY_COMPLETED && a.status !== ACTIVITY_MISSING
  );
  // Content the account cannot open is not work you can plan around.
  const isBlocked = (a) => /access denied/i.test(String(a.issue || ""));

  const remainingByPath = new Map();
  for (const activity of outstanding) {
    remainingByPath.set(activity.pathId, (remainingByPath.get(activity.pathId) || 0) + 1);
  }
  const pathTitles = new Map(paths.map((path) => [path.id, path]));

  const groups = new Map();
  for (const activity of outstanding) {
    const key = activityName(activity).toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        name: activityName(activity),
        url: activity.url,
        type: activity.type,
        duration: activity.duration,
        minutes: parseDurationMinutes(activity.duration),
        percent: 0,
        paths: [],
        completes: []
      });
    }
    const group = groups.get(key);
    group.percent = Math.max(group.percent, stalledPercent(activity));
    if (!group.url && activity.url) group.url = activity.url;
    const path = pathTitles.get(activity.pathId);
    group.paths.push(path || { id: activity.pathId, title: activity.pathTitle, url: activity.pathUrl });
    // The last outstanding activity in a path: doing it flips the path to done.
    if (remainingByPath.get(activity.pathId) === 1) {
      group.completes.push(path || { id: activity.pathId, title: activity.pathTitle });
    }
  }

  const all = [...groups.values()];
  const blockedNames = new Set(outstanding.filter(isBlocked).map((a) => activityName(a).toLowerCase()));
  const open = all.filter((g) => !blockedNames.has(g.name.toLowerCase()));
  const blocked = all.filter((g) => blockedNames.has(g.name.toLowerCase()));
  const cost = (group) => (group.minutes || 1) / Math.max(group.completes.length, 1);

  return {
    unique: all.length,
    slots: outstanding.length,
    totalMinutes: all.reduce((sum, group) => sum + group.minutes, 0),
    blocked: blocked.sort((a, b) => b.completes.length - a.completes.length),
    quickWins: open.filter((g) => g.completes.length).sort((a, b) => cost(a) - cost(b)),
    leverage: open.filter((g) => g.paths.length >= 3 && !g.completes.length)
      .sort((a, b) => b.paths.length - a.paths.length || a.minutes - b.minutes),
    stalled: open.filter((g) => g.percent > 0).sort((a, b) => b.percent - a.percent),
    nearMiss: paths
      .filter((p) => (remainingByPath.get(p.id) || 0) > 0 && (remainingByPath.get(p.id) || 0) <= 2)
      .map((p) => ({ ...p, left: remainingByPath.get(p.id) }))
      .sort((a, b) => a.left - b.left || String(a.title).localeCompare(String(b.title)))
  };
}

// Ticks are the user's own "I'm working on this" marks. Google's completion
// data will overwrite the row eventually, but until it does, keep the mark.
export function parseCheckedItems(markdown) {
  const checked = new Set();
  for (const line of String(markdown).split("\n")) {
    const match = line.match(/^- \[x\] .*?\*\*.*?\*\*\s+—\s+\[([^\]]+)\]/i);
    if (match) checked.add(match[1].replaceAll("\\[", "[").replaceAll("\\]", "]").toLowerCase());
  }
  return checked;
}

// A bare /focuses/<id> bounces to the dashboard, but the same lab opens fine
// when the URL carries its path context: /focuses/<id>?parent=catalog&path=<id>.
// Rebuild it that way, preferring a path this activity would *complete* so the
// link lands on the one about to flip to finished.
function openableUrl(group) {
  const direct = group.url || "";
  const host = group.completes.find((path) => path && path.id)
    || group.paths.find((path) => path && path.id);
  const focus = direct.match(/\/focuses\/(\d+)/);
  if (focus && host) {
    return {
      url: `https://partner.skills.google/focuses/${focus[1]}?parent=catalog&path=${host.id}`,
      viaPath: false
    };
  }
  if (direct) return { url: direct, viaPath: false };
  return host && host.url ? { url: host.url, viaPath: true } : { url: "", viaPath: false };
}

function item(group, checked, note) {
  const label = group.name.replaceAll("[", "\\[").replaceAll("]", "\\]");
  const { url, viaPath } = openableUrl(group);
  const link = url ? `[${label}](${url})` : label;
  const box = checked.has(group.name.toLowerCase()) ? "x" : " ";
  const parts = [note, viaPath ? "_open from the path_" : ""].filter(Boolean);
  return `- [${box}] **${formatDuration(group.minutes)}** — ${link}${parts.length ? ` — ${parts.join(" — ")}` : ""}`;
}

export function renderNextUp(paths, activities, checkedAt = new Date().toISOString(), checked = new Set()) {
  const work = buildWorklist(paths, activities);
  const finished = paths.filter((p) => p.status === "FINISHED").length;
  const quickWinMinutes = work.quickWins.slice(0, 10).reduce((sum, g) => sum + g.minutes, 0);
  const quickWinPaths = new Set(work.quickWins.slice(0, 10).flatMap((g) => g.completes.map((p) => p.id))).size;

  const lines = [
    "# Next up",
    "",
    `Generated ${checkedAt} from [paths.md](paths.md) and [activities.md](activities.md). Regenerated on every scan.`,
    "",
    `**${finished}/${paths.length} paths finished.** ${work.slots} outstanding slots are only **${work.unique} distinct `
      + `activities** (~${Math.round(work.totalMinutes / 60)}h) — the rest are the same course sitting in several paths.`,
    "",
    "## Best value: finishes a path outright",
    "",
    `The top ten below are ~${formatDuration(quickWinMinutes)} of work and would complete **${quickWinPaths} paths**.`,
    ""
  ];

  for (const group of work.quickWins.slice(0, 25)) {
    const completes = group.completes.length;
    const note = `finishes **${completes} path${completes === 1 ? "" : "s"}**`
      + (group.paths.length > completes ? `, appears in ${group.paths.length}` : "")
      + (group.percent ? `, already ${group.percent}% done` : "");
    lines.push(item(group, checked, note));
  }

  lines.push("", "## Highest leverage: shared across many paths", "",
    "These do not finish a path on their own, but each one advances several.", "");
  for (const group of work.leverage.slice(0, 15)) {
    lines.push(item(group, checked, `in **${group.paths.length} paths**${group.percent ? `, ${group.percent}% done` : ""}`));
  }

  lines.push("", "## Already started — don't waste it", "");
  if (!work.stalled.length) lines.push("_Nothing part-finished._");
  for (const group of work.stalled) {
    lines.push(item(group, checked, `**${group.percent}% complete**, in ${group.paths.length} path${group.paths.length === 1 ? "" : "s"}`));
  }

  if (work.blocked.length) {
    lines.push("", `## Blocked — access denied (${work.blocked.length})`, "",
      "Verified 403: the content exists but this account cannot open it. These are an access request, not study time.", "");
    for (const group of work.blocked) {
      const completes = group.completes.length;
      lines.push(item(group, checked,
        `**${formatDuration(group.minutes)}**${completes ? `, would finish ${completes} path${completes === 1 ? "" : "s"}` : ""}`));
    }
  }

  lines.push("", `## Paths within 2 activities of done (${work.nearMiss.length})`, "");
  for (const path of work.nearMiss.slice(0, 40)) {
    const label = String(path.title).replaceAll("[", "\\[").replaceAll("]", "\\]");
    lines.push(`- **${path.left} left** — [${label}](${path.url})`);
  }
  if (work.nearMiss.length > 40) lines.push(`- _…and ${work.nearMiss.length - 40} more, see [paths.md](paths.md)_`);

  lines.push("");
  return lines.join("\n");
}

export async function updateNextUp(file, paths, activities, checkedAt = new Date().toISOString()) {
  let checked = new Set();
  try {
    checked = parseCheckedItems(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, renderNextUp(paths, activities, checkedAt, checked));
  return buildWorklist(paths, activities);
}
