import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

test("user controls render before credentials and artifacts are scoped links", async () => {
  const f = litFixture();
  let finish!: (value: any) => void;
  const keychain = new Promise((resolve) => {
    finish = resolve;
  });
  const pending = f.ui.userDetail.detail(f.root, "alex@example.com", {
    pageShell() {},
    current: () => true,
    labelRole: () => "member",
    scopeKind: () => "personal",
    fmtTime: String,
    plural: (n: number, noun: string) => `${n} ${noun}s`,
    stateToUrl: ({ view, scope }: any) => `/admin/${view}?scope=${encodeURIComponent(scope)}`,
    webUiAsButton: () => f.document.createElement("button"),
    api: (_method: string, path: string) =>
      path.startsWith("/api/keychain")
        ? keychain
        : Promise.resolve({
            ok: true,
            data: { principalId: "alex@example.com", scopeId: "personal:alex@example.com", stats: { sessions: 42 } },
          }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    [...f.root.querySelectorAll("h2")].map((e) => e.textContent),
    ["Configuration", "Onboarding"],
  );
  const links = [...f.root.querySelectorAll<HTMLAnchorElement>(".user-resource-links a")];
  assert.deepEqual(
    links.map((e) => e.textContent),
    ["42 conversations →", "Files →", "Apps →", "Crons →", "Skills →", "Memory →"],
  );
  assert.ok(links.every((a) => a.href.endsWith("scope=personal%3Aalex%40example.com")));
  finish({ ok: true, data: { credentials: [], grants: [] } });
  await pending;
  assert.deepEqual(
    [...f.root.querySelectorAll("h2")].map((e) => e.textContent),
    ["Credentials (0)", "Grants (0)", "Configuration", "Onboarding"],
  );
  f.dom.window.close();
});
