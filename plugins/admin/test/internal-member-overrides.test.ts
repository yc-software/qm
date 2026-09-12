import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; body: string; actor: string | null; signed: boolean }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      body,
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
    });
    const denied = req.headers["x-admin-actor"] === "U-member@acme";
    res.writeHead(denied ? 403 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(denied ? { error: "admin_required" } : { ok: true }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-overrides-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  core.close();
});

test("the org page ships an Internal member overrides card wired to the save machinery", () => {
  const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(shell, /id="card-internal-member-overrides"/, "card exists");
  assert.match(shell, /<textarea[^>]*id="internal-member-overrides"/, "one-per-line textarea");
  assert.match(shell, /data-save="internal-member-overrides"/, "save button keyed to the core resource id");
  assert.match(shell, /"internalMemberOverrides" in r\.data/, "shown only when the org scope carries the key");
  assert.match(shell, /"internal-member-overrides": "st-internal-member-overrides"/, "status target registered");
  assert.match(shell, /key === "internal-member-overrides"/, "changes go through the governance review dialog");
});

test("PUT /api/scopes/org:acme/internal-member-overrides forwards the members body to core", async () => {
  const r = await fetch(`${base}/api/scopes/${encodeURIComponent("org:acme")}/internal-member-overrides`, {
    method: "PUT",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ members: ["contractor@example.com", "U123ABC"] }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
  assert.equal(c.method, "PUT");
  assert.equal(c.url, "/v1/admin/scopes/org%3Aacme/internal-member-overrides");
  assert.deepEqual(JSON.parse(c.body), { members: ["contractor@example.com", "U123ABC"] });
});

const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function slice(from: string, to: string) {
  const start = shell.indexOf(from);
  const end = shell.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return shell.slice(start, end);
}

test("signed-out writes never reach core; core admin denials are preserved", async () => {
  const url = `${base}/api/scopes/org%3Aacme/internal-member-overrides`;
  const count = calls.length;
  const signedOut = await fetch(url, { method: "PUT", body: JSON.stringify({ members: [] }) });
  assert.equal(signedOut.status, 401);
  assert.equal(calls.length, count);
  const denied = await fetch(url, {
    method: "PUT",
    headers: { cookie: "admin=U-member", "content-type": "application/json" },
    body: JSON.stringify({ members: [] }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "admin_required" });
});

test("the proxy supports clearing the entire override list", async () => {
  const response = await fetch(`${base}/api/scopes/org%3Aacme/internal-member-overrides`, {
    method: "PUT",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ members: [] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1)!.body), { members: [] });
});

test("editor is visible only for org payloads that support overrides", () => {
  for (const [scope, data, hidden, value, count] of [
    ["org:acme", { internalMemberOverrides: [] }, false, "", "No overrides configured."],
    ["org:acme", { internalMemberOverrides: ["u123abc"] }, false, "u123abc", "1 override"],
    [
      "org:acme",
      { internalMemberOverrides: ["u123abc", "colleague@example.com"] },
      false,
      "u123abc\ncolleague@example.com",
      "2 overrides",
    ],
    ["org:acme", {}, true, "", ""],
    ["personal:demo", { internalMemberOverrides: ["u123abc"] }, true, "", ""],
    ["channel:test", { internalMemberOverrides: [] }, true, "", ""],
  ] as const) {
    let actualHidden: boolean | undefined;
    const input = { value: "" };
    const label = { textContent: "" };
    vm.runInNewContext(slice("        const showInternalOverrides =", "        const showOrgAmbient ="), {
      scope,
      r: { data },
      $: (id: string) => {
        if (id === "internal-member-overrides") return input;
        if (id.endsWith("-count")) return label;
        return {
          classList: {
            toggle: (_name: string, on: boolean) => {
              actualHidden = on;
            },
          },
        };
      },
    });
    assert.equal(actualHidden, hidden);
    assert.equal(input.value, value);
    assert.equal(label.textContent, count);
  }
});

test("collector trims, lowercases, deduplicates and supports clearing", () => {
  const collector = slice('        "internal-member-overrides": () =>', '        "org-ambient": () =>');
  for (const [value, expected] of [
    [" Contractor@Example.com , U123ABC\r\ncontractor@example.com\n", ["contractor@example.com", "u123abc"]],
    ["  ,\n ", []],
  ] as const) {
    const body = vm.runInNewContext(`({${collector}})["internal-member-overrides"]()`, { $: () => ({ value }) });
    assert.deepEqual(JSON.parse(JSON.stringify(body)), { members: expected });
  }
});

test("confirmation shows added/removed members, unique total, and returns the user's decision", async () => {
  const review = slice("      function governanceSaveReview(", "      function renderSharingPosture(");
  for (const accepted of [false, true]) {
    let shown: { facts: [string, string][]; warning: string; danger: boolean } | undefined;
    const result = await vm.runInNewContext(
      review + '\ngovernanceSaveReview("internal-member-overrides", {members:["NEW@example.com", "new@example.com"]})',
      {
        sectionSnapshots: new Map([["internal-member-overrides", JSON.stringify({ members: ["old@example.com"] })]]),
        governanceScopeName: () => "Acme",
        reviewGovernanceChange: (options: typeof shown) => {
          shown = options;
          return Promise.resolve(accepted);
        },
      },
    );
    assert.equal(result, accepted);
    assert.ok(shown);
    assert.deepEqual(JSON.parse(JSON.stringify(shown.facts)), [
      ["Scope", "Acme"],
      ["Adding", "new@example.com"],
      ["Removing", "old@example.com"],
      ["Total after", "1"],
    ]);
    assert.equal(shown.danger, true);
    assert.match(shown.warning, /internal-member access/);
  }
});

test("clearing reviews removals, while a normalized unchanged list needs no review", async () => {
  const review = slice("      function governanceSaveReview(", "      function renderSharingPosture(");
  let reviews = 0;
  const context = vm.createContext({
    sectionSnapshots: new Map([["internal-member-overrides", JSON.stringify({ members: ["colleague@example.com"] })]]),
    governanceScopeName: () => "Acme",
    reviewGovernanceChange: (options: { danger: boolean; facts: [string, string][] }) => {
      reviews++;
      assert.equal(options.danger, false);
      assert.equal(options.facts.find(([key]) => key === "Total after")?.[1], "0");
      return Promise.resolve(true);
    },
  });
  vm.runInContext(review, context);
  assert.equal(
    await vm.runInContext(
      'governanceSaveReview("internal-member-overrides", {members:[" COLLEAGUE@example.com "]})',
      context,
    ),
    true,
  );
  assert.equal(reviews, 0);
  assert.equal(await vm.runInContext('governanceSaveReview("internal-member-overrides", {members:[]})', context), true);
  assert.equal(reviews, 1);
});
