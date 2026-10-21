import assert from "node:assert/strict";
import test, { after } from "node:test";
import { browserEnv } from "./browser-env.ts";
import type { SessionTool, SessionTopbarOpts } from "../src/session-scope.ts";

const requests: string[] = [];
let respond: (path: string) => unknown = () => ({});
const { vite, close } = await browserEnv({
  fetch: async (input) => {
    const path = String(input);
    requests.push(path);
    return Response.json(respond(path));
  },
});
after(close);
const { render } = await vite.ssrLoadModule("lit");
const { scopeToolCount, sessionTopbarTpl } = (await vite.ssrLoadModule("/src/session-scope.ts")) as {
  scopeToolCount: (tool: SessionTool, scope: string, ready: () => void) => number | null;
  sessionTopbarTpl: (opts: SessionTopbarOpts) => unknown;
};

test("only Crons and Apps request counts; both count past 100", async () => {
  const crons = Array.from({ length: 137 }, (_, i) => ({
    id: String(i),
    ownerScopeId: "personal:test",
    enabled: true,
  }));
  const deployments = Array.from({ length: 151 }, (_, i) => ({
    id: String(i),
    ownerScopeId: "personal:test",
    status: "ready",
  }));
  respond = (path) =>
    path === "/api/crons"
      ? {
          crons: [
            ...crons,
            { id: "disabled", ownerScopeId: "personal:test", enabled: false },
            { id: "archived", ownerScopeId: "personal:test", enabled: true, archived: true },
            { id: "other", ownerScopeId: "other", enabled: true },
          ],
          visible: crons,
        }
      : {
          deployments: [
            ...deployments,
            { id: "archived", ownerScopeId: "personal:test", status: "archived" },
            { id: "other", ownerScopeId: "other", status: "ready" },
          ],
        };
  for (const tool of ["files", "skills", "memory", "keychain"] as const) {
    assert.equal(
      scopeToolCount(tool, "personal:test", () => assert.fail("unexpected refresh")),
      null,
    );
  }
  assert.deepEqual(requests, []);
  for (const [tool, count] of [
    ["crons", 137],
    ["apps", 151],
  ] as const) {
    await new Promise<void>((resolve) => {
      assert.equal(scopeToolCount(tool, "personal:test", resolve), null);
    });
    assert.equal(
      scopeToolCount(tool, "personal:test", () => assert.fail("cached count")),
      count,
    );
  }
  assert.deepEqual(requests, ["/api/crons", "/api/deployments"]);
});

test("desktop and mobile put Crons and Apps first and badge only those tools", () => {
  const host = document.createElement("div");
  const queried: string[] = [];
  const clicked: string[] = [];
  render(
    sessionTopbarTpl({
      crumb: null,
      title: "Test",
      onTool: (tool) => clicked.push(tool),
      toolCount: (tool) => {
        queried.push(tool);
        return tool === "crons" ? 137 : 151;
      },
    }),
    host,
  );
  const desktop = [...host.querySelectorAll<HTMLButtonElement>(".session-tools button")];
  const mobile = [...host.querySelectorAll<HTMLButtonElement>(".menu-option")];
  assert.deepEqual(
    desktop.map((button) => button.getAttribute("aria-label")),
    ["Crons", "Apps", "Files", "Skills", "Memory", "Your keychain"],
  );
  assert.deepEqual(
    mobile.map((button) => button.querySelector(".menu-option-label")?.textContent),
    ["Crons", "Apps", "Files", "Skills", "Memory", "Your keychain"],
  );
  for (const buttons of [desktop, mobile]) {
    assert.deepEqual(
      buttons.map((button) => button.querySelector(".session-tool-count")?.textContent ?? null),
      ["137", "151", null, null, null, null],
    );
    for (const button of buttons) button.click();
  }
  assert.deepEqual(queried, ["crons", "apps", "crons", "apps"]);
  assert.deepEqual(clicked, [
    "crons",
    "apps",
    "files",
    "skills",
    "memory",
    "keychain",
    "crons",
    "apps",
    "files",
    "skills",
    "memory",
    "keychain",
  ]);
});

test("zero counts remain hidden in desktop and mobile tools", () => {
  const host = document.createElement("div");
  render(sessionTopbarTpl({ crumb: null, title: "Test", onTool: () => {}, toolCount: () => 0 }), host);
  assert.equal(host.querySelectorAll(".session-tool-count").length, 0);
});

test("an incognito session carries a ghost badge in its heading", () => {
  const host = document.createElement("div");
  render(sessionTopbarTpl({ crumb: null, title: "Private", incognito: true, onTool: () => {} }), host);
  const badge = host.querySelector(".session-heading .session-incognito-badge");
  assert.equal(badge?.textContent?.trim(), "Incognito");
  render(sessionTopbarTpl({ crumb: null, title: "Ordinary", onTool: () => {} }), host);
  assert.equal(host.querySelector(".session-incognito-badge"), null);
});
