import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { defaultAppIcon, parseAppIcon } from "../src/deploy/app-icon.ts";
import { appShellHtml } from "../src/deploy/app-shell.ts";
import { scopeId } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";

function svc() {
  return createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 5000 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "app-icon-")),
  });
}

const owner = { ownerScopeId: scopeId("personal", "U1"), createdBy: "U1" };
const files = [{ path: "server.js", data: new TextEncoder().encode("listen") }];
const publish = { ...owner, entrypoint: "node server.js", files };

test("a first publish without an icon stores a default picked from the name", async () => {
  const deploy = svc();
  const d = await deploy.deployOrUpdate({ ...publish, name: "sales-board" });
  assert.equal(d.icon, defaultAppIcon("sales-board"));
  assert.equal(defaultAppIcon("sales-board"), defaultAppIcon("sales-board"));
  assert.ok(parseAppIcon(d.icon));
});

test("an explicit icon is kept across updates and rollbacks until it is passed again", async () => {
  const deploy = svc();
  const created = await deploy.deployOrUpdate({ ...publish, name: "board", icon: "📈" });
  assert.equal(created.icon, "📈");
  const updated = await deploy.deployOrUpdate({ ...publish, name: "board" });
  assert.equal(updated.currentVersion, 2);
  assert.equal(updated.icon, "📈", "a republish without icon keeps it");
  const changed = await deploy.deployOrUpdate({ ...publish, name: "board", icon: "🧮" });
  assert.equal(changed.icon, "🧮");
  const rolled = await deploy.deployOrUpdate({ ...owner, name: "board", rollbackTo: 1 });
  assert.equal(rolled.currentVersion, 1);
  assert.equal(rolled.icon, "🧮", "a rollback keeps the deployment's icon");
  const renamed = await deploy.deployOrUpdate({ ...owner, renameFrom: "board", name: "board2" });
  assert.equal(renamed.icon, "🧮", "a rename keeps the icon");
});

test("icons must be a single emoji", async () => {
  const deploy = svc();
  for (const bad of ["", "ab", "🚀🚀", "<svg/>", "x🚀"])
    await assert.rejects(deploy.deployOrUpdate({ ...publish, name: "bad", icon: bad }), /icon must be a single emoji/);
  for (const good of ["🚀", "🛠️", "👩🏽‍💻", "🇺🇸"]) assert.equal(parseAppIcon(good), good);
});

test("the owner shell starts with the platform icon", () => {
  const html = appShellHtml({ slug: "board", portalUrl: "https://portal.example.com", path: "/", icon: "📈" });
  const href = html.match(/<link rel="icon" type="image\/svg\+xml" href="([^"]+)">/)?.[1];
  assert.ok(href?.startsWith("data:image/svg+xml,"));
  assert.match(decodeURIComponent(href!.slice("data:image/svg+xml,".length)), /📈<\/text><\/svg>$/);
});
