import test from "node:test";
import assert from "node:assert/strict";
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
  classifyActivity,
  classifyPath
} from "../src/path-status.js";
import {
  mergeActivities,
  mergePaths,
  parseActivitiesMarkdown,
  parsePathsMarkdown,
  renderActivitiesMarkdown,
  renderPathsMarkdown,
  toRecords
} from "../src/paths-db.js";

const scrapedPath = {
  id: "12",
  title: "Professional Cloud Architect Certification",
  url: "https://partner.skills.google/paths/12",
  progress: 0.5,
  activities: [
    { name: "A Tour of Google Cloud Hands-on Labs", type: "lab", url: "https://partner.skills.google/focuses/11600", completed: true, progress: 1, duration: "45 minutes" },
    { name: "Build a Certification Study Guide", type: "course", url: "https://partner.skills.google/paths/12/course_templates/78", completed: false, progress: 0.42, duration: "1 hour" }
  ]
};

test("classifies a path as finished only when every activity is complete", () => {
  assert.equal(classifyPath(scrapedPath).status, PATH_OPEN);
  const allDone = { ...scrapedPath, activities: scrapedPath.activities.map((a) => ({ ...a, completed: true })) };
  assert.equal(classifyPath(allDone).status, PATH_FINISHED);
  const untouched = { ...scrapedPath, progress: 0, activities: scrapedPath.activities.map((a) => ({ ...a, completed: false, progress: 0 })) };
  assert.equal(classifyPath(untouched).status, PATH_NOT_STARTED);
  assert.equal(classifyPath({ ...scrapedPath, unreadable: true, evidence: "500" }).status, PATH_UNKNOWN);
});

test("a path at 100% headline progress is not finished while an activity is outstanding", () => {
  const path = { ...scrapedPath, progress: 1 };
  assert.equal(classifyPath(path).status, PATH_OPEN);
});

test("progress reports the site percentage, which counts work inside an activity", () => {
  // 0 of 2 activities done, but 40% of the way through the first one.
  const path = { ...scrapedPath, progress: 0.4, activities: scrapedPath.activities.map((a) => ({ ...a, completed: false })) };
  const { path: record } = toRecords(path, "2026-08-02T00:00:00.000Z");
  assert.equal(record.progress, 0.4);
  assert.equal(record.done, 0);
  assert.equal(record.total, 2);
  // No progress bar on the page: fall back to the completed share.
  const noBar = toRecords({ ...scrapedPath, progress: null }, "2026-08-02T00:00:00.000Z").path;
  assert.equal(noBar.progress, 0.5);
});

test("classifies activity issues", () => {
  assert.equal(classifyActivity({ completed: true }).status, ACTIVITY_COMPLETED);
  assert.equal(classifyActivity({ completed: false, progress: 0 }).status, ACTIVITY_NOT_STARTED);

  const stalled = classifyActivity({ completed: false, progress: 0.42 });
  assert.equal(stalled.status, ACTIVITY_IN_PROGRESS);
  assert.match(stalled.issue, /42%/);

  assert.equal(classifyActivity({ completed: null }).status, ACTIVITY_UNKNOWN);
  assert.equal(classifyActivity({ completed: false, linkBroken: "HTTP 404" }).status, ACTIVITY_MISSING);
  assert.equal(classifyActivity({ completed: false, removed: true }).status, ACTIVITY_MISSING);
});

test("markdown rows survive a render/parse round trip", () => {
  const checkedAt = "2026-08-02T00:00:00.000Z";
  const { path, activities } = toRecords(scrapedPath, checkedAt);

  const parsedPaths = parsePathsMarkdown(renderPathsMarkdown([path], checkedAt));
  assert.equal(parsedPaths.length, 1);
  assert.deepEqual(parsedPaths[0], { ...path, progress: 0.5 });

  const parsedActivities = parseActivitiesMarkdown(renderActivitiesMarkdown(activities, checkedAt));
  assert.equal(parsedActivities.length, 2);
  assert.deepEqual(parsedActivities[0], activities[0]);
});

test("titles containing pipes and brackets round trip", () => {
  const checkedAt = "2026-08-02T00:00:00.000Z";
  const { activities } = toRecords({
    ...scrapedPath,
    activities: [{ name: "Cloud | Storage [Advanced]", type: "lab", url: "https://partner.skills.google/focuses/1", completed: true, progress: 1, duration: "1 hour" }]
  }, checkedAt);
  const parsed = parseActivitiesMarkdown(renderActivitiesMarkdown(activities, checkedAt));
  assert.equal(parsed[0].name, "Cloud | Storage [Advanced]");
});

test("an inconclusive check never overwrites a definitive status", () => {
  const previous = [{ id: "12", title: "PCA", url: "https://partner.skills.google/paths/12", status: PATH_FINISHED, progress: 1, done: 2, total: 2, issue: "", checkedAt: "old" }];
  const merged = mergePaths(previous, [{ ...previous[0], status: PATH_UNKNOWN, checkedAt: "new" }]);
  assert.equal(merged[0].status, PATH_FINISHED);
  assert.equal(merged[0].checkedAt, "old");
});

test("paths and activities seen in earlier runs are retained", () => {
  const previous = [{ id: "99", title: "Older path", url: "https://partner.skills.google/paths/99", status: PATH_OPEN, progress: 0.5, done: 1, total: 2, issue: "", checkedAt: "old" }];
  const merged = mergePaths(previous, [{ id: "12", title: "PCA", url: "https://partner.skills.google/paths/12", status: PATH_FINISHED, progress: 1, done: 2, total: 2, issue: "", checkedAt: "new" }]);
  assert.deepEqual(merged.map((p) => p.id).sort(), ["12", "99"]);
});

