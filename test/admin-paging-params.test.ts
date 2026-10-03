import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const URL = process.env.DATABASE_URL;

test("admin list endpoints accept fractional limit and offset values", { skip: !URL }, async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "admin-paging-")),
    databaseUrl: URL,
    adminGrants: "admin-alice:org_admin",
  });
  const built = buildApp(config);
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
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const headers = { "x-admin-actor": "admin-alice@default-org" };
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:paging" },
      text: "hello",
    };
    assert.equal((await built.app.turn(dm)).status, "ok");
    for (const path of [
      "/v1/admin/sessions?scope=org:default-org&limit=1.5",
      "/v1/admin/sessions?scope=org:default-org&offset=0.5",
      "/v1/admin/audit?scope=org:default-org&limit=2.5",
    ]) {
      const res = await fetch(base + path, { headers });
      assert.equal(res.status, 200, `${path} -> ${res.status} ${await res.text()}`);
    }
    const page = (await (
      await fetch(`${base}/v1/admin/sessions?scope=org:default-org&limit=1.9`, { headers })
    ).json()) as { limit: number };
    assert.equal(page.limit, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
