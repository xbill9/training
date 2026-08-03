"""Partner Skills URL rules, mirrored from ``src/course-links.js`` and ``src/paths-db.js``.

Two rules live here, and both exist because getting them wrong corrupts data
rather than merely failing:

* **Partner is not public.** ``partner.skills.google`` has its own ID namespace.
  ``/course_templates/1090`` on the public ``skills.google`` is a *different*
  course, so a public URL is rejected rather than rewritten to the partner host —
  rewriting would relabel public content as partner content and merge it into the
  trackers as if this account owed it.
* **Activity URLs must be canonicalized before they are fetched or linked.** The
  path-scoped form Google prints on a path page answers ``403`` to every
  programmatic request; the bare form answers. See
  :func:`canonical_activity_url`, which mirrors ``canonicalActivityUrl`` in
  ``src/paths-db.js``.

``partner.cloudskillsboost.google`` is the partner site's former domain — same
catalog, same IDs — so that one *is* rewritten to the canonical host.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit, urlunsplit

# Keep in sync with SKILLS_HOSTS in src/course-links.js.
PARTNER_HOSTS = frozenset({
    "partner.skills.google",
    "www.partner.skills.google",
    # Cloud Skills Boost is the partner site's former domain: same catalog, same IDs.
    "partner.cloudskillsboost.google",
    "www.partner.cloudskillsboost.google",
})

PUBLIC_HOSTS = frozenset({
    "skills.google",
    "www.skills.google",
    "cloudskillsboost.google",
    "www.cloudskillsboost.google",
})

CANONICAL_HOST = "partner.skills.google"
CANONICAL_ORIGIN = f"https://{CANONICAL_HOST}"

_COURSE_ID = re.compile(r"/course_templates/(\d+)")
_FOCUS_ID = re.compile(r"/focuses/(\d+)")
_PATH_ID = re.compile(r"/paths/(\d+)")


def is_partner_url(value: str) -> bool:
    """True only for an https URL on a Partner Skills host."""
    try:
        parts = urlsplit(str(value))
    except ValueError:
        return False
    return parts.scheme == "https" and parts.hostname in PARTNER_HOSTS


def canonicalize(value: str) -> str:
    """Rewrite a Partner Skills URL to the canonical host, dropping any fragment.

    Only ever call this on a URL that has already passed :func:`is_partner_url`.
    Canonicalizing a public URL is exactly the corruption this module exists to
    prevent.
    """
    parts = urlsplit(str(value))
    return urlunsplit((parts.scheme, CANONICAL_HOST, parts.path, parts.query, ""))


def course_id(value: str) -> str | None:
    match = _COURSE_ID.search(str(value))
    return match.group(1) if match else None


def focus_id(value: str) -> str | None:
    match = _FOCUS_ID.search(str(value))
    return match.group(1) if match else None


def path_id(value: str) -> str | None:
    match = _PATH_ID.search(str(value))
    return match.group(1) if match else None


def canonical_activity_url(value: str, path: str | None = None) -> str:
    """Rewrite an activity URL to the form Google actually answers.

    Mirrors ``canonicalActivityUrl`` in ``src/paths-db.js``::

        /paths/70/course_templates/822          -> 403, always
        /course_templates/822                   -> the real answer
        /focuses/48936                          -> redirects to the dashboard
        /focuses/48936?parent=catalog&path=98   -> the real answer

    A lab (``/focuses/``) request takes ~30s because it provisions an
    environment; anything with a shorter timeout reports healthy labs as broken.
    """
    raw = str(value or "")
    if not raw:
        return ""
    course = _COURSE_ID.search(raw)
    if course:
        return f"{CANONICAL_ORIGIN}/course_templates/{course.group(1)}"
    focus = _FOCUS_ID.search(raw)
    if focus:
        if path:
            return f"{CANONICAL_ORIGIN}/focuses/{focus.group(1)}?parent=catalog&path={path}"
        return f"{CANONICAL_ORIGIN}/focuses/{focus.group(1)}"
    return raw if raw.startswith("http") else f"{CANONICAL_ORIGIN}{raw}"


def classify_url(value: str) -> dict:
    """Explain what a URL is and whether this project may track it."""
    raw = str(value).strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return {
            "url": raw,
            "verdict": "invalid",
            "accepted": False,
            "reason": "Not a parseable URL.",
        }

    host = parts.hostname or ""
    if host in PUBLIC_HOSTS:
        return {
            "url": raw,
            "host": host,
            "verdict": "public",
            "accepted": False,
            "reason": (
                "The public Google Skills catalog is a separate catalog with its "
                "own ID namespace. This project tracks partner.skills.google only, "
                "and rewriting the host would relabel public content as partner "
                "content. Never merge public data into a tracker."
            ),
        }
    if not host:
        return {"url": raw, "verdict": "invalid", "accepted": False, "reason": "No hostname."}
    if host not in PARTNER_HOSTS:
        return {
            "url": raw,
            "host": host,
            "verdict": "other",
            "accepted": False,
            "reason": f"{host} is not a Partner Skills host.",
        }
    if parts.scheme != "https":
        return {
            "url": raw,
            "host": host,
            "verdict": "insecure",
            "accepted": False,
            "reason": f"Scheme is {parts.scheme or 'missing'}; only https is accepted.",
        }

    canonical = canonicalize(raw)
    identifiers = {
        "course_id": course_id(canonical),
        "focus_id": focus_id(canonical),
        "path_id": path_id(canonical),
    }
    verdict = {
        "url": raw,
        "host": host,
        "verdict": "partner",
        "accepted": True,
        "canonical_url": canonical,
        **identifiers,
        "reason": "Partner Skills catalog.",
    }
    if identifiers["course_id"] or identifiers["focus_id"]:
        verdict["fetch_url"] = canonical_activity_url(canonical, identifiers["path_id"])
        if verdict["fetch_url"] != canonical:
            verdict["reason"] = (
                "Partner Skills activity. The URL as written is path-scoped, which "
                "Google answers 403 to; use fetch_url."
            )
    return verdict
