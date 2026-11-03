import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateMarkdownDb } from "../src/markdown-db.js";
import { updatePathsDb } from "../src/paths-db.js";
import { UNCONFIRMED_GRACE_DAYS, holdCompletion } from "../src/path-status.js";

const url = "https://partner.skills.google/course_templates/626";
const done = { course: "BQML", url, completed: true, evidence: "Completion badge page: \"You've completed\"" };
const forbidden = { course: "BQML", url, completed: false, evidence: "Badge page: Access forbidden (HTTP 403)" };

test("holdCompletion keeps the first date and gives way after the grace period", () => {
  const first = holdCompletion("", "403", "2026-11-03T10:00:00.000Z");
  assert.match(first, /^Unconfirmed since 2026-11-03/);
  assert.match(holdCompletion(first, "403", "2026-11-06T10:00:00.000Z"), /^Unconfirmed since 2026-11-03/);
  const late = new Date(Date.parse("2026-11-03") + UNCONFIRMED_GRACE_DAYS * 86_400_000).toISOString();
  assert.equal(holdCompletion(first, "403", late), null);
});

test("completions: one 403 does not undo a completed course; a lasting one does", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "hold-")), "completions.md");
  await updateMarkdownDb(file, [done], "2026-10-23T10:00:00.000Z");
  await updateMarkdownDb(file, [forbidden], "2026-11-03T10:00:00.000Z");
  let out = await readFile(file, "utf8");
  assert.match(out, /✅ COMPLETED \| Unconfirmed since 2026-11-03: .*Access forbidden/);

  await updateMarkdownDb(file, [forbidden], "2026-11-05T10:00:00.000Z");
  out = await readFile(file, "utf8");
  assert.match(out, /✅ COMPLETED \| Unconfirmed since 2026-11-03/);
  assert.equal((out.match(/Unconfirmed since/g) || []).length, 1);

  await updateMarkdownDb(file, [forbidden], "2026-11-12T10:00:00.000Z");
  out = await readFile(file, "utf8");
  assert.match(out, /❌ NOT COMPLETED \| Badge page: Access forbidden/);
});

test("completions: a completed reading clears the flag", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "hold-")), "completions.md");
  await updateMarkdownDb(file, [done], "2026-10-23T10:00:00.000Z");
  await updateMarkdownDb(file, [forbidden], "2026-11-03T10:00:00.000Z");
  await updateMarkdownDb(file, [done], "2026-11-04T10:00:00.000Z");
  const out = await readFile(file, "utf8");
  assert.doesNotMatch(out, /Unconfirmed/);
  assert.match(out, /✅ COMPLETED \| Completion badge page/);
});

test("completions: a course never completed still goes to not completed at once", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "hold-")), "completions.md");
  await updateMarkdownDb(file, [{ ...forbidden, completed: null, evidence: "unreadable" }], "2026-10-23T10:00:00.000Z");
  await updateMarkdownDb(file, [forbidden], "2026-11-03T10:00:00.000Z");
  assert.match(await readFile(file, "utf8"), /❌ NOT COMPLETED/);
});

const scan = (completedFlags) => [{
  id: "4022",
  title: "Apigee",
  progress: 0,
  cards: completedFlags.map((c, i) => [`Course ${i}`, "course", "", c, null, "1 hour", `/paths/4022/course_templates/${700 + i}`])
}];

test("paths: a held activity stays completed and still finishes its path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hold-"));
  const paths = join(dir, "paths.md");
  const acts = join(dir, "activities.md");
  await updatePathsDb(paths, acts, scan([1, 1]), "2026-10-23T10:00:00.000Z");
  const { paths: p, activities: a } = await updatePathsDb(paths, acts, scan([1, 0]), "2026-11-03T10:00:00.000Z");
  assert.equal(p[0].status, "FINISHED");
  assert.equal(p[0].done, 2);
  const held = a.find((x) => x.name === "Course 1");
  assert.equal(held.status, "COMPLETED");
  assert.match(held.issue, /^Unconfirmed since 2026-11-03/);
  assert.match(await readFile(paths, "utf8"), /✅ FINISHED \| 100% \| 2\/2/);

  const later = await updatePathsDb(paths, acts, scan([1, 0]), "2026-11-12T10:00:00.000Z");
  assert.equal(later.activities.find((x) => x.name === "Course 1").status, "NOT STARTED");
  assert.equal(later.paths[0].status, "OPEN");
});
