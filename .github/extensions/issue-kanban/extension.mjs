// Extension: issue-kanban
// Issue triage Kanban board for tailspin-toys

import { createServer } from "node:http";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const REPO = "marcelmedina/tailspin-toys";

// Issues fetched at extension load time — refreshed on each canvas open.
let cachedIssues = [];

async function fetchIssues() {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    try {
        const { stdout } = await exec("gh", [
            "issue", "list",
            "--repo", REPO,
            "--state", "open",
            "--json", "number,title,labels,body,createdAt,updatedAt,assignees,comments",
            "--limit", "50",
        ]);
        return JSON.parse(stdout);
    } catch {
        return cachedIssues;
    }
}

// Triage logic: score each issue and pick the top 3.
// Scoring factors: label weights, recency (updatedAt), open age (createdAt), comment activity.
function scoreIssue(issue) {
    let score = 0;
    const now = Date.now();
    const updatedDaysAgo = (now - new Date(issue.updatedAt).getTime()) / 86400000;
    const createdDaysAgo = (now - new Date(issue.createdAt).getTime()) / 86400000;
    const labels = (issue.labels || []).map(l => (l.name || "").toLowerCase());

    // Label-based priority
    if (labels.some(l => l.includes("bug") || l.includes("critical") || l.includes("urgent"))) score += 40;
    if (labels.some(l => l.includes("high") || l.includes("priority"))) score += 25;
    if (labels.some(l => l.includes("security"))) score += 35;
    if (labels.some(l => l.includes("blocked"))) score += 20;
    if (labels.some(l => l.includes("perf") || l.includes("performance"))) score += 15;

    // Recently updated issues signal active discussion
    if (updatedDaysAgo < 1) score += 20;
    else if (updatedDaysAgo < 3) score += 12;
    else if (updatedDaysAgo < 7) score += 6;

    // Long-open unresolved issues may be stale — penalise slightly
    if (createdDaysAgo > 30) score -= 5;

    // Comment activity signals community interest
    score += Math.min((issue.comments || []).length * 3, 15);

    // Issues with assignees are already being handled — lower urgency slightly
    if ((issue.assignees || []).length > 0) score -= 10;

    // Prefer lower-numbered (older) issues as a tiebreaker for discoverability
    score -= issue.number * 0.1;

    return score;
}

function justification(issue) {
    const labels = (issue.labels || []).map(l => (l.name || "").toLowerCase());
    const reasons = [];
    if (labels.some(l => l.includes("bug") || l.includes("critical"))) reasons.push("marked as a bug or critical issue");
    if (labels.some(l => l.includes("security"))) reasons.push("has a security label");
    if (labels.some(l => l.includes("high") || l.includes("priority"))) reasons.push("flagged as high priority");
    if (labels.some(l => l.includes("blocked"))) reasons.push("is blocking other work");
    if ((issue.comments || []).length > 0) reasons.push(`has ${issue.comments.length} comment${issue.comments.length > 1 ? "s" : ""} indicating active discussion`);
    const updatedDaysAgo = (Date.now() - new Date(issue.updatedAt).getTime()) / 86400000;
    if (updatedDaysAgo < 3) reasons.push("was recently updated");
    if ((issue.assignees || []).length === 0) reasons.push("is currently unassigned");
    // Feature scope signals
    const body = (issue.body || "").toLowerCase();
    if (body.includes("search") || body.includes("discoverability")) reasons.push("improves catalog discoverability");
    if (body.includes("sort") || body.includes("filter")) reasons.push("improves browsing UX");
    if (body.includes("pagination") || body.includes("performance")) reasons.push("addresses performance/scalability");
    if (body.includes("publisher")) reasons.push("adds navigation to a core catalog entity");
    if (body.includes("description") || body.includes("context")) reasons.push("surfaces data already in the schema");
    if (body.includes("summary") || body.includes("landing")) reasons.push("improves first-impression of the landing page");
    if (reasons.length === 0) reasons.push("is open and unassigned");
    return reasons.slice(0, 3).join(", ") + ".";
}

