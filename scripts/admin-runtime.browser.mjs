import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const html = readFileSync(new URL("../plugins/admin/public/index.html", import.meta.url), "utf8").replaceAll(
  "__ADMIN_BASE__",
  "",
);
const targets = ["channel:C1", "group:web-project-fixture", "personal:alice", "team:T1"];
const model = (id, available = true) => ({ id, name: id, available });
const initial = { harnessId: "pi", modelId: "alpha", effortLevel: "high", fastMode: true };
const rows = new Map();
const writes = [];
let unavailable = false;
let approved = ["pi", "codex"];
let manifest = { id: "runtime", target: "any", clearable: true };
function config(scope) {
  const runtime = rows.has(scope) ? rows.get(scope) : initial;
  return {
    scopeId: scope,
    runtime,
    baseModel: runtime?.modelId ?? null,
    harnessDefault: "pi",
    baseModelDefault: "alpha",
    harnessOptions: ["pi", "codex"],
    approvedHarnesses: approved,
    baseModelOptions: [model("alpha", !unavailable), model("beta")],
    modelsByHarness: { pi: [model("alpha", !unavailable), model("beta")], codex: [model("gpt-fixture")] },
    thinkingLevelsByHarness: { pi: ["auto", "low", "high"], codex: ["auto", "low", "high"] },
    fastModeHarnessIds: ["pi"],
    fastModeModelIds: ["alpha"],
    serviceCredentials: [],
    soul: "",
    webuiModels: [],
  };
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const json = (data, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (path === "/api/me") return json({ org: "acme", principal: "synthetic-admin", isAdmin: true });
  if (path === "/api/scopes")
    return json({ scopes: targets.map((scopeId) => ({ scopeId, label: scopeId, sessions: 1 })), environments: [] });
  if (path === "/api/resources") return json({ resources: [manifest] });
  if (path.startsWith("/api/scopes/")) {
    const [, scope, resource] = path.match(/^\/api\/scopes\/([^/]+)(?:\/(.+))?$/);
    const target = decodeURIComponent(scope);
    if (req.method === "PUT") {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const value = JSON.parse(body);
      writes.push({ target, resource, body: value });
      rows.set(target, value.inherit ? null : value);
      return json({ ok: true });
    }
    return json(config(target));
  }
  if (path.startsWith("/api/")) return json({ sessions: [], total: 0, errors: [], providers: [] });
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
test.after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

async function ready(page) {
  await page.locator("#app-view:not(.hidden)").waitFor();
  await page.locator("#st-runtime").filter({ hasNotText: "Loading" }).waitFor({ state: "attached" });
}
async function runtimeVisible(page, target) {
  await page.locator("#card-base-model").waitFor({ state: "visible", timeout: 2000 });
  assert.ok((await page.locator("#base-runtime-target").textContent()).includes(target));
  assert.equal(new URL(page.url()).searchParams.get("scope"), target);
}
async function pick(page, id, label) {
  const dropdown = page.locator(`#${id} + .dd`);
  await dropdown.locator(".dd-btn").click();
  await dropdown.getByRole("option", { name: label, exact: true }).click();
}
async function save(page) {
  await page.locator('[data-save="runtime"]').click();
  await page.locator("#st-runtime").filter({ hasText: "Saved" }).waitFor();
}
for (const target of targets) {
  test(`real router, refresh/history and runtime PUT for ${target}`, async () => {
    rows.clear();
    approved = ["pi", "codex"];
    unavailable = false;
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(base + "/history");
      await page.getByRole("link", { name: target, exact: false }).first().click();
      await page.locator("#tabs").getByRole("button", { name: "Governance", exact: true }).click();
      await ready(page);
      await runtimeVisible(page, target);
      assert.ok((await page.locator("#shellbar").textContent()).includes(target));
      await page.reload();
      await ready(page);
      await runtimeVisible(page, target);
      assert.equal(await page.locator(".card.dirty").count(), 0);
      await page.locator("#tabs").getByRole("button", { name: "Models", exact: true }).click();
      await page.waitForURL("**/models");
      await ready(page);
      assert.equal(await page.locator("#card-base-model").isVisible(), false);
      await page.goBack();
      await ready(page);
      await runtimeVisible(page, target);
      await page.goForward();
      await ready(page);
      assert.equal(new URL(page.url()).pathname, "/models");
      assert.equal(await page.locator("#card-base-model").isVisible(), false);
      await page.goBack();
      await ready(page);
      await runtimeVisible(page, target);
      const before = writes.length;
      await pick(page, "base-model", "beta (beta)");
      await pick(page, "base-effort", "Low");
      await save(page);
      assert.deepEqual(writes.slice(before), [
        {
          target,
          resource: "runtime",
          body: { harnessId: "pi", modelId: "beta", effortLevel: "low", fastMode: false },
        },
      ]);
      await page.reload();
      await ready(page);
      await runtimeVisible(page, target);
      assert.equal(await page.locator("#base-model").inputValue(), "beta");
      assert.equal(await page.locator("#base-effort").inputValue(), "low");
      await page.locator("#base-inherit-control").click();
      await save(page);
      assert.deepEqual(writes.at(-1), { target, resource: "runtime", body: { inherit: true } });
      assert.equal(rows.get(target), null);
      assert.equal(rows.has("org:acme"), false);
      await page.reload();
      await ready(page);
      await runtimeVisible(page, target);
      assert.equal(await page.locator("#base-inherit").isChecked(), true);
      assert.equal(await page.locator("#base-runtime-fields").isVisible(), false);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
test("retained unavailable choices are visibly disabled and allow recovery or reset", async () => {
  rows.clear();
  approved = ["codex"];
  unavailable = true;
  const page = await browser.newPage();
  try {
    await page.goto(base + "/governance?scope=channel%3AC1");
    await ready(page);
    await runtimeVisible(page, "channel:C1");
    await page.locator("#base-harness + .dd .dd-btn").click();
    assert.equal(await page.locator("#base-harness + .dd .dd-item.dis").textContent(), "pi (default) (unavailable)");
    await page.keyboard.press("Escape");
    await pick(page, "base-effort", "Low");
    assert.equal(await page.locator('[data-save="runtime"]').isDisabled(), true);
    await pick(page, "base-harness", "Codex");
    await save(page);
    assert.equal(writes.at(-1).body.harnessId, "codex");
    rows.clear();
    approved = ["pi", "codex"];
    await page.reload();
    await ready(page);
    await page.locator("#base-model + .dd .dd-btn").click();
    assert.equal(await page.locator("#base-model + .dd .dd-item.dis").textContent(), "alpha (alpha) (unavailable)");
    await page.keyboard.press("Escape");
    await pick(page, "base-model", "beta (beta)");
    await save(page);
    assert.equal(writes.at(-1).body.modelId, "beta");
    rows.clear();
    await page.reload();
    await ready(page);
    await page.locator("#base-inherit-control").click();
    await save(page);
    assert.deepEqual(writes.at(-1).body, { inherit: true });
  } finally {
    await page.close();
  }
});
test("runtime manifest gating and other org-only Models controls remain intact", async () => {
  rows.clear();
  approved = ["pi", "codex"];
  unavailable = false;
  const page = await browser.newPage();
  try {
    await page.goto(base + "/models");
    await ready(page);
    assert.equal(await page.locator("#card-base-model").isVisible(), false);
    assert.equal(await page.locator("#card-webui-models").isVisible(), true);
    assert.equal(await page.locator("#card-custom-providers").isVisible(), true);
    await page.locator("#tabs").getByRole("button", { name: "Governance", exact: true }).click();
    await ready(page);
    await runtimeVisible(page, "org:acme");
    assert.equal(await page.locator("#base-inherit-control").isVisible(), false);
    assert.equal(await page.locator("#card-webui-models").isVisible(), false);
    manifest = { ...manifest, target: "org" };
    await page.goto(base + "/governance?scope=team%3AT1");
    await ready(page);
    assert.equal(await page.locator("#card-base-model").isVisible(), false);
    manifest = { ...manifest, target: "any", clearable: false };
    await page.reload();
    await ready(page);
    await runtimeVisible(page, "team:T1");
    assert.equal(await page.locator("#base-inherit-control").isVisible(), false);
  } finally {
    manifest = { id: "runtime", target: "any", clearable: true };
    await page.close();
  }
});
