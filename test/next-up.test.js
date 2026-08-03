import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_COMPLETED, ACTIVITY_IN_PROGRESS, ACTIVITY_MISSING, ACTIVITY_NOT_STARTED } from "../src/path-status.js";
import { buildWorklist, formatDuration, parseCheckedItems, parseDurationMinutes, renderNextUp } from "../src/next-up.js";

const paths = [
  { id: "1", title: "Almost Done", url: "https://partner.skills.google/paths/1", status: "OPEN" },
  { id: "2", title: "Also Almost", url: "https://partner.skills.google/paths/2", status: "OPEN" },
  { id: "3", title: "Long Way", url: "https://partner.skills.google/paths/3", status: "OPEN" }
];

const activity = (pathId, name, status, extra = {}) => ({
  pathId, name, url: `https://partner.skills.google/focuses/${name.length}`,
  type: "lab", duration: "1 hour", status, issue: "", pathTitle: `Path ${pathId}`,
  pathUrl: `https://partner.skills.google/paths/${pathId}`, ...extra
});

test("parses and formats Google's duration strings", () => {
  assert.equal(parseDurationMinutes("1 hour 30 minutes"), 90);
  assert.equal(parseDurationMinutes("45 minutes"), 45);
  assert.equal(parseDurationMinutes("8 hours"), 480);
  assert.equal(parseDurationMinutes(""), 0);
  assert.equal(formatDuration(90), "1.5h");
  assert.equal(formatDuration(45), "45m");
  assert.equal(formatDuration(0), "—");
});

test("an activity blocking the last slot of a path is a quick win", () => {
  const activities = [
    activity("1", "Shared Lab", ACTIVITY_NOT_STARTED),
    activity("2", "Shared Lab", ACTIVITY_NOT_STARTED),
    activity("3", "Shared Lab", ACTIVITY_NOT_STARTED),
    activity("3", "Other Work", ACTIVITY_NOT_STARTED)
  ];
  const work = buildWorklist(paths, activities);
  assert.equal(work.slots, 4);
  assert.equal(work.unique, 2);

  const shared = work.quickWins.find((g) => g.name === "Shared Lab");
  // Completes paths 1 and 2 (their only remaining item), advances path 3.
  assert.equal(shared.completes.length, 2);
  assert.equal(shared.paths.length, 3);
});

test("completed and missing activities are not proposed as work", () => {
  const activities = [
    activity("1", "Done Already", ACTIVITY_COMPLETED),
    activity("1", "Retired Lab", ACTIVITY_MISSING),
    activity("1", "Real Work", ACTIVITY_NOT_STARTED)
  ];
  const work = buildWorklist(paths, activities);
  assert.equal(work.unique, 1);
  assert.equal(work.quickWins[0].name, "Real Work");
});

test("stalled work is ranked by how close it is to done", () => {
  const activities = [
    activity("3", "Nearly There", ACTIVITY_IN_PROGRESS, { issue: "Started but stalled at 94%" }),
    activity("3", "Just Begun", ACTIVITY_IN_PROGRESS, { issue: "Started but stalled at 20%" }),
    activity("3", "Untouched", ACTIVITY_NOT_STARTED)
  ];
  const work = buildWorklist(paths, activities);
  assert.deepEqual(work.stalled.map((g) => g.name), ["Nearly There", "Just Begun"]);
  assert.equal(work.stalled[0].percent, 94);
});

test("paths within two activities of done are listed shortest-first", () => {
  const activities = [
    activity("1", "One Left", ACTIVITY_NOT_STARTED),
    activity("2", "Two Left A", ACTIVITY_NOT_STARTED),
    activity("2", "Two Left B", ACTIVITY_NOT_STARTED),
    ...Array.from({ length: 5 }, (_, i) => activity("3", `Far ${i}`, ACTIVITY_NOT_STARTED))
  ];
  const work = buildWorklist(paths, activities);
  assert.deepEqual(work.nearMiss.map((p) => p.id), ["1", "2"]);
  assert.equal(work.nearMiss[0].left, 1);
});

test("ticked checkboxes survive regeneration", () => {
  const activities = [activity("1", "Shared Lab", ACTIVITY_NOT_STARTED)];
  const first = renderNextUp(paths, activities, "2026-08-02T00:00:00.000Z");
  assert.match(first, /- \[ \] .*Shared Lab/);

  const ticked = first.replace("- [ ] **1h** — [Shared Lab]", "- [x] **1h** — [Shared Lab]");
  const checked = parseCheckedItems(ticked);
  assert.ok(checked.has("shared lab"));

  const second = renderNextUp(paths, activities, "2026-08-02T00:00:00.000Z", checked);
  assert.match(second, /- \[x\] .*Shared Lab/);
});

test("lab links carry path context, because a bare /focuses/ URL bounces to the dashboard", () => {
  const activities = [
    { pathId: "1", name: "Lab In A Path", url: "https://partner.skills.google/focuses/104653",
      type: "lab", duration: "1 hour 30 minutes", status: ACTIVITY_NOT_STARTED, issue: "",
      pathTitle: "Almost Done", pathUrl: "https://partner.skills.google/paths/1" },
    { pathId: "2", name: "Normal Course", url: "https://partner.skills.google/paths/2/course_templates/60",
      type: "course", duration: "1 hour", status: ACTIVITY_NOT_STARTED, issue: "",
      pathTitle: "Also Almost", pathUrl: "https://partner.skills.google/paths/2" }
  ];
  const rendered = renderNextUp(paths, activities, "2026-08-02T00:00:00.000Z");

  // The lab keeps its own URL but gains ?parent=catalog&path=<hostPathId>.
  assert.match(rendered, /\[Lab In A Path\]\(https:\/\/partner\.skills\.google\/focuses\/104653\?parent=catalog&path=1\)/);

  // ...while a course_templates URL is left alone, because it opens fine.
  assert.match(rendered, /\[Normal Course\]\(https:\/\/partner\.skills\.google\/paths\/2\/course_templates\/60\)/);
});
