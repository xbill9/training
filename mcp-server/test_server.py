"""Unit tests for the pure parts of the MCP server: python3 -m unittest discover mcp-server"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import trackers  # noqa: E402
from links import canonical_activity_url, canonicalize, classify_url, is_partner_url  # noqa: E402
from session import is_stale_lock, parse_lock_target  # noqa: E402

PATHS_MD = """# Learning paths tracker

| Path | Status | Progress | Done | Issue | Last checked |
|---|---|---|---|---|---|
| [\\[DABE\\] \\[Federating Identity\\]](https://partner.skills.google/paths/4023) | 🔄 OPEN | 50% | 1/2 |  | 2026-08-02T23:43:47.607Z |
| [Apigee API Engineer](https://partner.skills.google/paths/30) | ⬜ NOT STARTED | 0% | 0/4 |  | 2026-08-02T23:43:47.607Z |
| [Cloud Digital Leader](https://partner.skills.google/paths/21) | ✅ FINISHED | 100% | 7/7 |  | 2026-08-02T23:43:47.607Z |
| [Locked path](https://partner.skills.google/paths/99) | ❔ UNKNOWN | — | 0/0 | HTTP 403 for /paths/99 | 2026-08-02T23:43:47.607Z |
"""

ACTIVITIES_MD = """# Path activities tracker

| Activity | Type | Path | Status | Issue | Duration | Last checked |
|---|---|---|---|---|---|---|
| [Federating Google Cloud with AD](https://partner.skills.google/focuses/120443) | lab | [\\[DABE\\] \\[Federating Identity\\]](https://partner.skills.google/paths/4023) | ❌ NOT STARTED |  | 2 hours | 2026-08-02T23:43:47.607Z |
| [Deploy \\| Scale](https://partner.skills.google/paths/30/course_templates/9) | course | [Apigee API Engineer](https://partner.skills.google/paths/30) | 🔄 IN PROGRESS | Started but stalled at 40% | 1 hour 30 minutes | 2026-08-02T23:43:47.607Z |
| [Document AI](https://partner.skills.google/course_templates/973) | course | [Cloud Digital Leader](https://partner.skills.google/paths/21) | ❌ NOT STARTED | Access denied (403) — account not entitled | 3 hours 30 minutes | 2026-08-02T23:43:47.607Z |
"""

COMPLETIONS_MD = """# Course completion tracker

| Course | Completion status | Evidence | Last checked |
|---|---|---|---|
| [\\[DEPRECATED\\] Network Security](https://partner.cloudskillsboost.google/course_templates/1412) | ❌ NOT COMPLETED | 0% complete | 2026-07-22T20:29:17.106Z |
| [Add Agent Guardrails](https://partner.skills.google/course_templates/1678) | ✅ COMPLETED | 100% complete | 2026-07-22T20:29:17.106Z |
| [Locked lab](https://partner.cloudskillsboost.google/catalog_lab/2570) | ❔ UNKNOWN | Page failed to load or render | 2026-07-22T20:29:17.106Z |
"""


class PartnerOnlyRule(unittest.TestCase):
    def test_partner_hosts_accepted(self):
        self.assertTrue(is_partner_url("https://partner.skills.google/paths/12"))
        self.assertTrue(is_partner_url("https://partner.cloudskillsboost.google/course_templates/1"))

    def test_public_hosts_rejected_with_an_explanation(self):
        for url in (
            "https://skills.google/course_templates/1090",
            "https://www.cloudskillsboost.google/paths/3",
        ):
            verdict = classify_url(url)
            self.assertEqual(verdict["verdict"], "public")
            self.assertFalse(verdict["accepted"])
            self.assertIn("ID namespace", verdict["reason"])
            self.assertNotIn("canonical_url", verdict, "a public URL must never be rewritten")
            self.assertFalse(is_partner_url(url))

    def test_http_and_foreign_hosts_rejected(self):
        self.assertFalse(is_partner_url("http://partner.skills.google/paths/12"))
        self.assertEqual(classify_url("http://partner.skills.google/paths/12")["verdict"], "insecure")
        self.assertEqual(classify_url("https://example.com/paths/12")["verdict"], "other")
        self.assertFalse(classify_url("not a url")["accepted"])

    def test_legacy_partner_host_is_canonicalized_and_ids_extracted(self):
        verdict = classify_url("https://partner.cloudskillsboost.google/course_templates/1722?a=1#top")
        self.assertEqual(verdict["canonical_url"], "https://partner.skills.google/course_templates/1722?a=1")
        self.assertEqual(verdict["course_id"], "1722")
        self.assertIsNone(verdict["path_id"])
        self.assertEqual(
            canonicalize("https://partner.cloudskillsboost.google/paths/12#x"),
            "https://partner.skills.google/paths/12",
        )

    def test_path_scoped_activity_urls_get_a_fetchable_form(self):
        verdict = classify_url("https://partner.skills.google/paths/70/course_templates/822")
        self.assertEqual(verdict["fetch_url"], "https://partner.skills.google/course_templates/822")
        self.assertIn("403", verdict["reason"])

    def test_canonical_activity_url_mirrors_paths_db(self):
        self.assertEqual(
            canonical_activity_url("https://partner.skills.google/paths/70/course_templates/822", "70"),
            "https://partner.skills.google/course_templates/822",
        )
        # A bare /focuses/<id> redirects to the dashboard; the query string is what answers.
        self.assertEqual(
            canonical_activity_url("https://partner.skills.google/focuses/48936", "98"),
            "https://partner.skills.google/focuses/48936?parent=catalog&path=98",
        )
        self.assertEqual(
            canonical_activity_url("/paths/70/course_templates/822", None),
            "https://partner.skills.google/course_templates/822",
        )
        self.assertEqual(canonical_activity_url("", "70"), "")


class RowParsing(unittest.TestCase):
    def test_paths(self):
        records = trackers.parse_paths_markdown(PATHS_MD)
        self.assertEqual([r["id"] for r in records], ["4023", "30", "21", "99"])
        self.assertEqual([r["status"] for r in records], ["OPEN", "NOT STARTED", "FINISHED", "UNKNOWN"])
        self.assertEqual(records[0]["title"], "[DABE] [Federating Identity]")
        self.assertEqual(records[0]["done"], 1)
        self.assertEqual(records[0]["total"], 2)
        self.assertAlmostEqual(records[0]["progress"], 0.5)
        self.assertIsNone(records[3]["progress"])
        self.assertEqual(records[3]["issue"], "HTTP 403 for /paths/99")

    def test_activities_survive_escaped_pipes(self):
        records = trackers.parse_activities_markdown(ACTIVITIES_MD)
        self.assertEqual(len(records), 3)
        stalled = records[1]
        self.assertEqual(stalled["name"], "Deploy | Scale")
        self.assertEqual(stalled["status"], "IN PROGRESS")
        self.assertEqual(stalled["path_id"], "30")
        self.assertEqual(stalled["duration"], "1 hour 30 minutes")

    def test_blocked_is_the_403_issue_text_only(self):
        records = trackers.parse_activities_markdown(ACTIVITIES_MD)
        self.assertEqual([trackers.is_blocked(r) for r in records], [False, False, True])

    def test_courses_and_escaped_brackets(self):
        records = trackers.parse_completions_markdown(COMPLETIONS_MD)
        self.assertEqual(records[0]["course"], "[DEPRECATED] Network Security")
        self.assertEqual([r["status"] for r in records], ["NOT COMPLETED", "COMPLETED", "UNKNOWN"])

    def test_unlinked_labels_are_unescaped_too(self):
        # Escaping has to round-trip for unlinked cells as well, or a name like
        # "[DEPRECATED] Foo" gains a backslash on every run.
        self.assertEqual(trackers.parse_link("\\[DEPRECATED\\] Foo"), ("[DEPRECATED] Foo", ""))

    def test_header_and_separator_rows_are_not_records(self):
        self.assertEqual(trackers.parse_paths_markdown("| Path | Status |\n|---|---|\n"), [])
        self.assertIsNone(trackers.split_row("not a row"))


class StatusFilters(unittest.TestCase):
    def test_aliases(self):
        self.assertEqual(trackers.resolve_status(None, trackers.PATH_ALIASES), [])
        self.assertEqual(trackers.resolve_status("all", trackers.PATH_ALIASES), [])
        self.assertEqual(trackers.resolve_status("Finished", trackers.PATH_ALIASES), ["FINISHED"])
        self.assertEqual(
            trackers.resolve_status("outstanding", trackers.PATH_ALIASES), ["OPEN", "NOT STARTED"]
        )
        self.assertEqual(trackers.resolve_status("MISSING", trackers.ACTIVITY_ALIASES), ["MISSING"])

    def test_unknown_filter_is_an_error_not_an_empty_list(self):
        with self.assertRaises(ValueError):
            trackers.resolve_status("nonsense", trackers.ACTIVITY_ALIASES)

    def test_counts_and_durations(self):
        records = trackers.parse_activities_markdown(ACTIVITIES_MD)
        self.assertEqual(trackers.counts(records), {"IN PROGRESS": 1, "NOT STARTED": 2})
        self.assertEqual(trackers.parse_duration_minutes("1 hour 30 minutes"), 90)
        self.assertEqual(trackers.parse_duration_minutes("45 minutes"), 45)
        self.assertEqual(trackers.parse_duration_minutes(""), 0)


class ProfileLocks(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_lock_target("box-1234"), {"host": "box", "pid": 1234})
        self.assertIsNone(parse_lock_target("nonsense"))

    def test_only_this_host_and_a_dead_process_counts_as_stale(self):
        dead = lambda pid: False  # noqa: E731
        alive = lambda pid: True  # noqa: E731
        self.assertTrue(is_stale_lock("box-1234", host="box", alive=dead))
        self.assertFalse(is_stale_lock("box-1234", host="box", alive=alive))
        self.assertFalse(is_stale_lock("other-1234", host="box", alive=dead))


class LiveTrackers(unittest.TestCase):
    """The repo's own trackers must parse — a schema drift here is a real bug."""

    def test_repo_trackers_parse(self):
        root = Path(__file__).resolve().parent.parent
        data = trackers.load_trackers(root)
        if not data.files["paths.md"]["exists"]:
            self.skipTest("no trackers on disk")
        self.assertTrue(data.paths, "paths.md parsed to zero rows")
        self.assertTrue(all(path["id"].isdigit() for path in data.paths))
        for activity in data.activities:
            self.assertIn(activity["status"], set(trackers.ACTIVITY_ICONS))
        for path in data.paths:
            self.assertIn(path["status"], set(trackers.PATH_ICONS))


if __name__ == "__main__":
    unittest.main()
