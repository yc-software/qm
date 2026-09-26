import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import type { SessionTool, SessionTopbarOpts } from "../src/session-scope.ts";

const source = readFileSync(new URL("../src/session-scope.ts", import.meta.url), "utf8");
const dom = new JSDOM("<!doctype html><body></body>");
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
}))
  Object.defineProperty(globalThis, key, { configurable: true, value });
const { html, nothing, render } = await import("lit");
const { sessionStatusMark } = await import("../src/session-status.ts");

function load(api: (path: string) => Promise<unknown> = async () => ({})) {
  return runInNewContext(
    stripTypeScriptTypes(
      source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "") + "\n({ scopeToolCount, sessionTopbarTpl });",
    ),
    {
      api,
      html,
      sessionStatusMark,
      nothing,
      icon: () => nothing,
      tip: () => nothing,
      closeFormMenus: () => {},
      toggleFormMenu: () => {},
      ...Object.fromEntries(
        ["ArrowUpLeft", "Box", "Brain", "Clock3", "Ellipsis", "Files", "Ghost", "GitFork", "KeyRound", "Rocket"].map(
          (name) => [name, name],
        ),
      ),
    },
  ) as {
    scopeToolCount: (tool: SessionTool, scope: string, ready: () => void) => number | null;
    sessionTopbarTpl: (opts: SessionTopbarOpts) => ReturnType<typeof html>;
  };
}

test("only Crons and Apps request counts; both count past 100", async () => {
  const requests: string[] = [];
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
  const { scopeToolCount } = load(async (path) => {
    requests.push(path);
    return path === "/api/crons"
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
  });
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
  const { sessionTopbarTpl } = load();
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
  render(load().sessionTopbarTpl({ crumb: null, title: "Test", onTool: () => {}, toolCount: () => 0 }), host);
  assert.equal(host.querySelectorAll(".session-tool-count").length, 0);
});

test("session status appears after the heading and before tools", () => {
  const host = document.createElement("div");
  render(
    load().sessionTopbarTpl({
      crumb: null,
      title: "Release verification",
      status: { emoji: "🚀", text: "Live in production" },
      onTool: () => {},
    }),
    host,
  );
  const status = host.querySelector(".session-status")!;
  assert.equal(status.textContent, "🚀");
  assert.equal(status.getAttribute("aria-label"), "Live in production");
  assert.ok(status.previousElementSibling?.classList.contains("session-heading"));
  assert.ok(status.nextElementSibling?.classList.contains("session-tools"));
});

test("an incognito session carries a ghost badge in its heading", () => {
  const host = document.createElement("div");
  render(load().sessionTopbarTpl({ crumb: null, title: "Private", incognito: true, onTool: () => {} }), host);
  const badge = host.querySelector(".session-heading .session-incognito-badge");
  assert.equal(badge?.textContent?.trim(), "Incognito");
  render(load().sessionTopbarTpl({ crumb: null, title: "Ordinary", onTool: () => {} }), host);
  assert.equal(host.querySelector(".session-incognito-badge"), null);
});
