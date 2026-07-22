const SKILLS_HOSTS = new Set(["partner.skills.google", "partner.cloudskillsboost.google"]);

const setState = (state) => chrome.storage.local.set({ checkerState: state });

function collectLinksInPage() {
  return [...document.querySelectorAll("a[href]")].map((anchor) => ({
    url: anchor.href,
    course: (anchor.textContent || anchor.getAttribute("aria-label") || anchor.href).trim()
  }));
}

function inspectCoursePage() {
  const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const controls = [...document.querySelectorAll("a,button")]
    .map((node) => (node.textContent || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim());
  const signedOut = controls.some((text) => /\b(sign in|log in|login)\b/i.test(text))
    || /please sign in to access this content/i.test(body);
  if (signedOut) return { completed: null, evidence: "AUTH REQUIRED", signedOut: true };

  const progress = [...document.querySelectorAll("progress,[role='progressbar']")].map((node) => ({
    value: Number(node.value ?? node.getAttribute("aria-valuenow")),
    max: Number(node.max ?? node.getAttribute("aria-valuemax") ?? 100),
    label: node.getAttribute("aria-label") || node.textContent || ""
  }));
  const completeProgress = progress.find((item) => Number.isFinite(item.value) && item.value >= item.max);
  if (completeProgress) return { completed: true, evidence: `Progress ${completeProgress.value}/${completeProgress.max}` };

  const statusNodes = [...document.querySelectorAll(
    "[aria-label*='complete' i],[data-testid*='complete' i],[class*='completion' i],[class*='completed' i],[class*='progress' i]"
  )];
  const signals = statusNodes.map((node) => [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title")]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const completedSignal = signals.find((text) => /\b(completed|100\s*%\s*complete)\b/i.test(text)
    && !/\b(not completed|incomplete)\b/i.test(text));
  if (completedSignal) return { completed: true, evidence: completedSignal.slice(0, 180) };
  if (/\b100\s*%\s*(complete|completed)\b/i.test(body)) {
    return { completed: true, evidence: "100% complete" };
  }

  const incompleteSignal = signals.find((text) => /\b(not completed|incomplete|not started|in progress)\b/i.test(text));
  if (incompleteSignal) return { completed: false, evidence: incompleteSignal.slice(0, 180) };
  const partial = body.match(/(?:<\s*1|[1-9]\d?)\s*%\s*complete/i);
  if (partial) return { completed: false, evidence: partial[0] };

  return { completed: null, evidence: "No recognized completion indicator", signedOut: false };
}

function waitForTab(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedId, info) {
      if (updatedId === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    }).catch(done);
  });
}

async function collectCourseLinks(tabId) {
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectLinksInPage });
  const unique = new Map();
  for (const { result = [] } of frames) {
    for (const item of result) {
      try {
        const url = new URL(item.url);
        if (!SKILLS_HOSTS.has(url.hostname)) continue;
        url.hash = "";
        if (!unique.has(url.href)) unique.set(url.href, { ...item, url: url.href });
      } catch { /* ignore malformed links */ }
    }
  }
  return [...unique.values()];
}

async function inspectTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: inspectCoursePage });
  return result;
}

async function runCheck(sourceTab) {
  try {
    const courses = await collectCourseLinks(sourceTab.id);
    if (!courses.length) throw new Error("No Partner Skills links found on the active Readiness Portal page.");
    const results = [];
    await setState({ running: true, total: courses.length, current: 0, results, message: "Starting checks…" });

    for (const [index, course] of courses.entries()) {
      await setState({ running: true, total: courses.length, current: index + 1, results, message: `Opening ${course.course}` });
      const tab = await chrome.tabs.create({ url: course.url, active: true });
      try {
        await waitForTab(tab.id);
        await new Promise((resolve) => setTimeout(resolve, 3500));
        const status = await inspectTab(tab.id);
        results.push({ ...course, ...status, checkedAt: new Date().toISOString() });
      } finally {
        await chrome.tabs.remove(tab.id).catch(() => {});
      }
    }
    await chrome.tabs.update(sourceTab.id, { active: true }).catch(() => {});
    await setState({ running: false, total: courses.length, current: courses.length, results, message: "Check complete" });
  } catch (error) {
    await setState({ running: false, total: 0, current: 0, results: [], message: error.message, error: true });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "START_CHECK") return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.url?.startsWith("https://delivery-readiness-portal.cloud.google/")) {
      throw new Error("Open the Delivery Readiness Portal course page before starting the check.");
    }
    runCheck(tab);
    sendResponse({ started: true });
  }).catch(async (error) => {
    await setState({ running: false, results: [], message: error.message, error: true });
    sendResponse({ started: false, error: error.message });
  });
  return true;
});
