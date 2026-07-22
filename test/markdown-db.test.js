import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderMarkdown, updateMarkdownDb } from "../src/markdown-db.js";

test("renders clickable links and statuses", () => {
  const output = renderMarkdown([{
    course: "Cloud course",
    url: "https://partner.skills.google/course_templates/12",
    completed: true,
    evidence: "100%"
  }], "2026-07-21T12:00:00.000Z");
  assert.match(output, /\[Cloud course\]\(https:\/\/partner\.skills\.google\/course_templates\/12\)/);
  assert.match(output, /✅ COMPLETED/);
});

test("keeps old courses and updates matching URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dri-md-"));
  const file = join(directory, "completions.md");
  await updateMarkdownDb(file, [{ course: "A", url: "https://partner.skills.google/a", completed: false, evidence: "20%" }]);
  await updateMarkdownDb(file, [
    { course: "A", url: "https://partner.skills.google/a", completed: true, evidence: "100%" },
    { course: "B", url: "https://partner.skills.google/b", completed: null, evidence: "none" }
  ]);
  const output = await readFile(file, "utf8");
  assert.match(output, /\[A\].*✅ COMPLETED/);
  assert.match(output, /\[B\].*❔ UNKNOWN/);
  assert.equal((output.match(/https:\/\/partner\.skills\.google\/a/g) || []).length, 1);
});

test("does not downgrade a definitive status to unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dri-md-"));
  const file = join(directory, "completions.md");
  await updateMarkdownDb(file, [{ course: "A", url: "https://partner.skills.google/a", completed: false, evidence: "20%" }]);
  await updateMarkdownDb(file, [{ course: "A", url: "https://partner.skills.google/a", completed: null, evidence: "server error" }]);
  const output = await readFile(file, "utf8");
  assert.match(output, /\[A\].*❌ NOT COMPLETED/);
  assert.doesNotMatch(output, /❔ UNKNOWN/);
});
