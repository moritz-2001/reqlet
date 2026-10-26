// Instruments real UI actions in an isolated profiling origin; no application state or timings are mocked.
const parameters = new URLSearchParams(location.search);
const mib = Number(parameters.get("mib") ?? 1);
const run = parameters.get("run") ?? "manual";
const requestCount = Math.min(5000, Math.max(2, Number(parameters.get("requests") ?? 2)));
const historyCount = Math.min(100, Math.max(0, Number(parameters.get("history") ?? 0)));
const bodyMib = Math.min(2, Math.max(0, Number(parameters.get("bodymib") ?? 0)));
const tabCount = Math.min(requestCount, Math.max(2, Number(parameters.get("tabs") ?? 2)));
const fieldCount = Math.min(5000, Math.max(0, Number(parameters.get("fields") ?? 0)));
const records = [];
const longTasks = [];
const gaps = [];
let previousTick = performance.now();
setInterval(() => {
  const now = performance.now();
  gaps.push({ start: previousTick, duration: now - previousTick });
  previousTick = now;
}, 16);
if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) longTasks.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
}

const report = document.createElement("pre");
report.id = "ui-performance-results";
report.hidden = true;
document.body.append(report);
function record(name, start, extra = {}) {
  const now = performance.now();
  const record = {
    run, mib, name, durationMs: now - start,
    maxTaskMs: Math.max(0, ...longTasks.filter(task => task.start + task.duration >= start).map(task => task.duration)),
    maxTickGapMs: Math.max(0, ...gaps.filter(gap => gap.start + gap.duration >= start).map(gap => gap.duration)),
    ...extra,
  };
  records.push(record);
  report.textContent = JSON.stringify(records, null, 2);
  void fetch("/metrics", { method: "POST", body: JSON.stringify(record) });
}
const afterPaint = callback => requestAnimationFrame(() => requestAnimationFrame(callback));
let pendingResponse;
let pendingSearch;
let pendingPreview;
document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  const name = button.getAttribute("aria-label") ?? button.textContent.trim();
  const start = performance.now();
  if (name === "Send") { pendingResponse = start; pendingPreview = undefined; }
  afterPaint(() => record(`click:${name}`, start));
}, true);
document.addEventListener("input", event => {
  const name = event.target.getAttribute("aria-label") ?? event.target.placeholder ?? event.target.tagName;
  const start = performance.now();
  if (name === "Find in body" || name === "Find in entire response") pendingSearch = start;
  afterPaint(() => record(`input:${name}`, start));
}, true);
document.addEventListener("keydown", event => {
  if (!event.target.closest(".cm-content")) return;
  const start = performance.now();
  afterPaint(() => record(`editor-key:${event.key}`, start));
}, true);
new MutationObserver(() => {
  const response = document.querySelector('.response-inspector[aria-busy="false"]');
  const formatting = response?.querySelector(".body-feedback")?.textContent === "Preparing formatted preview…";
  if (pendingPreview && !formatting) {
    const start = pendingPreview;
    pendingPreview = undefined;
    afterPaint(() => record("preview-ready", start));
  }
  if (pendingSearch) {
    const feedback = document.querySelector(".large-body-search .search-feedback, .cm-body-search [role=status]")?.textContent;
    if (feedback && !feedback.startsWith("Searching")) {
      const start = pendingSearch;
      pendingSearch = undefined;
      afterPaint(() => record("search-finished", start, { feedback }));
    }
  }
  if (!pendingResponse) return;
  if (!response?.querySelector(".cm-editor")) return;
  const start = pendingResponse;
  pendingResponse = undefined;
  if (formatting) pendingPreview = start;
  afterPaint(() => record("response-visible", start, {
    summary: response.querySelector(".response-summary")?.textContent.trim(),
    renderedCharacters: response.querySelector(".cm-content")?.textContent.length,
    mode: response.querySelector(".large-body-viewer") ? "paged" : "full",
    preview: formatting ? "pending" : "ready",
  }));
}).observe(document.querySelector("#app"), { childList: true, subtree: true });