function excerpt(body = "", maxLen = 180) {
    const clean = body.replace(/##\s+/g, "").replace(/\n+/g, " ").replace(/- \[ \]/g, "").trim();
    return clean.length > maxLen ? clean.slice(0, maxLen - 1) + "…" : clean;
}

function renderHtml(issues) {
    const scored = issues
        .map(i => ({ ...i, _score: scoreIssue(i) }))
        .sort((a, b) => b._score - a._score);

    const top = scored.slice(0, 3);
    const rest = scored.slice(3);

    function priorityCard(issue) {
        return `
        <div class="card priority" id="issue-${issue.number}">
          <div class="card-header">
            <span class="badge">🔥 Priority</span>
            <a class="issue-link" href="https://github.com/${REPO}/issues/${issue.number}" target="_blank">#${issue.number}</a>
          </div>
          <h3 class="card-title">${escHtml(issue.title)}</h3>
          <p class="card-desc">${escHtml(excerpt(issue.body))}</p>
          <div class="rationale">
            <span class="rationale-label">Why now:</span> ${escHtml(justification(issue))}
          </div>
          <div class="card-meta">
            ${(issue.labels || []).map(l => `<span class="label">${escHtml(l.name)}</span>`).join("")}
            ${issue.assignees?.length ? `<span class="assignee">👤 ${issue.assignees.map(a => escHtml(a.login)).join(", ")}</span>` : '<span class="unassigned">Unassigned</span>'}
          </div>
          <button class="work-btn" onclick="loadIssue(${issue.number}, ${JSON.stringify(escHtml(issue.title))})">
            ⚡ Work on this
          </button>
        </div>`;
    }

    function backlogCard(issue) {
        return `
        <div class="card backlog" id="issue-${issue.number}">
          <div class="card-header">
            <a class="issue-link" href="https://github.com/${REPO}/issues/${issue.number}" target="_blank">#${issue.number}</a>
            ${(issue.labels || []).map(l => `<span class="label">${escHtml(l.name)}</span>`).join("")}
            ${issue.assignees?.length ? `<span class="assignee">👤 ${issue.assignees.map(a => escHtml(a.login)).join(", ")}</span>` : '<span class="unassigned">Unassigned</span>'}
          </div>
          <h3 class="card-title">${escHtml(issue.title)}</h3>
          <button class="work-btn secondary" onclick="loadIssue(${issue.number}, ${JSON.stringify(escHtml(issue.title))})">
            Work on this
          </button>
        </div>`;
    }

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tailspin Toys — Issue Triage</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 1.5rem;
      min-height: 100vh;
    }
    h1 { font-size: 1.5rem; font-weight: 700; color: #f8fafc; margin-bottom: 0.25rem; }
    .subtitle { font-size: 0.85rem; color: #94a3b8; margin-bottom: 1.5rem; }
    h2 { font-size: 1rem; font-weight: 600; color: #94a3b8; text-transform: uppercase;
         letter-spacing: 0.05em; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
    h2 .count { background: #1e293b; color: #64748b; font-size: 0.75rem;
                padding: 0.1rem 0.4rem; border-radius: 999px; }
    .section { margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    .card {
      background: #1e293b;
      border-radius: 0.75rem;
      padding: 1.1rem;
      border: 1px solid #334155;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
      transition: border-color 0.15s;
    }
    .card:hover { border-color: #475569; }
    .card.priority { border-color: #3b82f6; background: #1a2840; }
    .card.priority:hover { border-color: #60a5fa; }
    .card-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .badge { font-size: 0.7rem; font-weight: 700; background: #1d4ed8; color: #bfdbfe;
              padding: 0.15rem 0.5rem; border-radius: 999px; text-transform: uppercase; }
    .issue-link { font-size: 0.75rem; color: #60a5fa; text-decoration: none; margin-left: auto; }
    .issue-link:hover { text-decoration: underline; }
    .card-title { font-size: 0.95rem; font-weight: 600; color: #f1f5f9; line-height: 1.4; }
    .card-desc { font-size: 0.82rem; color: #94a3b8; line-height: 1.5; }
    .rationale { font-size: 0.8rem; color: #7dd3fc; background: #0c1a2e; border-left: 3px solid #3b82f6;
                  padding: 0.4rem 0.6rem; border-radius: 0 0.3rem 0.3rem 0; line-height: 1.4; }
    .rationale-label { font-weight: 700; color: #93c5fd; }
    .card-meta { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; margin-top: 0.2rem; }
    .label { font-size: 0.7rem; background: #334155; color: #94a3b8;
               padding: 0.1rem 0.45rem; border-radius: 999px; }
    .assignee { font-size: 0.7rem; color: #64748b; }
    .unassigned { font-size: 0.7rem; color: #475569; font-style: italic; }
    .work-btn {
      margin-top: auto;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      padding: 0.5rem 0.9rem;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      text-align: center;
    }
    .work-btn:hover { background: #1d4ed8; }
    .work-btn.secondary { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
    .work-btn.secondary:hover { background: #334155; color: #e2e8f0; }
    .toast {
      position: fixed; bottom: 1.5rem; right: 1.5rem;
      background: #166534; color: #bbf7d0;
      padding: 0.7rem 1.2rem; border-radius: 0.6rem;
      font-size: 0.85rem; font-weight: 600;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      opacity: 0; transform: translateY(8px);
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: none;
      z-index: 999;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .divider { border: none; border-top: 1px solid #1e293b; margin: 1.5rem 0; }
  </style>
</head>
<body>
  <h1>🎲 Tailspin Toys — Issue Triage</h1>
  <p class="subtitle">Open issues · <a style="color:#60a5fa" href="https://github.com/${REPO}/issues" target="_blank">github.com/${REPO}</a></p>

  <div class="section">
    <h2>🔥 Needs Attention <span class="count">${top.length}</span></h2>
    <div class="grid">
      ${top.map(priorityCard).join("")}
    </div>
  </div>

  <hr class="divider" />

  <div class="section">
    <h2>📋 Backlog <span class="count">${rest.length}</span></h2>
    <div class="grid">
      ${rest.map(backlogCard).join("")}
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function loadIssue(number, title) {
      // Post a message to the Copilot host to load this issue into the session context
      window.parent?.postMessage({ type: "copilot:load-issue", number, title }, "*");
      // Also try the canvas action bridge
      fetch("/action/load_issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number, title }),
      }).catch(() => {});
      showToast("✅ #" + number + " added to context");
    }
    function showToast(msg) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 3000);
    }
  </script>
</body>
</html>`;
}

function escHtml(str = "") {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const servers = new Map();
// Per-instance state: tracks the last "load_issue" action result so the agent can read it.
const pendingIssues = new Map();

async function startServer(instanceId) {
    const issues = await fetchIssues();
    cachedIssues = issues;

    const server = createServer(async (req, res) => {
        if (req.method === "POST" && req.url === "/action/load_issue") {
            let body = "";
            req.on("data", d => (body += d));
            req.on("end", () => {
                try {
                    const data = JSON.parse(body);
                    pendingIssues.set(instanceId, data);
                } catch { /* ignore parse errors — respond 200 regardless */ }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        // Serve the Kanban board HTML (re-use cached issues for speed).
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml(cachedIssues.length ? cachedIssues : issues));
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

await joinSession({
    canvases: [
        createCanvas({
            id: "issue-kanban",
            displayName: "Issue Triage Kanban",
            description: "Triage open GitHub issues for tailspin-toys, with the top 3 needing attention highlighted.",
            actions: [
                {
                    name: "load_issue",
                    description: "Load a specific issue into the session context by number so the agent can start working on it.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            number: { type: "number", description: "GitHub issue number" },
                        },
                        required: ["number"],
                    },
                    handler: async (ctx) => {
                        const issueNumber = ctx.input?.number;
                        const issue = cachedIssues.find(i => i.number === issueNumber);
                        if (!issue) return { ok: false, error: "Issue not found in cached list." };
                        return {
                            ok: true,
                            message: `Ready to work on issue #${issue.number}: "${issue.title}". Here is a summary of what needs to be done:\n\n${issue.body}`,
                            issue,
                        };
                    },
                },
                {
                    name: "refresh",
                    description: "Re-fetch issues from GitHub and update the Kanban board.",
                    handler: async (_ctx) => {
                        cachedIssues = await fetchIssues();
                        return { ok: true, count: cachedIssues.length };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                } else {
                    // Refresh issues on re-open
                    cachedIssues = await fetchIssues();
                }
                return {
                    title: "Issue Triage — Tailspin Toys",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    pendingIssues.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
