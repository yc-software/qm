import { litFixture } from "./lit-fixture.ts";
import { renderDesign } from "./design-source.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function routerAt(pathname: string, search = "", base = "/admin") {
  const grab = (name: string): string => {
    const source = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {6}\\}`))?.[0];
    assert.ok(source, `${name} helper exists`);
    return source!;
  };
  const factory = new Function(
    "API_BASE",
    "SCOPED",
    "VIEWS",
    "DEFAULT_VIEW",
    "scopeKind",
    "location",
    "scope",
    "orgId",
    `${grab("decodePathSegment")};
     ${grab("stateToUrl")};
     ${grab("urlToState")};
     return { stateToUrl, urlToState };`,
  );
  return factory(
    base,
    new Function(`${html.match(/const SCOPED = new Set\(\[[\s\S]*?\]\);/)?.[0]}; return SCOPED;`)(),
    [
      "connectors",
      "slack-settings",
      "history",
      "files",
      "memory",
      "live",
      "audit",
      "errors",
      "skills",
      "crons",
      "deployments",
      "slack",
      "judgments",
      "user",
    ],
    "history",
    (scopeId: string) => String(scopeId || "").split(":")[0] || "scope",
    { pathname, search },
    "channel:LAST-VIEWED",
    "acme",
  ) as {
    stateToUrl: (st: Record<string, unknown>) => string;
    urlToState: () => {
      view: string;
      setup: string | null;
      scope: string;
      session: string | null;
      historyKind: string;
      cron: string | null;
      turn: string | null;
      page: number;
    };
  };
}

const SCOPE = "personal:alice@example.com";
const SCOPE_ENC = encodeURIComponent(SCOPE);

test("session deep links are paths, not ?session= query params", () => {
  const { stateToUrl } = routerAt("/admin/history");
  assert.equal(stateToUrl({ view: "history", scope: SCOPE, session: "sess-1" }), "/admin/history/s/sess-1");
  assert.equal(
    stateToUrl({ view: "history", scope: SCOPE, session: "sess-1", turn: 4 }),
    "/admin/history/s/sess-1?turn=4",
  );
  assert.doesNotMatch(html, /p\.set\("session", st\.session\)/);
});

test("scoped history addresses the scope as a path segment; kind stays a query param", () => {
  const { stateToUrl } = routerAt("/admin/history");
  assert.equal(
    stateToUrl({ view: "history", scope: SCOPE, session: null, historyKind: "cron" }),
    `/admin/history/scopes/${SCOPE_ENC}?kind=cron`,
  );
  assert.equal(
    stateToUrl({ view: "history", scope: SCOPE, session: null, historyKind: "cron", cron: "c1", page: 2 }),
    `/admin/history/scopes/${SCOPE_ENC}?cron=c1&kind=cron&page=2`,
  );
  assert.equal(stateToUrl({ view: "history", scope: "org:acme", session: null }), "/admin/history");
});

test("non-history views keep their query-param scope", () => {
  const { stateToUrl } = routerAt("/admin/files");
  assert.equal(stateToUrl({ view: "files", scope: SCOPE }), `/admin/files?scope=${SCOPE_ENC}`);
});

test("canonical history paths parse back to the same state", () => {
  const session = routerAt("/admin/history/s/sess-1", "?turn=4").urlToState();
  assert.equal(session.view, "history");
  assert.equal(session.session, "sess-1");
  assert.equal(session.turn, "4");

  const scoped = routerAt(`/admin/history/scopes/${SCOPE_ENC}`, "?kind=cron&cron=c1").urlToState();
  assert.equal(scoped.view, "history");
  assert.equal(scoped.scope, SCOPE);
  assert.equal(scoped.historyKind, "cron");
  assert.equal(scoped.cron, "c1");
  assert.equal(scoped.session, null);
});

test("legacy query-param links parse and canonicalize to the path form", () => {
  const router = routerAt("/admin/history", `?scope=${SCOPE_ENC}&session=sess-1`);
  const st = router.urlToState();
  assert.equal(st.session, "sess-1");
  assert.equal(st.scope, SCOPE);
  assert.equal(router.stateToUrl(st), "/admin/history/s/sess-1");

  const listRouter = routerAt("/admin/history", `?scope=${SCOPE_ENC}&kind=cron`);
  const list = listRouter.urlToState();
  assert.equal(listRouter.stateToUrl(list), `/admin/history/scopes/${SCOPE_ENC}?kind=cron`);
});

test("a mangled ?scopecom link still lands on the session and canonicalizes", () => {
  const router = routerAt("/admin/history", "?scopecom&session=sess-1");
  const st = router.urlToState();
  assert.equal(st.view, "history");
  assert.equal(st.session, "sess-1");
  assert.equal(st.scope, "org:acme");
  assert.equal(router.stateToUrl(st), "/admin/history/s/sess-1");
});

test("session deep-link entries synthesize a list back-stop and repair it from the session's own scope", () => {
  assert.match(html, /history\.pushState\(\{ \.\.\.st, deepLink: true \}, "", stateToUrl\(st\)\);/);
  assert.match(html, /governanceUI.transcript.show/);
});

test("a scope whose encoding the portal would reject stays in the query form", () => {
  const slashScope = "personal:a/b@example.com";
  const router = routerAt("/admin/history");
  const url = router.stateToUrl({ view: "history", scope: slashScope, session: null, historyKind: "cron" });
  assert.equal(url, `/admin/history?scope=${encodeURIComponent(slashScope)}&kind=cron`);
  const parsed = routerAt("/admin/history", `?scope=${encodeURIComponent(slashScope)}&kind=cron`).urlToState();
  assert.equal(parsed.scope, slashScope);
  assert.equal(parsed.historyKind, "cron");
});

test("an undecodable scope segment falls back instead of throwing", () => {
  const st = routerAt("/admin/history/scopes/%E0%A4%A").urlToState();
  assert.equal(st.view, "history");
  assert.equal(st.scope, "org:acme");
});

test("cron fire rows surface the result digest and retain silent styling", () => {
  const f = litFixture();
  f.ui.history.history(
    f.root,
    {
      sessions: [
        { id: "fire1", category: "background", result: "Digest result", lastMessage: "Tool chatter", delivered: 0 },
      ],
      total: 1,
    },
    {
      historyKind: "cron",
      cron: "job1",
      scope: "org:acme",
      orgScope: "org:acme",
      environments: [],
      historyKindMatches: () => true,
      pageSize: 50,
      correctPage() {},
      historyModeLabel: () => "Crons",
      kindLabels: { conversation: "Conversations", cron: "Crons" },
      pageShell() {},
      cronName: () => "Job",
      scopeKind: () => "org",
      plural: String,
      stateToUrl: () => "/session/fire1",
      go() {},
    },
  );
  assert.equal(f.root.querySelector(".dense-name")!.textContent, "Digest result");
  assert.equal(f.root.querySelector(".dense-preview")!.textContent, "Tool chatter");
  assert.ok(f.root.querySelector(".history-silent"));
  f.dom.window.close();
});

test("a bare history URL is the org scope, not whatever scope was viewed last", () => {
  const st = routerAt("/admin/history", "?kind=cron").urlToState();
  assert.equal(st.scope, "org:acme");
  const files = routerAt("/admin/files").urlToState();
  assert.equal(files.scope, "channel:LAST-VIEWED");
});

test("Errors opens org-wide and preserves explicit scope deep links", () => {
  const router = routerAt("/admin/errors");
  assert.equal(router.urlToState().view, "errors");
  assert.equal(router.urlToState().scope, "org:acme");
  assert.equal(router.stateToUrl({ view: "errors", scope: SCOPE }), `/admin/errors?scope=${SCOPE_ENC}`);
  assert.equal(routerAt("/admin/errors", `?scope=${SCOPE_ENC}`).urlToState().scope, SCOPE);
});

test("Errors pagination round-trips arbitrary pages without losing scope", () => {
  const router = routerAt("/admin/errors", `?scope=${SCOPE_ENC}&page=37`);
  assert.equal(router.urlToState().page, 37);
  assert.equal(
    router.stateToUrl({ view: "errors", scope: SCOPE, page: 37 }),
    `/admin/errors?scope=${SCOPE_ENC}&page=37`,
  );
});

test("Slack setup links select Slack settings and preserve the guide through canonical routing", () => {
  for (const pathname of ["/admin", "/admin/", "/admin/connectors"]) {
    const { stateToUrl, urlToState } = routerAt(pathname, "?setup=slack");
    const state = urlToState();
    assert.equal(state.view, "slack-settings");
    assert.equal(state.setup, "slack");
    assert.equal(stateToUrl(state), "/admin/slack-settings?setup=slack");
  }
  const { stateToUrl } = routerAt("/admin/connectors", "?setup=slack");
  assert.equal(stateToUrl({ view: "connectors" }), "/admin/connectors");
  assert.equal(stateToUrl({ view: "files", setup: "slack" }), "/admin/files");
});

test("navigation drops retired design parameters while retaining route state", () => {
  const { stateToUrl } = routerAt("/admin/history", "?variant=original");
  assert.equal(
    stateToUrl({ view: "history", scope: SCOPE, session: "sess-1", turn: 4 }),
    "/admin/history/s/sess-1?turn=4",
  );
  assert.equal(stateToUrl({ view: "files", scope: SCOPE }), `/admin/files?scope=${SCOPE_ENC}`);
});

for (const base of ["", "/admin", "/control"]) {
  test(`catalog live links use the configured base (${base || "root"})`, () => {
    const { stateToUrl } = routerAt(`${base}/design-system`, "", base);
    const dom = renderDesign(stateToUrl, SCOPE);
    const links = [...dom.window.document.querySelectorAll<HTMLAnchorElement>(".design-page-links a")];
    assert.deepEqual(
      links.map((link) => link.dataset.designView),
      ["governance", "skills", "files", "history", "audit", "egress"],
    );
    assert.deepEqual(
      links.map((link) => link.getAttribute("href")),
      [
        `${base}/governance?scope=${SCOPE_ENC}`,
        `${base}/skills?scope=${SCOPE_ENC}`,
        `${base}/files?scope=${SCOPE_ENC}`,
        `${base}/history/scopes/${SCOPE_ENC}`,
        `${base}/audit?scope=${SCOPE_ENC}`,
        `${base}/egress?scope=${SCOPE_ENC}`,
      ],
    );
    dom.window.close();
  });
}
