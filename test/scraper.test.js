import test from "node:test";
import assert from "node:assert/strict";
import { isCourseBadgePage } from "../src/scraper.js";

test("recognizes an actual course badge page", () => {
  assert.equal(isCourseBadgePage("https://partner.skills.google/course_templates/649/badge", "649"), true);
  assert.equal(isCourseBadgePage("https://partner.skills.google/course_templates/649/badge/", "649"), true);
});

test("does not mistake a badge redirect for completion", () => {
  assert.equal(isCourseBadgePage("https://partner.skills.google/course_templates/827", "827"), false);
  assert.equal(isCourseBadgePage("https://partner.skills.google/course_templates/649/badge", "827"), false);
  assert.equal(isCourseBadgePage("https://example.com/course_templates/827/badge", "827"), false);
});
