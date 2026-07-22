import { readFile, writeFile } from "node:fs/promises";

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function statusLabel(completed) {
  if (completed === true) return "✅ COMPLETED";
  if (completed === false) return "❌ NOT COMPLETED";
  return "❔ UNKNOWN";
}

export function renderMarkdown(results, checkedAt = new Date().toISOString()) {
  const rows = results.map((item) => {
    const label = escapeCell(item.course || "Course").replaceAll("[", "\\[").replaceAll("]", "\\]");
    return `| [${label}](${item.url}) | ${statusLabel(item.completed)} | ${escapeCell(item.evidence)} | ${checkedAt} |`;
  });
  return [
    "# Course completion tracker",
    "",
    `Last updated: ${checkedAt}`,
    "",
    "| Course | Completion status | Evidence | Last checked |",
    "|---|---|---|---|",
    ...rows,
    ""
  ].join("\n");
}

function parseExisting(markdown) {
  const records = [];
  const row = /^\| \[(.*)\]\((https:\/\/[^)]+)\) \| (.*?) \| (.*?) \| (.*?) \|$/;
  for (const line of markdown.split("\n")) {
    const match = line.match(row);
    if (!match) continue;
    records.push({
      course: match[1].replaceAll("\\[", "[").replaceAll("\\]", "]"),
      url: match[2],
      completed: match[3].includes("✅") ? true : match[3].includes("❌") ? false : null,
      evidence: match[4].replaceAll("\\|", "|")
    });
  }
  return records;
}

export async function updateMarkdownDb(file, currentResults, checkedAt = new Date().toISOString()) {
  let previous = [];
  try {
    previous = parseExisting(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const byUrl = new Map(previous.map((item) => [item.url, item]));
  for (const item of currentResults) {
    const existing = byUrl.get(item.url);
    // Never downgrade a definitive status to unknown: an inconclusive check
    // (e.g. Google's transient 500 page) says nothing about the course.
    if (item.completed === null && existing && existing.completed !== null) continue;
    byUrl.set(item.url, item);
  }
  const merged = [...byUrl.values()].sort((a, b) => a.course.localeCompare(b.course));
  await writeFile(file, renderMarkdown(merged, checkedAt));
  return merged;
}
