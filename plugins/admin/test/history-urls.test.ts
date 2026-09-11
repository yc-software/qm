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
    new Set(["history", "files", "memory", "live", "audit", "errors", "skills", "crons", "deployments"]),
    [
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
  assert.match(
    html,
    /if \(history\.state\?\.deepLink\)\s*go\(\{ view: "history", scope: sessionScope \|\| scope, session: null, historyKind \}\);\s*else history\.back\(\);/,
  );
  assert.match(html, /onClick: backToList\(session\.scopeId\)/);
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

test("cron fire rows surface the fire's result digest and keep the silent styling", () => {
  assert.match(html, /\} else if \(isBackground && s\.result\) \{\s*name = s\.result;/);
  assert.match(html, /previewText = s\.result \|\| s\.lastMessage \|\| s\.firstMessage \|\| "";/);
  assert.match(html, /s\.result \|\| "\(no messages\)"/);
  assert.match(html, /isBackground && typeof s\.delivered === "number" && !s\.delivered \? "history-silent" : ""/);
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
