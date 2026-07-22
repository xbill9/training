import test from "node:test";
import assert from "node:assert/strict";
import { isSkillsUrl, normalizeCourseLinks } from "../src/course-links.js";

test("recognizes current and legacy partner course hosts", () => {
  assert.equal(isSkillsUrl("https://partner.skills.google/course_templates/12"), true);
  assert.equal(isSkillsUrl("https://partner.cloudskillsboost.google/paths/77"), true);
  assert.equal(isSkillsUrl("https://evil.example/?next=partner.skills.google"), false);
});

test("filters, normalizes, and deduplicates course links", () => {
  assert.deepEqual(normalizeCourseLinks([
    { href: "https://partner.skills.google/course_templates/12#module", label: " Course A " },
    { href: "https://partner.skills.google/course_templates/12", label: "duplicate" },
    { href: "https://example.com/course", label: "ignore" }
  ]), [{ href: "https://partner.skills.google/course_templates/12", label: "Course A" }]);
});
