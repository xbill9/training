const message = document.querySelector("#message");
const start = document.querySelector("#start");
const download = document.querySelector("#download");
const progress = document.querySelector("#progress");
const bar = document.querySelector("#bar");
const list = document.querySelector("#results");
let latestResults = [];

function label(result) {
  return result.completed === true ? "COMPLETED" : result.completed === false ? "NOT COMPLETED" : result.signedOut ? "AUTH REQUIRED" : "UNKNOWN";
}

function render(state = {}) {
  latestResults = state.results || [];
  message.textContent = state.message || "Ready";
  start.disabled = Boolean(state.running);
  progress.hidden = !state.running;
  bar.style.width = state.total ? `${(state.current / state.total) * 100}%` : "0";
  download.hidden = !latestResults.length;
  list.replaceChildren(...latestResults.map((result) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = result.url;
    link.target = "_blank";
    link.textContent = result.course || result.url;
    const status = document.createElement("span");
    status.className = result.completed === true ? "complete" : result.completed === false ? "incomplete" : "unknown";
    status.textContent = `${label(result)} — ${result.evidence}`;
    item.append(link, status);
    return item;
  }));
}

function markdown(results) {
  const now = new Date().toISOString();
  const rows = results.map((item) => {
    const name = (item.course || item.url).replaceAll("|", "\\|");
    const evidence = item.evidence.replaceAll("|", "\\|");
    return `| [${name}](${item.url}) | ${label(item)} | ${evidence} | ${item.checkedAt || now} |`;
  });
  return ["# Course completion tracker", "", `Last updated: ${now}`, "", "| Course | Completion status | Evidence | Last checked |", "|---|---|---|---|", ...rows, ""].join("\n");
}

start.addEventListener("click", async () => {
  message.textContent = "Starting…";
  const response = await chrome.runtime.sendMessage({ type: "START_CHECK" });
  if (!response?.started) message.textContent = response?.error || "Could not start";
});

download.addEventListener("click", () => {
  const blob = new Blob([markdown(latestResults)], { type: "text/markdown" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "completions.md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

chrome.storage.local.get("checkerState").then(({ checkerState }) => render(checkerState));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.checkerState) render(changes.checkerState.newValue);
});
