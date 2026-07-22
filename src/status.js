const COMPLETE_WORDS = /\b(completed|complete|finished)\b/i;
const INCOMPLETE_WORDS = /\b(not completed|incomplete|not started|start course|continue course|continue|resume)\b/i;

export function detectCompletion(snapshot) {
  const body = snapshot.bodyText.replace(/\s+/g, " ").trim();
  const signals = snapshot.signals.map((value) => value.replace(/\s+/g, " ").trim());
  const all = signals.join(" | ");

  // Handle redirect to login or landing page where authentication is required
  if (body.toLowerCase().includes("please sign in to access") || body.toLowerCase().includes("sign in or join")) {
    return { completed: null, evidence: "Authentication session expired or sign in required" };
  }

  if (snapshot.progressValues.some((value) => Number(value) >= 100)) {
    return { completed: true, evidence: "progress=100" };
  }
  if (snapshot.hasCheckedCheckbox) {
    return { completed: true, evidence: "Checked checkbox found" };
  }
  if (signals.some((value) => COMPLETE_WORDS.test(value) && !INCOMPLETE_WORDS.test(value))) {
    return { completed: true, evidence: all };
  }
  const percent = [...body.matchAll(/(?:^|\s)(100)\s*%\s*(?:complete|completed)?/gi)];
  if (percent.length) return { completed: true, evidence: "100% complete" };
  if (signals.some((value) => INCOMPLETE_WORDS.test(value)) || INCOMPLETE_WORDS.test(body)) {
    return { completed: false, evidence: all || body.substring(0, 100) };
  }
  const progress = body.match(/(?:<\s*1|\d{1,2})\s*%\s*complete/i);
  if (progress) return { completed: false, evidence: progress[0] };
  return { completed: null, evidence: "Page failed to load or render" };
}
