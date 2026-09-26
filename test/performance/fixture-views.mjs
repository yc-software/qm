import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, CALENDAR_EXCLUSION } from "./catalog.mjs";
import { sha256 } from "./verify.mjs";

export function deriveViewFixtures(fixture, observations) {
  assert.equal(observations.fixtureId, fixture.fixtureId, "View evidence belongs to another fixture");
  const output = structuredClone(fixture);
  output.browser ??= {};
  const views = (output.views = {});
  const gaps = [];
  const evidence = [];
  const normalizations = [];
  const scope = fixture.orgScopeId ?? fixture.browser?.orgScopeId;
  const admin = fixture.adminPrincipalId ?? fixture.browser?.adminPrincipalId;
  const adminHistoryCohorts = fixture.adminHistoryCohorts ?? fixture.cohorts;
  const rows = observations.rows ?? [];
  const read = (path, principalId = admin, expectedStatus = 200) => {
    const row = rows.find((entry) => entry.path === path && (entry.principalId ?? admin) === principalId);
    assert.equal(row?.status, expectedStatus, `Missing successful fixture observation: ${path}`);
    evidence.push({
      path,
      principalId: row.principalId ?? admin,
      status: row.status,
      sha256: sha256(JSON.stringify(row.data)),
    });
    return row.data;
  };
  const attempt = (name, action) => {
    try {
      action();
    } catch (error) {
      gaps.push({ scenario: name, reason: String(error.message ?? error) });
    }
  };
  const text = (name, expectedText, extra = {}) => {
    assert.ok([expectedText].flat().length > 0);
    assert.ok([expectedText].flat().every((value) => typeof value === "string" && value.trim()));
    views[name] = { expectedText: [expectedText].flat(), ...extra };
  };
  const data = read("/admin/api/me");
  assert.equal(data.principal, admin);
  assert.equal(data.scopeId, scope);
  assert.equal(data.isAdmin, true);
  const directory = read("/admin/api/scopes");
  assert.equal(directory.scopeId, scope);
  const shortName = (id) => {
    assert.ok(typeof id === "string" && id.includes(":"), "Resource has no valid owner scope");
    const [kind, ...pieces] = id.split(":");
    if (kind === "org") return "org";
    const label = directory.scopes.find((row) => row.scopeId === id)?.label;
    if (label) return label;
    const rest = pieces.join(":");
    if (["channel", "group"].includes(kind)) return rest.startsWith("#") ? rest : `#${rest}`;
    const local = rest.split("@")[0];
    return kind === "personal" && /^[a-z]/.test(local) ? local[0].toUpperCase() + local.slice(1) : rest;
  };
  const scoped = (view) => `/admin/api/${view}?scope=${encodeURIComponent(scope)}`;
  const settings = (view) => `/admin/api/scopes/${encodeURIComponent(scope)}?view=${view}`;
  const historyPath = (cohort, offset = 0) =>
    `/admin/api/sessions?scope=${encodeURIComponent(cohort.scopeId)}&limit=50&offset=${offset}&category=conversation`;
  const historyView = (name, cohort, offset = 0) => {
    const page = read(historyPath(cohort, offset));
    assert.equal(page.scopeId, cohort.scopeId);
    assert.equal(page.offset, offset, "History pagination did not reach its requested offset");
    if (Number.isSafeInteger(cohort.conversationCount))
      assert.equal(page.total, cohort.conversationCount, "Admin conversation count differs from its fixture cohort");
    assert.ok(page.sessions.length > 0, "History fixture has no rows on the requested page");
    const row = offset ? page.sessions[0] : page.sessions.find((entry) => entry.id === cohort.rootCase.sessionId);
    assert.ok(row, "History page is missing its fixture conversation");
    let sentinel = `QM PERF ${row.id} first`;
    if (offset && row.firstMessage?.startsWith("QM performance fixture ")) sentinel = row.firstMessage;
    assert.ok(row.firstMessage?.startsWith(sentinel), "Fixture history first-message sentinel is missing");
    if (offset) assert.ok(!read(historyPath(cohort)).sessions.some((entry) => entry.id === row.id));
    text(name, sentinel, {
      rows: { selector: ".dense-row", minimum: page.sessions.length },
      controlSelector: `a.dense-row[href^="/admin/history/s/${encodeURIComponent(row.id)}"]`,
    });
  };
  attempt("scopes", () => {
    const row = directory.scopes.find((entry) => entry.scopeId === adminHistoryCohorts.max.scopeId);
    assert.ok(row && row.sessions > 0, "Scope directory is missing the max cohort");
    text("scopes", shortName(row.scopeId), { rows: { selector: ".dense-row", minimum: 1 } });
  });
  for (const name of ["median", "p95", "max"])
    attempt(`history.${name}`, () => historyView(`history.${name}`, adminHistoryCohorts[name]));
  attempt("history.next", () => historyView("history.next", adminHistoryCohorts.max, 50));
  attempt("audit", () => {
    const result = read(scoped("audit"));
    assert.equal(result.scopeId, scope, "Audit response has the wrong scope");
    assert.ok(
      result.events?.some(
        (row) => row.principalId === admin && row.action === "audit.read" && row.resource === "audit",
      ),
    );
    text("audit", [admin, "audit.read"], {
      rows: { selector: "tbody tr", minimum: result.events.length },
      rowTexts: [{ selector: "tbody tr", texts: [admin, "audit.read", "audit"] }],
    });
  });
  for (const [view, key, marker] of [
    ["errors", "errors", "QM performance error"],
    ["egress", "records", "fixture.example.invalid"],
  ])
    attempt(view, () => {
      const result = read(scoped(view));
      assert.ok(
        result[key]?.some((row) => JSON.stringify(row).includes(marker)),
        "Seeded log rows are missing",
      );
      text(view, marker, { rows: { selector: "tbody tr", minimum: 1 } });
    });
  for (const [view, key, field, marker] of [
    ["files", "files", "name", "QM performance file"],
    ["skills", "skills", "name", "perf-skill-"],
    ["crons", "crons", "title", "QM performance cron"],
  ])
    attempt(view, () => {
      const result = read(scoped(view));
      const item = result[key]?.find((row) => row[field]?.startsWith(marker));
      assert.ok(item, `Seeded ${view} item is missing`);
      const owner = item.ownerScopeId ?? item.scopeId;
      const count = result[key].filter((row) => (row.ownerScopeId ?? row.scopeId) === owner).length;
      const noun = { files: "file", skills: "skill", crons: "cron" }[view];
      text(view, [shortName(owner), `${count} ${noun}${count === 1 ? "" : "s"}`], {
        rows: { selector: ".dense-row", minimum: 1 },
      });
    });
  attempt("memory", () => {
    const result = read("/admin/api/memory/scopes");
    const item = result.scopes?.find((row) => row.hasMemory && row.bytes > 0);
    assert.ok(item, "No seeded nonempty notebook is exposed by the API");
    let size = `${item.bytes} B`;
    if (item.bytes >= 1048576) size = `${(item.bytes / 1048576).toFixed(1)} MB`;
    else if (item.bytes >= 1024) size = `${(item.bytes / 1024).toFixed(1)} KB`;
    text("memory", [shortName(item.scopeId), size], { rows: { selector: ".memory-notebooks .dense-row", minimum: 1 } });
  });
  attempt("judgments", () => {
    const result = read("/admin/api/ambient-judgments?decision=act,ignore");
    assert.ok(result.judgments?.some((row) => row.reason === "QM performance decision"));
    text("judgments", "QM performance decision");
  });
  attempt("slack", () => {
    const result = read("/admin/api/slack-mirror");
    const row = result.containers?.find((entry) => entry.container?.startsWith("perf-") && entry.messageCount > 0);
    assert.ok(row, "Seeded Slack messages are not exposed in the mirror index");
    const label = row.kind === "channel" ? `#${row.name || row.container}` : row.name || row.container;
    text("slack", label, { rows: { selector: ".dense-row", minimum: 1 } });
  });
  attempt("deployments", () => {
    const result = read(scoped("deployments"));
    assert.ok(result.deployments?.length, "Deployment data was not seeded; an empty index does not prove parity");
    text("deployments", shortName(result.deployments[0].ownerScopeId), {
      rows: { selector: ".dense-row", minimum: 1 },
    });
  });
  attempt("users", () => {
    const result = read("/admin/api/users");
    assert.ok(
      result.users?.some((row) => row.principalId === admin && row.sessionCount === fixture.cohorts.max.sessionCount),
    );
    text("users", admin, { rows: { selector: ".users-roster tbody tr", minimum: result.users.length } });
  });
  attempt("governance", () => {
    const result = read(settings("governance"));
    assert.equal(result.scopeId, scope);
    views.governance = {
      values: [
        { selector: "#security-posture", value: result.securityPosture },
        { selector: "#sharing-posture", value: result.sharingPosture },
      ],
    };
  });
  attempt("models", () => {
    const result = read(settings("models"));
    const configuredHarness = result.runtime?.harnessId || result.harnessDefault || "pi";
    const harnesses = result.harnessOptions?.length ? result.harnessOptions : [result.harnessDefault || "pi"];
    const harness = harnesses.includes(configuredHarness) ? configuredHarness : harnesses[0];
    const configuredModel = result.runtime?.modelId || result.baseModel || result.baseModelDefault;
    const choices = result.modelsByHarness?.[harness] ?? result.baseModelOptions;
    const model = choices.some((row) => row.id === configuredModel) ? configuredModel : choices[0]?.id;
    assert.ok(harness && model, "Model settings have no selectable runtime");
    if (harness !== configuredHarness || model !== configuredModel)
      normalizations.push({
        view: "models",
        configuredHarness,
        configuredModel,
        renderedHarness: harness,
        renderedModel: model,
      });
    const providers = read("/admin/api/custom-providers").providers;
    assert.ok(providers.length === 0, "Provide a provider-specific sentinel for configured custom providers");
    text("models", "No custom providers.", {
      values: [
        { selector: "#base-harness", value: harness },
        { selector: "#base-model", value: model },
      ],
    });
  });
  attempt("credentials", () => {
    const result = read(settings("credentials"));
    assert.ok(Array.isArray(result.serviceCredentials));
    read("/admin/api/keychain?summary=1");
    text(
      "credentials",
      result.serviceCredentials.length
        ? result.serviceCredentials[0].name || result.serviceCredentials[0].slug
        : "No credentials configured.",
      { absentTexts: ["Loading credentials…", "Loading usage…"] },
    );
  });
  attempt("connectors", () => {
    const result = read(settings("connectors"));
    const catalog = read("/admin/api/connector-catalog").catalog;
    assert.ok(
      result.connectors.length === 0 && !catalog.some((row) => row.configured),
      "Provide configured-connector sentinels for this fixture",
    );
    text("connectors", "No connectors configured. Add one below to make it linkable in the web UI.");
  });
  attempt("customize", () => {
    const result = read(settings("customize"));
    assert.ok(result.soul?.trim());
    text("customize", result.soul, { values: [{ selector: "#soul", value: result.soul }] });
  });
  attempt("slack-settings", () => {
    const result = read("/admin/api/slack-installation");
    const settingsData = read(settings("slack-settings"));
    const emojiStatus = rows.find((row) => row.path === "/admin/api/slack-emoji")?.status;
    assert.ok([200, 404].includes(emojiStatus), "Slack emoji state needs an observed response");
    const emoji = read("/admin/api/slack-emoji", admin, emojiStatus);
    if (emojiStatus === 404) assert.equal(emoji.error, "not_configured");
    else assert.ok(emoji.emoji && Array.isArray(emoji.standard) && emoji.standard.length);
    output.browser.features ??= {};
    output.browser.features.slack = {
      ...output.browser.features.slack,
      emojiCatalogAvailable: emojiStatus === 200,
    };
    text(
      "slack-settings",
      result.configured ? result.teamName || result.teamId || "Slack workspace" : "Connect your workspace",
      { values: [{ selector: "#internal-member-overrides", value: settingsData.internalMemberOverrides.join("\n") }] },
    );
  });
  for (const range of ["7d", "30d", "90d"])
    attempt(`spend.${range}`, () => {
      const row = rows.find((entry) => {
        if (!entry.path.startsWith("/admin/api/spend?")) return false;
        const params = new URL(entry.path, "http://fixture.invalid").searchParams;
        return (Date.parse(params.get("to")) - Date.parse(params.get("from"))) / 86400000 === parseInt(range);
      });
      assert.ok(row, `No spend observation for ${range}`);
      const result = read(row.path);
      assert.ok(result.org?.calls > 0 && result.series?.length && result.models?.length);
      const person = result.people.find((entry) => entry.principalId?.startsWith("perf-"));
      assert.ok(person, "Spend is missing synthetic principal data");
      text(
        range === "30d" ? "spend" : `spend.${range}`,
        [
          result.models[0].model,
          person.displayName || person.principalId,
          `$${Number(result.models[0].costUsd).toFixed(2)}`,
        ],
        { rows: { selector: ".spend-models tbody tr", minimum: result.models.length } },
      );
    });
  attempt("web.settings", () => {
    const me = read("/me");
    assert.equal(me.user, fixture.cases.short.principalId);
    const result = read("/api/user-model-auth/status");
    assert.ok(["company", "anthropic", "openai"].includes(result.account));
    text("web.settings", `${me.displayName?.trim() || me.user} · ${me.org}`, {
      controlSelector: '[aria-label="AI access"] button[aria-pressed="true"]',
    });
  });
  attempt("web.browse", () => {
    const me = read("/me");
    const labels = ["Projects", "Files", "Crons", "Webhooks", "Keychain", "Apps", "Memory", "Skills"];
    if (me.permissions.includes("loops")) labels.push("Loops");
    if (me.permissions.includes("admin")) labels.push("Admin");
    text("web.browse", labels, {
      rows: { selector: "a.browse-tile", minimum: labels.length },
      controlSelector: "a.browse-tile.selected",
    });
  });
  attempt("web.search", () => {
    const chats = read("/api/search?q=performance");
    const resources = read("/api/resources/search?q=performance");
    assert.deepEqual(resources.failed ?? [], [], "Resource search returned partial results");
    const hit = resources.hits?.find((row) => row.snippet?.includes("QM performance"));
    const chat = chats.hits?.find((row) => row.surface === "web" && row.snippet?.trim());
    assert.ok(chat && hit, "Search needs both indexed web chat and resource fixture results");
    text("web.search", [chat.snippet, hit.title, hit.snippet], {
      query: "performance",
      rows: { selector: ".chat-search-row", minimum: 2 },
    });
  });
  const webPrincipal = fixture.cases?.short?.principalId;
  const webRead = (path) => {
    assert.ok(webPrincipal, "Web surface fixture has no principal");
    return read(path, webPrincipal);
  };
  const webList = (name, selector, items, expectedText, rowSelector, controlSelector) => {
    assert.ok(Array.isArray(items) && items.length > 0, `${name} needs populated API-observed fixture rows`);
    text(name, expectedText, {
      selector,
      rows: { selector: rowSelector, minimum: items.length },
      rowTexts: [{ selector: rowSelector, texts: [expectedText] }],
      controlSelector,
    });
  };
  attempt("web.contexts", () => {
    const items = webRead("/api/contexts").contexts.filter(
      (row) => row.kind === "personal" || row.project || row.sessionCount,
    );
    const row = items.find((item) => item.project?.name || (item.kind !== "personal" && item.name));
    assert.ok(row, "Projects needs an observed named project or active shared context");
    webList("web.contexts", ".contexts-pane", items, row.project?.name || row.name, ".context-row", ".context-row");
  });
  attempt("web.crons", () => {
    const items = webRead("/api/crons").crons.filter((row) => !row.archived);
    const enabled = items.filter((row) => row.enabled);
    const disabled = items.filter((row) => !row.enabled);
    assert.ok(disabled.length, "The safe cron fixture must have disabled owned rows");
    assert.ok(
      disabled.every((row) => row.title?.trim()),
      "Disabled cron rows need explicit observed titles",
    );
    const extra = {
      selector: ".crons-page",
      controlSelector: ".cron-disabled-toggle",
      rowTexts: [{ selector: ".cron-disabled-toggle", texts: ["Show disabled", String(disabled.length)] }],
      absentTexts: ["Loading crons…"],
    };
    if (enabled.length)
      webList("web.crons", ".crons-page", enabled, enabled[0].title, ".cron-row", 'input[aria-label="Search crons"]');
    else text("web.crons", ["Show disabled", String(disabled.length)], extra);
    webList("web.crons.disabled", ".crons-page", items, disabled[0].title, ".cron-row", ".cron-disabled-toggle");
  });
  attempt("web.webhooks", () => {
    const items = webRead("/api/webhooks").webhooks;
    const action = items[0]?.action?.trim().replace(/\s+/g, " ");
    assert.ok(action);
    webList(
      "web.webhooks",
      ".webhooks-page",
      items,
      action.length > 48 ? `${action.slice(0, 47)}…` : action,
      "a.list-row",
      'input[aria-label="Search webhooks"]',
    );
  });
  for (const feature of ["loops", "inbox"]) {
    if (output.browser.features) delete output.browser.features[feature];
    attempt(`web.${feature}`, () => {
      const me = webRead("/me");
      assert.equal(me.user, webPrincipal);
      assert.ok(Array.isArray(me.permissions), "Feature availability needs observed account permissions");
      const enabled = me.permissions.includes(feature);
      output.browser.features ??= {};
      output.browser.features[feature] = {
        enabled,
        mode: enabled ? "enabled" : "disabled",
        principalId: webPrincipal,
        evidence: `Observed /me permissions SHA-256 ${sha256(JSON.stringify(me.permissions))}`,
      };
      if (!enabled) return;
      if (feature === "loops") {
        const items = webRead("/api/loops").loops;
        webList("web.loops", ".loops-page", items, items[0]?.name, ".loop-row", ".loop-row");
      } else {
        const inboxWindow = (handled) => {
          const params = new URLSearchParams(handled ? { view: "handled" } : {});
          let page = webRead(`/api/inbox${params.size ? `?${params}` : ""}`);
          const items = [...page.items];
          const seen = new Set();
          while (page.nextCursor && items.length < 40) {
            assert.ok(!seen.has(page.nextCursor), "Inbox cursor did not advance");
            seen.add(page.nextCursor);
            params.set("cursor", page.nextCursor);
            page = webRead(`/api/inbox?${params}`);
            items.push(...page.items);
          }
          assert.equal(
            new Set(items.map((row) => row.id)).size,
            items.length,
            "Inbox window contains duplicate entries",
          );
          return { ...page, items };
        };
        const page = inboxWindow(false);
        inboxWindow(true);
        assert.equal(page.migrationPending, false, "Inbox fixture migration is not complete");
        const items = page.items.filter(
          (row) =>
            (row.state === "held" || (row.state === "failed" && row.parkedReason)) &&
            !row.sourcePayload?.probablyResolved &&
            !row.sourcePayload?.sentChat,
        );
        const row = items[0];
        webList(
          "web.inbox",
          ".inbox-page",
          items,
          row?.sourcePayload?.snippet || row?.parkedReason || row?.summary,
          ".inbox-item-row",
          ".inbox-item-row",
        );
      }
    });
  }
  attempt("web.files", () => {
    const page = webRead("/api/files?limit=60");
    const items = [...(page.owned ?? []), ...(page.shared ?? [])];
    webRead("/api/contexts");
    webList("web.files", ".files-page", items, items[0]?.name, ".file-row", 'input[aria-label="Search files"]');
  });
  attempt("web.keychain", () => {
    const items = webRead("/api/keychain/overview").credentials;
    webRead("/api/connectors");
    webList("web.keychain", ".keychain-page", items, items[0]?.service, ".kc-credential", ".list-page-action");
    views["web.keychain"].absentSelectors = [".kc-loading"];
  });
  attempt("web.deploys", () => {
    const items = webRead("/api/deployments").deployments.filter(
      (row) =>
        row.status !== "archived" &&
        (row.ownerScopeId === `personal:${webPrincipal}` ||
          (!row.ownerScopeId?.startsWith("personal:") && row.createdBy === webPrincipal)),
    );
    webRead("/api/contexts");
    webList(
      "web.deploys",
      ".deploys-page",
      items,
      items[0]?.displayName || items[0]?.name,
      ".deploy-row",
      'input[aria-label="Search apps"]',
    );
  });
  attempt("web.memory", () => {
    const content = webRead("/api/memory").content;
    assert.ok(typeof content === "string" && content.trim(), "Memory needs populated API-observed content");
    views["web.memory"] = {
      selector: ".pane:has(.memory-editor)",
      values: [{ selector: "textarea.memory-text", value: content }],
      editable: "textarea.memory-text",
      absentTexts: ["Loading…"],
    };
  });
  attempt("web.memory.facts", () => {
    const content = webRead("/api/memory").content;
    assert.ok(typeof content === "string");
    const facts = content.split("\n").flatMap((line) => {
      const match = line.match(/^\s*[-*]\s+(?:\((\d{4}-\d{2}-\d{2})\)\s*)?(.*\S)\s*$/);
      return match ? [match[2]] : [];
    });
    webList(
      "web.memory.facts",
      ".pane:has(.memory-editor)",
      facts,
      facts[0],
      ".memory-fact",
      'input[aria-label="Search memory"]',
    );
    views["web.memory.facts"].absentSelectors = ["textarea.memory-text"];
    views["web.memory.facts"].absentTexts = ["Loading…"];
  });
  attempt("web.skills", () => {
    const items = webRead("/api/skills?includeShadowed=1").skills.filter((row) => row.status !== "archived");
    webRead("/api/contexts");
    webList(
      "web.skills",
      ".skills-page",
      items,
      items[0]?.description,
      ".skill-variant",
      'input[aria-label="Search skills"]',
    );
  });
  output.browser.exclusions = [{ id: "web.calendar", reason: CALENDAR_EXCLUSION }];
  output.browser ??= {};
  output.browser.rootSidebarCases = {};
  delete output.browser.earlierPage;
  delete output.browser.mixedEarlierPage;
  for (const name of ["median", "p95", "max"])
    attempt(`web.root.${name}`, () => {
      const cohort = (fixture.cohorts ?? fixture.principalCohorts)[name];
      assert.equal(read("/me", cohort.principalId).user, cohort.principalId);
      const sessions = read("/api/sessions", cohort.principalId)
        .sessions.filter((row) => !row.parentSessionId && !row.archived && !row.pinned && row.surface === "web")
        .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
        .slice(0, 50);
      assert.ok(sessions.length, "Homepage fixture has no visible web conversations");
      const row = sessions.find((entry) => entry.id === cohort.rootCase?.sessionId) ?? sessions[0];
      output.browser.rootSidebarCases[name] = { sessionId: row.id, principalId: cohort.principalId };
    });
  for (const feature of ["loops", "inbox"])
    if (output.browser.features?.[feature]?.enabled === false) {
      const root = output.browser.rootSidebarCases.max;
      if (root?.principalId === webPrincipal)
        views[`web.${feature}`] = {
          selector: "body",
          expectedText: [],
          visible: `[data-session-id=${JSON.stringify(root.sessionId)}] a.session`,
          editable: ".custom-chat textarea",
          absentSelectors: [
            feature === "loops" ? ".loops-page" : ".inbox-page",
            `[data-view=${JSON.stringify(feature)}]`,
          ],
        };
      else
        gaps.push({
          scenario: `web.${feature}`,
          reason: "Disabled route needs an observed authenticated fallback homepage",
        });
    }
  attempt("web.chat.earlier", () => {
    const session = fixture.cases.long;
    const initial = read(`/api/sessions/${session.sessionId}?tailTurns=25`, session.principalId);
    assert.equal(initial.session.id, session.sessionId);
    assert.ok(initial.entries.length && initial.earlierEntries > 0, "Long fixture has no previous transcript page");
    const initialFirstSeq = initial.entries[0].seq;
    const previous = read(
      `/api/sessions/${session.sessionId}?beforeSeq=${initialFirstSeq}&tailTurns=25`,
      session.principalId,
    );
    assert.equal(previous.session.id, session.sessionId);
    assert.ok(previous.entries.length && previous.entries.every((entry) => entry.seq < initialFirstSeq));
    const row = previous.entries.findLast((entry) => entry.type === "user" && entry.payload?.text?.trim());
    assert.ok(row, "Previous page needs a visible user message with its entry identity");
    const expectedVisibleText = row.payload.text.split("\n")[0].trim().slice(0, 120);
    assert.ok(expectedVisibleText.length >= 8, "Previous-page text is too short for a content assertion");
    output.browser.earlierPage = {
      sessionId: session.sessionId,
      initialFirstSeq,
      firstSeq: previous.entries[0].seq,
      lastSeq: previous.entries.at(-1).seq,
      entrySeq: row.seq,
      expectedVisibleText,
    };
  });
  attempt("web.chat.mixed-earlier", () => {
    const session = fixture.cases.mixed;
    const boundary = session.transcriptBoundarySeq;
    assert.ok(
      Number.isSafeInteger(boundary) && boundary > 0 && boundary < session.messageCount,
      "Mixed fixture must declare its actual canonical-prefix boundary",
    );
    let page = read(`/api/sessions/${session.sessionId}?tailTurns=25`, session.principalId);
    assert.equal(page.session.id, session.sessionId);
    const initialFirstSeq = page.entries[0]?.seq;
    assert.ok(
      initialFirstSeq >= boundary && page.earlierEntries > 0,
      "Mixed initial page must be entirely after the canonical boundary",
    );
    const preparePages = [];
    for (let count = 0; count < 100; count++) {
      const before = page.entries[0].seq;
      const previous = read(`/api/sessions/${session.sessionId}?beforeSeq=${before}&tailTurns=25`, session.principalId);
      assert.equal(previous.session.id, session.sessionId);
      assert.ok(
        previous.entries.length && previous.entries.every((entry) => entry.seq < before),
        "Earlier mixed page did not advance",
      );
      const visible = previous.entries.filter((entry) => entry.type === "user" && entry.payload?.text?.trim());
      const ready = (entry) => {
        assert.ok(entry, "Boundary page needs a visible user entry from each storage cohort");
        const expected = entry.payload.text.split("\n")[0].trim().slice(0, 120);
        assert.ok(expected.length >= 8, "Mixed boundary text is too short");
        return { root: `.custom-chat [data-entry-seqs~=${JSON.stringify(String(entry.seq))}]`, texts: [expected] };
      };
      if (previous.entries[0].seq < boundary) {
        assert.ok(previous.entries.at(-1).seq >= boundary, "The measured earlier page must span both stores");
        const canonical = visible.findLast((entry) => entry.seq < boundary);
        const legacy = visible.find((entry) => entry.seq >= boundary);
        const canonicalReady = ready(canonical);
        output.browser.mixedEarlierPage = {
          sessionId: session.sessionId,
          initialFirstSeq,
          boundarySeq: boundary,
          firstSeq: previous.entries[0].seq,
          lastSeq: previous.entries.at(-1).seq,
          entrySeq: canonical.seq,
          expectedVisibleText: canonicalReady.texts[0],
          preparePages,
          boundaryReady: [ready(legacy)],
        };
        return;
      }
      preparePages.push(ready(visible.at(-1)));
      assert.ok(previous.earlierEntries > 0, "Mixed pagination ended before its boundary");
      page = previous;
    }
    throw new Error("Mixed boundary needs more than 100 preparation pages");
  });
  attempt("sidebarPagination", () => {
    const sessions = read("/api/sessions")
      .sessions.filter((row) => !row.parentSessionId && !row.archived && !row.pinned && row.surface === "web")
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
    assert.ok(sessions.length > 50, "Sidebar fixture has fewer than two pages of visible web conversations");
    const declared = fixture.sidebarPagination;
    if (declared) {
      assert.equal(declared.principalId, admin);
      assert.ok(
        sessions.findIndex((row) => row.id === declared.sessionId) >= 50,
        "Declared sidebar case is not beyond the first visible page",
      );
      output.sidebarPagination = structuredClone(declared);
    } else output.sidebarPagination = { principalId: admin, sessionId: sessions[50].id };
  });
  output.viewReadinessEvidence = {
    fixtureId: fixture.fixtureId,
    observedAt: observations.at,
    evidence,
    gaps,
    normalizations,
  };
  output.viewReadinessEvidence.missing = buildCatalog(output)
    .filter((scenario) => scenario.missing.length)
    .map((scenario) => ({ id: scenario.id, missing: scenario.missing }));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixturePath, observationsPath, outputPath] = process.argv.slice(2);
  assert.ok(fixturePath && observationsPath && outputPath, "Usage: fixture-views.mjs FIXTURE OBSERVATIONS OUTPUT");
  assert.notEqual(resolve(fixturePath), resolve(outputPath), "Preserve the original fixture manifest");
  const output = deriveViewFixtures(
    JSON.parse(readFileSync(fixturePath, "utf8")),
    JSON.parse(readFileSync(observationsPath, "utf8")),
  );
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify(
      {
        outputPath,
        views: Object.keys(output.views).length,
        missing: output.viewReadinessEvidence.missing,
        gaps: output.viewReadinessEvidence.gaps,
      },
      null,
      2,
    ),
  );
}
