// Status vocabulary shared by the paths database and the scanner.
//
// Paths and activities use separate vocabularies: a path is a container that is
// open until every activity inside it is done, while an activity is a single
// course or lab that is either finished, started, untouched, broken, or gone.

export const PATH_FINISHED = "FINISHED";
export const PATH_OPEN = "OPEN";
export const PATH_NOT_STARTED = "NOT STARTED";
export const PATH_UNKNOWN = "UNKNOWN";

export const ACTIVITY_COMPLETED = "COMPLETED";
export const ACTIVITY_IN_PROGRESS = "IN PROGRESS";
export const ACTIVITY_NOT_STARTED = "NOT STARTED";
export const ACTIVITY_MISSING = "MISSING";
export const ACTIVITY_UNKNOWN = "UNKNOWN";

const PATH_ICONS = {
  [PATH_FINISHED]: "✅",
  [PATH_OPEN]: "🔄",
  [PATH_NOT_STARTED]: "⬜",
  [PATH_UNKNOWN]: "❔"
};

const ACTIVITY_ICONS = {
  [ACTIVITY_COMPLETED]: "✅",
  [ACTIVITY_IN_PROGRESS]: "🔄",
  [ACTIVITY_NOT_STARTED]: "❌",
  [ACTIVITY_MISSING]: "⚠️",
  [ACTIVITY_UNKNOWN]: "❔"
};

export function pathStatusLabel(status) {
  return `${PATH_ICONS[status] || PATH_ICONS[PATH_UNKNOWN]} ${status}`;
}

export function activityStatusLabel(status) {
  return `${ACTIVITY_ICONS[status] || ACTIVITY_ICONS[ACTIVITY_UNKNOWN]} ${status}`;
}

function statusFromLabel(label, icons, fallback) {
  const text = String(label ?? "");
  for (const [status, icon] of Object.entries(icons)) {
    if (text.includes(icon) && text.includes(status)) return status;
  }
  // Icons alone are enough: a hand-edited cell may drop the word.
  for (const [status, icon] of Object.entries(icons)) {
    if (text.includes(icon)) return status;
  }
  return fallback;
}

export function parsePathStatus(label) {
  return statusFromLabel(label, PATH_ICONS, PATH_UNKNOWN);
}

export function parseActivityStatus(label) {
  return statusFromLabel(label, ACTIVITY_ICONS, ACTIVITY_UNKNOWN);
}

export function formatPercent(progress) {
  if (progress === null || progress === undefined || Number.isNaN(progress)) return "—";
  return `${Math.round(progress * 100)}%`;
}

// An activity carries `completed` (from the card's boolean attribute) and
// `progress` (0..1 from the card's progress bar). `linkBroken` is only set by
// the optional link-verification pass, and `removed` when a path we scanned
// successfully no longer lists an activity we recorded earlier.
export function classifyActivity(activity) {
  if (activity.removed) {
    return { status: ACTIVITY_MISSING, issue: "No longer listed in this path (retired or moved)" };
  }
  if (activity.linkBroken) {
    return { status: ACTIVITY_MISSING, issue: `Link is dead (${activity.linkBroken})` };
  }
  if (activity.completed === true) return { status: ACTIVITY_COMPLETED, issue: "" };
  if (activity.completed === null || activity.completed === undefined) {
    return { status: ACTIVITY_UNKNOWN, issue: activity.evidence || "Status could not be read" };
  }
  // Verified 403: the content exists, this account just cannot open it. That is
  // an entitlement problem, not a broken link, and no amount of study clears it.
  if (activity.linkRestricted) {
    return {
      status: activity.progress > 0 ? ACTIVITY_IN_PROGRESS : ACTIVITY_NOT_STARTED,
      issue: "Access denied (403) — account not entitled"
    };
  }
  if (activity.progress > 0) {
    return { status: ACTIVITY_IN_PROGRESS, issue: `Started but stalled at ${formatPercent(activity.progress)}` };
  }
  return { status: ACTIVITY_NOT_STARTED, issue: "" };
}

// A path is finished only when every activity in it is complete. `progress` is
// the site's own headline percentage, kept as a tie-breaker for paths whose
// activity list failed to render.
export function classifyPath(path) {
  const activities = path.activities || [];
  if (path.unreadable || (!activities.length && path.progress === null)) {
    return { status: PATH_UNKNOWN, issue: path.evidence || "Path page could not be read" };
  }
  const done = activities.filter((a) => a.completed === true).length;
  const unknown = activities.filter((a) => a.completed === null || a.completed === undefined).length;
  if (activities.length && done === activities.length) return { status: PATH_FINISHED, issue: "" };
  if (!activities.length) {
    // No cards rendered, but the site reported a percentage.
    if (path.progress >= 1) return { status: PATH_FINISHED, issue: "" };
    return {
      status: path.progress > 0 ? PATH_OPEN : PATH_NOT_STARTED,
      issue: "No activities listed on the path page"
    };
  }
  if (done > 0 || path.progress > 0 || activities.some((a) => a.progress > 0)) {
    return { status: PATH_OPEN, issue: unknown ? `${unknown} activity status(es) unreadable` : "" };
  }
  return { status: PATH_NOT_STARTED, issue: unknown ? `${unknown} activity status(es) unreadable` : "" };
}

// Whichever of the two available signals is further along:
//
//   - the site's headline percentage, which counts progress *inside* an
//     activity (40% through the first of two courses reads better than 0/2), and
//   - the share of activities completed.
//
// Neither alone is right. The headline is missing or stale on plenty of paths —
// reporting "0%" next to "5/7 done" is just wrong — while the completed share
// cannot see part-finished work. Taking the larger keeps both truths.
export function pathProgress(path) {
  const headline = path.progress === null || path.progress === undefined || Number.isNaN(path.progress)
    ? null
    : path.progress;
  const activities = path.activities || [];
  if (!activities.length) return headline;
  const share = activities.filter((a) => a.completed === true).length / activities.length;
  return headline === null ? share : Math.max(headline, share);
}