test("an activity that vanished from a rescanned path is flagged as missing", () => {
  const checkedAt = "2026-08-02T00:00:00.000Z";
  const { activities } = toRecords(scrapedPath, checkedAt);
  const current = [activities[0]];
  const merged = mergeActivities(activities, current, new Set(["12"]));
  const gone = merged.find((a) => a.name === "Build a Certification Study Guide");
  assert.equal(gone.status, ACTIVITY_MISSING);
  assert.match(gone.issue, /No longer listed/);
});

test("activities in paths that were not scanned this run are left alone", () => {
  const checkedAt = "2026-08-02T00:00:00.000Z";
  const { activities } = toRecords(scrapedPath, checkedAt);
  const merged = mergeActivities(activities, [], new Set());
  assert.equal(merged.find((a) => a.name === "Build a Certification Study Guide").status, ACTIVITY_IN_PROGRESS);
});

test("summary headers count what the tables contain", () => {
  const checkedAt = "2026-08-02T00:00:00.000Z";
  const { path, activities } = toRecords(scrapedPath, checkedAt);
  const pathsMd = renderPathsMarkdown([path], checkedAt);
  assert.match(pathsMd, /🔄 1 open/);
  assert.match(pathsMd, /2 activities\*\* — 1 completed, 1 outstanding/);

  const activitiesMd = renderActivitiesMarkdown(activities, checkedAt);
  assert.match(activitiesMd, /✅ 1 completed/);
  assert.match(activitiesMd, /\*\*1 need attention\*\*/);
});

test("progress never reads lower than the share of activities completed", () => {
  const at = "2026-08-02T00:00:00.000Z";
  // Site headline is stale at 0 while 1 of 2 activities is done.
  const stale = toRecords({
    id: "4023", title: "Federating Identity", url: "https://partner.skills.google/paths/4023", progress: 0,
    activities: [
      { name: "a", type: "course", url: "https://partner.skills.google/focuses/1", completed: true, progress: 1, duration: "" },
      { name: "b", type: "course", url: "https://partner.skills.google/focuses/2", completed: false, progress: 0, duration: "" }
    ]
  }, at).path;
  assert.equal(stale.progress, 0.5);
  assert.equal(stale.done, 1);

  // Headline still wins when it is ahead: part-finished work inside activity 1.
  const partial = toRecords({
    id: "2304", title: "Intelligent Search", url: "https://partner.skills.google/paths/2304", progress: 0.4,
    activities: [
      { name: "a", type: "course", url: "https://partner.skills.google/focuses/1", completed: false, progress: 0.8, duration: "" },
      { name: "b", type: "course", url: "https://partner.skills.google/focuses/2", completed: false, progress: 0, duration: "" }
    ]
  }, at).path;
  assert.equal(partial.progress, 0.4);
});

test("rows survive repeated render/parse cycles unchanged", () => {
  const at = "2026-08-02T00:00:00.000Z";
  // An activity with no URL and brackets in its name: the shape that used to
  // gain a backslash on every run and be re-added as a new row each import.
  const { activities } = toRecords({
    id: "77", title: "Hybrid Solutions", url: "https://partner.skills.google/paths/77", progress: 0,
    activities: [{ name: "[DEPRECATED] Introduction to Migration Center", type: "lab", url: "", completed: false, progress: 0, duration: "1 hour" }]
  }, at);

  let rendered = renderActivitiesMarkdown(activities, at);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const parsed = parseActivitiesMarkdown(rendered);
    assert.equal(parsed.length, 1, `row count changed on cycle ${cycle}`);
    assert.equal(parsed[0].name, "[DEPRECATED] Introduction to Migration Center");
    rendered = renderActivitiesMarkdown(parsed, at);
  }
});

test("re-importing the same scan does not grow the table", () => {
  const at = "2026-08-02T00:00:00.000Z";
  const scraped = {
    id: "77", title: "Hybrid", url: "https://partner.skills.google/paths/77", progress: 0,
    activities: [
      { name: "[DEPRECATED] Old Lab", type: "lab", url: "", completed: false, progress: 0, duration: "1 hour" },
      { name: "Normal Lab", type: "lab", url: "https://partner.skills.google/focuses/9", completed: true, progress: 1, duration: "1 hour" }
    ]
  };
  const { activities } = toRecords(scraped, at);
  let current = activities;
  for (let run = 0; run < 3; run += 1) {
    const previous = parseActivitiesMarkdown(renderActivitiesMarkdown(current, at));
    current = mergeActivities(previous, activities, new Set(["77"]));
    assert.equal(current.length, 2, `merged rows grew on run ${run}`);
    assert.equal(current.filter((a) => a.status === ACTIVITY_MISSING).length, 0);
  }
});

test("activity URLs are canonicalized to the form Google actually answers", async () => {
  const { canonicalActivityUrl } = await import("../src/paths-db.js");
  // Path-scoped course URLs 403; the bare template URL is the real one.
  assert.equal(
    canonicalActivityUrl("https://partner.skills.google/paths/70/course_templates/822", "70"),
    "https://partner.skills.google/course_templates/822"
  );
  // A bare lab URL redirects to the dashboard; it needs its path context.
  assert.equal(
    canonicalActivityUrl("https://partner.skills.google/focuses/48936", "98"),
    "https://partner.skills.google/focuses/48936?parent=catalog&path=98"
  );
  assert.equal(canonicalActivityUrl("", "98"), "");
  // Anything else is left alone beyond being made absolute.
  assert.equal(
    canonicalActivityUrl("/paths/419/surveys/7", "419"),
    "https://partner.skills.google/paths/419/surveys/7"
  );
});
