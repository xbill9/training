import test from "node:test";
import assert from "node:assert/strict";
import { detectCompletion } from "../src/status.js";

test("detects completion from progress and text", () => {
  assert.equal(detectCompletion({ bodyText: "", signals: [], progressValues: [100] }).completed, true);
  assert.equal(detectCompletion({ bodyText: "Course 100% complete", signals: [], progressValues: [] }).completed, true);
  assert.equal(detectCompletion({ bodyText: "", signals: ["Completed"], progressValues: [] }).completed, true);
});

test("does not treat not completed as completed", () => {
  assert.equal(detectCompletion({ bodyText: "", signals: ["Not completed"], progressValues: [] }).completed, false);
  assert.equal(detectCompletion({ bodyText: "Course 72% complete", signals: [], progressValues: [] }).completed, false);
});

test("returns unknown when no status is recognizable", () => {
  assert.equal(detectCompletion({ bodyText: "Course overview", signals: [], progressValues: [] }).completed, null);
  assert.equal(detectCompletion({ bodyText: "Course overview ".repeat(30), signals: [], progressValues: [] }).completed, null);
});
