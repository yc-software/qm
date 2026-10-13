(() => {
  const { window, document, location, history } = globalThis;
  const titles = [
    "Release checklist",
    "Search result ranking",
    "Weekly customer notes",
    "Keyboard navigation",
    "Usage report",
    "Upload retries",
    "Onboarding copy",
    "Latency investigation",
  ];
  const prompts = [
    "Check the release checklist and flag anything still waiting on us.",
    "Can you make exact title matches rank above partial matches?",
    "Summarize this week's customer conversations. What changed?",
    "Test switching between panes without using the mouse.",
    "Break down last week's usage by team, and compare it with the prior week.",
    "Look into the upload failure when the connection drops halfway through.",
    "Make the welcome copy shorter. It should explain the first useful step.",
    "Find out where the extra time is going before the first response.",
  ];
  const answers = [
    "The build is green and the migration has been exercised against a copy of the staging data.\n\n**Two things remain:**\n- Review the updated welcome screen.\n- Confirm the rollback command with the on-call engineer.\n\nNothing else blocks the release.",
    "I found the ranking rule: title and body matches currently share the same weight.\n\nI'm moving exact titles ahead of the broader results, with a regression case for duplicate titles. The query shape stays unchanged.",
    "**Three themes came up repeatedly:**\n\n1. People want to resume work without hunting for the right conversation.\n2. Small teams use shared views much more than personal folders.\n3. Clear progress matters more than a busy indicator.\n\nThe strongest change from last week is the demand for a quieter workspace.",
    "The basic path works: Tab enters a conversation, and the next Tab reaches its input.\n\nI'm checking the edge cases now: closing the focused pane, restoring a saved layout, and leaving a menu open while switching.",
    "Usage rose **18%** overall. Engineering accounts for most of the increase; support was almost flat.\n\n| Team | This week | Change |\n|---|---:|---:|\n| Engineering | 1,420 | +26% |\n| Support | 860 | +3% |\n| Operations | 510 | +12% |\n\nThe daily pattern is unchanged: mornings are busiest.",
    "The server keeps the completed chunks, but the browser retries the whole file. That explains the duplicate work.\n\nI'm testing a retry from the last acknowledged chunk. A fresh upload and a resumed upload will use the same validation path.",
    "Try this:\n\n> Pick one thing you want off your plate. Ask a question, drop in a document, or tell me what needs doing.\n\nIt names a concrete first step and leaves the feature list for later.",
    "The trace points to context loading, not model startup. Three independent reads are running one after another.\n\nI'm measuring the parallel version against the same fixture before changing anything else.",
  ];
  const sessions = titles.map((title, i) => ({
    id: `demo-${i}`,
    title,
    threadRef: `web:demo:thread-${i}`,
    scopeId: "personal:demo",
    working: [1, 3, 5, 7].includes(i),
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - i * 60000,
  }));
  const leaf = (i) => ({
    type: "leaf",
    size: 500,
    data: { views: [sessions[i].id], activeView: sessions[i].id, id: `group-${i}` },
  });
  const canvas = {
    v: 2,
    active: true,
    updatedAt: Date.now(),
    layout: {
      grid: {
        root: {
          type: "branch",
          data: [0, 1, 2, 3].map((i) => ({ type: "branch", size: 400, data: [leaf(i), leaf(i + 4)] })),
        },
        width: 1600,
        height: 1000,
        orientation: "HORIZONTAL",
      },
      panels: Object.fromEntries(
        sessions.map((s) => [
          s.id,
          {
            id: s.id,
            contentComponent: "pane",
            tabComponent: "pane",
            params: { sessionId: s.id, threadRef: s.threadRef },
            title: s.title,
          },
        ]),
      ),
      activeGroup: "group-0",
    },
  };
  localStorage.setItem("web-ui:split-canvas:v1", JSON.stringify(canvas));
  window.EventSource = undefined;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const path = url.pathname;
    if (path === "/me")
      return Response.json({
        user: "demo",
        org: "demo",
        displayName: "Demo",
        permissions: [],
        companyName: "Workspace",
      });
    if (!path.startsWith("/api/")) return realFetch(input, init);
    if (path === "/api/sessions") return Response.json({ sessions });
    if (path.startsWith("/api/sessions/")) {
      if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
      const session = sessions.find((s) => path.split("/")[3] === s.id) || sessions[0];
      const i = sessions.indexOf(session);
      return Response.json({
        session,
        entries: [
          { seq: 1, type: "user", createdAt: Date.now() - 300000, payload: { text: prompts[i] } },
          { seq: 2, type: "assistant", createdAt: Date.now() - 240000, payload: { text: answers[i] } },
        ],
        earlierEntries: 0,
      });
    }
    if (path === "/api/ui-state")
      return Response.json({ value: url.searchParams.get("key") === "split-canvas" ? canvas : null, updatedAt: 0 });
    if (path === "/api/runtime-config")
      return Response.json({
        scopeId: "personal:demo",
        approvedHarnesses: ["pi"],
        modelsByHarness: { pi: ["claude-opus-5-5"] },
        modelCatalog: {
          "claude-opus-5-5": {
            id: "claude-opus-5-5",
            name: "Claude Opus 5.5",
            label: "Opus 5.5",
            buttonLabel: "Opus 5.5",
            provider: "anthropic",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text"],
            contextWindow: 1000000,
            maxTokens: 128000,
            fastMode: true,
            effortLevelsByHarness: { pi: ["low", "medium", "high"] },
          },
        },
        orgDefault: { harnessId: "pi", modelId: "claude-opus-5-5", effortLevel: "medium", revision: 1 },
        effective: { harnessId: "pi", modelId: "claude-opus-5-5", effortLevel: "medium" },
        scopeOverride: null,
        upgradeAvailable: false,
      });
    if (path === "/api/turn")
      return Response.json({ error: "This demo is local-only; messages are not sent." }, { status: 400 });
    return Response.json({
      contexts: [],
      items: [],
      crons: [],
      runs: [],
      runId: null,
      run: null,
      approvals: [],
      queued: [],
    });
  };
  const style = document.createElement("style");
  style.textContent = `.sidebar,.sidebar-resize-handle,.sidebar-scrim,.mobile-menu-btn{display:none!important}.layout{grid-template-columns:1fr!important;padding-top:44px}.demo-variants{position:fixed;inset:0 0 auto;z-index:9999;height:44px;display:flex;align-items:center;gap:20px;padding:0 16px;background:var(--background);border-bottom:1px solid var(--border);font:12px system-ui;color:var(--muted-foreground)}.demo-variants strong{color:var(--foreground);font-weight:600}.demo-variants a{color:inherit;text-decoration:none}.demo-variants a[aria-current=true]{color:var(--foreground);font-weight:600}.demo-variants span{margin-left:auto}`;
  document.head.append(style);
  const chrome = new URLSearchParams(location.search).get("chrome") || "focus";
  if (!new URLSearchParams(location.search).has("chrome")) history.replaceState(null, "", "?chrome=focus");
  const nav = document.createElement("nav");
  nav.className = "demo-variants";
  nav.innerHTML = `<strong>Less chrome</strong><a href="?chrome=focus" aria-current="${chrome === "focus"}">A · Focus chrome</a><a href="?chrome=quiet" aria-current="${chrome === "quiet"}">B · Quiet headers</a><span>Mock conversations · Click a pane to work in it</span>`;
  document.body.append(nav);
})();
