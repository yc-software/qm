import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, tabText } from "./fixture.ts";

const SCOPE = "personal:alice@example.com";
const scopes = { scopes: [{ scopeId: "org:acme" }, { scopeId: "channel:C1", label: "#eng" }, { scopeId: SCOPE }] };

test("the org-wide landing lists newest sessions with scope tags, a scope filter and snapshot tab counts", async () => {
  const page = await mountPage("/settings/history", {
    "/scopes": scopes,
    "/sessions": {
      sessions: [
        { id: "s1", category: "conversation", scopeId: "channel:C1", firstMessage: "hello", lastMessage: "bye" },
      ],
      counts: { conversation: 12, cron: 3400, background: 7 },
    },
  });
  await page.settle();
  const list = page.requests.find((r) => r.path === "/sessions")!.url.searchParams;
  assert.deepEqual(
    [...list],
    [
      ["scope", "org:acme"],
      ["limit", "50"],
      ["category", "conversation"],
    ],
  );
  const doc = page.document;
  assert.equal(doc.querySelector(".pane-title"), null);
  assert.deepEqual(
    [...doc.querySelectorAll(".resource-tabs a")].map((a) => [tabText(a), a.getAttribute("href")]),
    [
      ["Conversations 12", "/settings/history"],
      ["Cron runs 3,400", "/settings/history?kind=cron"],
      ["Background 7", "/settings/history?kind=background"],
    ],
  );
  assert.equal(doc.querySelector(".dense-tag")!.textContent, "#eng");
  assert.equal(doc.querySelector(".dense-name")!.textContent, "hello");
  assert.equal(doc.querySelector<HTMLAnchorElement>(".dense-row")!.getAttribute("href"), "/settings/history/s/s1");
  assert.equal(doc.querySelector(".pager"), null);
  const select = doc.querySelector("select")!;
  assert.deepEqual(
    [...select.options].map((o) => o.textContent!.trim()),
    ["All scopes", "#eng", "Alice"],
  );
  select.value = SCOPE;
  select.dispatchEvent(new page.window.Event("change"));
  await page.settle();
  assert.equal(page.location(), "/settings/history?scope=" + encodeURIComponent(SCOPE));
  assert.equal(
    page.requests
      .filter((r) => r.path === "/sessions")
      .at(-1)!
      .url.searchParams.get("scope"),
    SCOPE,
  );
  assert.equal(page.requests.filter((r) => r.path === "/scopes").length, 1);
  page.close();
});

test("cron drill-downs and pages keep scope, kind, cron and cursor", async () => {
  const page = await mountPage(`/settings/history/scopes/${encodeURIComponent(SCOPE)}?kind=cron&cron=c1&cursor=17~s9`, {
    "/scopes": scopes,
    "/sessions": {
      sessions: [
        {
          id: "f1",
          category: "background",
          origin: { kind: "cron", cron: { title: "Digest" } },
          result: "Done",
          lastMessage: "chatter",
        },
      ],
      nextCursor: "9~s2",
    },
  });
  await page.settle();
  const list = page.requests.find((r) => r.path === "/sessions")!.url.searchParams;
  assert.equal(list.get("scope"), SCOPE);
  assert.equal(list.get("category"), "background");
  assert.equal(list.get("origin"), "cron");
  assert.equal(list.get("cron"), "c1");
  assert.equal(list.get("cursor"), "17~s9");
  const doc = page.document;
  assert.equal(doc.querySelector(".pane-title")!.textContent, "Digest");
  assert.equal(doc.querySelector(".dense-name")!.textContent, "Done");
  assert.equal(doc.querySelector(".dense-preview")!.textContent, "chatter");
  const [newest, older] = [...doc.querySelectorAll<HTMLButtonElement>(".pager .page")];
  assert.equal(newest!.disabled, false);
  older!.click();
  await page.settle();
  assert.equal(page.location(), `/settings/history?scope=${encodeURIComponent(SCOPE)}&kind=cron&cron=c1&cursor=9%7Es2`);
  assert.equal(
    page.requests
      .filter((r) => r.path === "/sessions")
      .at(-1)!
      .url.searchParams.get("cursor"),
    "9~s2",
  );
  page.close();
});

test("a session opens its transcript with paired tools, deliveries and session errors", async () => {
  const page = await mountPage("/settings/history?session=sess-1", {
    "/scopes": scopes,
    "/sessions/sess-1": {
      session: { scopeId: "channel:C1", createdAt: Date.now() },
      hasMore: true,
      entries: [
        { seq: 1, type: "user", payload: { text: "hello", name: "Alice" }, createdAt: 1 },
        { seq: 2, type: "tool_call", payload: { tool: "execute", callId: "a", command: "ls" }, createdAt: 2 },
        { seq: 3, type: "tool_result", payload: { callId: "a", stdout: "x" }, createdAt: 3 },
        { seq: 4, type: "assistant", payload: "reply", createdAt: 5 },
      ],
      deliveryEvents: [
        { type: "outbound_delivery", destination: { type: "slack", target: "C1" }, text: "reply", createdAt: 4 },
      ],
    },
    "/errors": { errors: [{ message: "boom\nstack", category: "tool", ts: Date.now() }] },
  });
  await page.settle();
  const request = page.requests.find((r) => r.path === "/sessions/sess-1")!.url.searchParams;
  assert.equal(request.get("scope"), "org:acme");
  assert.equal(request.get("limit"), "500");
  assert.equal(page.requests.find((r) => r.path === "/errors")!.url.searchParams.get("sessionId"), "sess-1");
  const doc = page.document;
  assert.deepEqual(
    [...doc.querySelectorAll(".transcript-stream > .entry .entry-label")].map((e) => e.textContent),
    ["Alice", "execute", "Slack delivery", "Assistant"],
  );
  assert.equal(doc.querySelectorAll(".tool-entry pre").length, 2);
  assert.match(doc.querySelector(".error-strip")!.textContent!, /1 error logged in this session[\s\S]*boom/);
  assert.equal(doc.querySelector(".load-earlier")!.getAttribute("href"), "/settings/history/s/sess-1?limit=2000");
  assert.equal(doc.querySelector(".pane-subtitle")!.textContent!.startsWith("#eng"), true);
  page.close();
});
