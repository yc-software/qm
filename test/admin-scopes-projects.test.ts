import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("the admin scope index lists a project that has no sessions yet, and only to admins", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-scopes-projects-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    runs: built.runs,
    workspace: built.workspace,
    files: built.files,
    config: built.config,
    deliveries: built.deliveries,
    crons: built.crons,
    projects: built.projects,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const project = await built.projects.create({ name: "Empty launch", ownerId: "admin-alice" });
    const projectScope = `group:web-project-${project.id}`;
    const admin = await fetch(`${base}/v1/admin/scopes`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(admin.status, 200);
    const row = ((await admin.json()) as { scopes: { scopeId: string; sessions: number }[] }).scopes.find(
      (scope) => scope.scopeId === projectScope,
    );
    assert.ok(row, "an empty project appears in the admin scope index");
    assert.equal(row.sessions, 0);
    const denied = await fetch(`${base}/v1/admin/scopes`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);
    assert.ok(!(await denied.text()).includes(project.id), "a non-admin learns nothing about the project");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
