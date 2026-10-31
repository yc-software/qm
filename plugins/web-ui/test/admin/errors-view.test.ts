import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

const scopes = { scopes: [{ scopeId: "personal:alice", label: "Alice" }] };

test("errors escape diagnostics, link scopes and sessions, and page through offsets", async () => {
  const message = "<img src=x onerror=alert(1)>\nfull diagnostic";
  const f = await mountPage("/settings/errors", {
    "/scopes": scopes,
    "/errors": ({ url }) => ({
      errors: [{ ts: 1, category: "turn", code: "failed", message, scopeLabel: "personal:alice", sessionId: "s1" }],
      total: 120,
      limit: 50,
      offset: Number(url.searchParams.get("offset")),
    }),
  });
  await f.settle();
  assert.equal(f.host.querySelector("tbody img"), null);
  assert.equal(f.host.querySelector(".error-full")!.textContent, message);
  assert.deepEqual(
    [...f.host.querySelectorAll("th")].map((e) => e.textContent),
    ["Category", "Code", "Message", "Scope", "Session", "Time"],
  );
  const links = [...f.host.querySelectorAll<HTMLAnchorElement>("tbody a")].map((a) => a.getAttribute("href"));
  assert.deepEqual(links, [
    "/settings/errors?scope=personal%3Aalice",
    "/settings/history?scope=personal%3Aalice&session=s1",
  ]);
  assert.equal(f.host.querySelector("tbody a")!.textContent, "Alice");
  f.host.querySelectorAll<HTMLButtonElement>(".pager .page")[1]!.click();
  await f.settle();
  assert.equal(f.requests.at(-1)!.url.search, "?scope=org%3Aacme&limit=50&offset=50");
  f.close();
});

test("scoped errors hide the scope column and audit and egress render their rows", async () => {
  const f = await mountPage("/settings/errors?scope=personal:alice", {
    "/scopes": scopes,
    "/errors": { errors: [] },
    "/audit": { events: [{ principalId: "admin", action: "delete", resource: "skill", ts: 1 }] },
    "/egress": {
      records: [{ host: "example.com", allowed: false, source: "broker", slug: "gh" }],
      total: 1,
      denied: 1,
    },
  });
  await f.settle();
  assert.equal(f.host.querySelector(".empty")!.textContent, "No errors recorded for this scope.");
  assert.equal(f.host.querySelector<HTMLSelectElement>("select")!.value, "personal:alice");
  f.window.history.pushState(null, "", "/settings/audit");
  await f.mount();
  await f.settle();
  assert.equal(f.host.querySelector(".flag-err")!.textContent, "delete");
  f.window.history.pushState(null, "", "/settings/egress");
  await f.mount();
  await f.settle();
  assert.match(f.host.querySelector(".pane-subtitle")!.textContent!, /1 call · 1 denied request/);
  assert.ok(f.host.textContent!.includes("cred:gh"));
  f.close();
});