// A new origin is used for this harness. Each URL load deliberately restores synthetic data only.
const request = (name, path) => ({
  name, method: "GET", path, body: "", contentType: "application/json", headers: [], query: [],
  auth: { type: "none" }, timeoutMs: 120000,
});
const workspace = {
  version: 1,
  requests: {
    large: request(`${mib} MiB response`, `${location.origin}/fixture?mib=${mib}`),
    small: request("Small response", `${location.origin}/fixture?mib=0.001`),
  },
  collection: [
    { kind: "request", id: "large", name: `${mib} MiB response`, requestType: "GET" },
    { kind: "request", id: "small", name: "Small response", requestType: "GET" },
  ],
  environments: [], activeEnvironmentId: null, history: [], drafts: {}, closedDraftIds: [],
  openTabIds: ["large", "small"], activeTabId: "large", layout: { requests: {} },
};
// Optional fixtures expose typing/startup/navigation costs beyond response display.
// Only the active request receives a large body; thousands of definitions stay small.
if (bodyMib > 0) {
  const item = '{"id":123456,"name":"performance item","nested":{"value":"needle"}}';
  const count = Math.max(1, Math.floor(bodyMib * 1024 * 1024 / (item.length + 1)));
  workspace.requests.large.method = "POST";
  workspace.requests.large.body = `{"items":[${Array(count).fill(item).join(",")}]}`;
}
for (let index = 2; index < requestCount; index++) {
  const id = `request-${index}`;
  workspace.requests[id] = request(`Fixture request ${index}`, `${location.origin}/fixture?mib=0.001&index=${index}`);
  const folderIndex = Math.floor((index - 2) / 100);
  let folder = workspace.collection[folderIndex + 2];
  if (!folder) {
    folder = { kind: "folder", id: `folder-${folderIndex}`, name: `Fixture group ${folderIndex}`, children: [] };
    workspace.collection.push(folder);
  }
  folder.children.push({ kind: "request", id, name: workspace.requests[id].name, requestType: "GET" });
}
workspace.openTabIds = Object.keys(workspace.requests).slice(0, tabCount);
workspace.requests.large.headers = Array.from({ length: fieldCount }, (_, index) => ({
  name: `X-Fixture-${index}`, value: `value-${index}`, enabled: true,
}));
for (let index = 0; index < historyCount; index++) {
  const request = { method: "GET", url: `${location.origin}/fixture?mib=0.001`, headers: [], body: "", timeoutMs: 30000 };
  workspace.history.push({
    id: `capture-${index}`, requestId: "small", name: `Fixture capture ${index}`,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), request,
    result: { status: "success", response: {
      url: request.url, status: 200, statusText: "OK", headers: [{ name: "Content-Type", value: "application/json" }],
      body: JSON.stringify({ index, value: "fixture capture" }), durationMs: 1, sizeBytes: 64,
    } },
  });
}
await new Promise((resolve, reject) => {
  const opening = indexedDB.open("api-tool.workspace", 2);
  opening.onupgradeneeded = () => {
    for (const store of ["documents", "requests", "drafts", "history"]) {
      if (!opening.result.objectStoreNames.contains(store)) opening.result.createObjectStore(store);
    }
  };
  opening.onerror = () => reject(opening.error);
  opening.onsuccess = () => {
    const database = opening.result;
    const transaction = database.transaction(["documents", "requests", "drafts", "history"], "readwrite");
    transaction.objectStore("requests").clear();
    transaction.objectStore("drafts").clear();
    for (const [id, definition] of Object.entries(workspace.requests)) transaction.objectStore("requests").put(definition, id);
    const history = transaction.objectStore("history");
    history.clear();
    for (const entry of workspace.history) history.put(entry, entry.id);
    transaction.objectStore("documents").put({
      version: 2, commitId: crypto.randomUUID(),
      workspace: { ...workspace, requests: {}, drafts: {}, history: [] },
      requestIds: Object.keys(workspace.requests), draftIds: [],
      historyIds: workspace.history.map(entry => entry.id), warning: null,
    }, "workspace");
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = () => reject(transaction.error);
  };
});
const start = performance.now();
await import(document.querySelector('script[data-entry]').dataset.entry);
// Importing main only starts asynchronous storage restoration. Wait for Vue's
// completed mount before counting painted startup, including durable hydration.
await new Promise(resolve => {
  const root = document.querySelector("#app");
  if (root.hasAttribute("data-v-app")) { resolve(); return; }
  const observer = new MutationObserver(() => {
    if (!root.hasAttribute("data-v-app")) return;
    observer.disconnect();
    resolve();
  });
  observer.observe(root, { attributes: true });
});
afterPaint(() => record("startup-after-seed", start, {
  userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], requestCount, historyCount, bodyMib, tabCount, fieldCount,
}));
