import "./support/auto-fake-sprites.ts";
import { testTenant } from "./support/test-tenant.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import type { PersonaResult } from "../src/personas/persona-service.ts";

const SECRET = "persona-handover-test-secret".repeat(2);
const ORG = scopeId("org", "default-org");
const ANN = "ann@example.com";
const BOB = "bob@example.com";
const CY = "cy@example.com";
const DAN = "dan@example.com";
const ADMIN = "admin-alice";
const ADMIN_HEADER = { "x-admin-actor": "admin-alice@default-org" };
const personal = (id: string) => scopeId("personal", id);

function ok<T>(result: PersonaResult<T>): T {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { value: T }).value;
}

async function setup() {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "persona-handover-")),
      signingSecret: SECRET,
      capabilitySecret: SECRET,
      apiBaseUrl: "http://core.example.test",
    }),
  );
  await built.app.upsertDirectory([
    { principalId: ANN, displayName: "Ann", type: "internal" },
    { principalId: BOB, displayName: "Bob", type: "internal" },
    { principalId: CY, displayName: "Cy", type: "internal" },
    { principalId: DAN, displayName: "Dan", type: "internal" },
    { principalId: ADMIN, displayName: "Alice Admin", type: "internal" },
  ]);
  await built.featureFlags.setEnabled("personas", ORG, true, ADMIN);
  const personas = built.app.personas!;
  const ada = ok(await personas.create(ANN, { name: "Ada" }));
  ok(
    await personas.setAccess(ANN, ada.id, [
      { scopeId: personal(ANN), role: "owner" },
      { scopeId: personal(BOB), role: "write" },
    ]),
  );
  return { built, personas, ada };
}

function serve(built: Awaited<ReturnType<typeof setup>>["built"]) {
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    identity: built.identity,
    sessions: built.sessions,
    acl: built.acl,
    featureFlags: built.featureFlags,
    channelPolicy: built.channelPolicy,
    directory: built.directory,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("a persona's last active owner leaving hands it to the default admin, and offboarding names only the handovers it causes", async () => {
  const { built, personas, ada } = await setup();
  const bea = ok(await personas.create(CY, { name: "Bea" }));
  assert.deepEqual(await built.app.personaHandover!.adoptOrphans(), []);
  await built.identity.deactivate(ANN);

  const { call, close } = serve(built);
  try {
    const preview = await call("POST", `/v1/admin/users/${CY}/offboard`, {}, ADMIN_HEADER);
    assert.equal(preview.status, 200);
    const planned = ((await preview.json()) as { changes: Array<Record<string, unknown>> }).changes.filter(
      (c) => c.kind === "persona",
    );
    assert.deepEqual(planned, [{ kind: "persona", id: bea.id, label: "Bea → Alice Admin", action: "transfer_owner" }]);
    assert.equal((await personas.detail(ADMIN, bea.id)).status, "not_found");

    const adopted = await built.app.personaHandover!.adoptOrphans();
    assert.deepEqual(
      adopted.map((h) => [h.persona.name, h.to]),
      [["Ada", ADMIN]],
    );
    assert.deepEqual(
      ok(await personas.detail(ADMIN, ada.id)).access.map((a) => [a.scopeId, a.role]),
      [
        [personal(ADMIN), "owner"],
        [personal(ANN), "owner"],
        [personal(BOB), "write"],
      ],
    );
    assert.deepEqual(await built.app.personaHandover!.adoptOrphans(), []);

    const applied = await call("POST", `/v1/admin/users/${CY}/offboard`, { apply: true }, ADMIN_HEADER);
    assert.equal(applied.status, 200);
    const done = ((await applied.json()) as { changes: Array<Record<string, unknown>> }).changes.find(
      (c) => c.kind === "persona",
    );
    assert.equal(done?.result, "done");
    assert.equal(ok(await personas.detail(ADMIN, bea.id)).role, "owner");
  } finally {
    await close();
  }
  const handovers = (await built.auditLog.events(testTenant)).filter((e) => e.action === "persona_owner_handover");
  assert.deepEqual(
    handovers.map((e) => [e.resource, e.detail]),
    [
      [ada.id, ADMIN],
      [bea.id, ADMIN],
    ],
  );
});

test("offboarding skips a leaving default admin, and a persona with an owner who stays is not handed over", async () => {
  const { built, personas } = await setup();
  await built.app.upsertDirectory([
    ...(await built.directory.list()),
    { principalId: "admin-bob", displayName: "Bob Admin", type: "internal" },
  ]);
  const solo = ok(await personas.create(ADMIN, { name: "Solo" }));
  const shared = ok(await personas.create(CY, { name: "Shared" }));
  ok(
    await personas.setAccess(CY, shared.id, [
      { scopeId: personal(CY), role: "owner" },
      { scopeId: personal(DAN), role: "owner" },
    ]),
  );

  const { call, close } = serve(built);
  try {
    const planned = async (who: string, headers: Record<string, string>) =>
      (
        (await (await call("POST", `/v1/admin/users/${who}/offboard`, {}, headers)).json()) as {
          changes: Array<Record<string, unknown>>;
        }
      ).changes.filter((c) => c.kind === "persona");
    assert.deepEqual(await planned(ADMIN, { "x-admin-actor": "admin-bob@default-org" }), [
      { kind: "persona", id: solo.id, label: "Solo → Bob Admin", action: "transfer_owner" },
    ]);
    assert.deepEqual(await planned(CY, ADMIN_HEADER), []);
  } finally {
    await close();
  }
});

test("a persona access change that would leave no active owner is refused", async () => {
  const { built, personas, ada } = await setup();
  await built.identity.deactivate(DAN);
  const access = (owner: string) => [
    { scopeId: personal(owner), role: "owner" as const },
    { scopeId: personal(BOB), role: "write" as const },
  ];
  assert.equal((await personas.setAccess(ANN, ada.id, access(DAN))).status, "invalid");
  assert.equal(
    (await personas.setAccess(ANN, ada.id, [{ scopeId: scopeId("channel", "C0DESIGN"), role: "owner" }])).status,
    "invalid",
  );
  assert.equal((await personas.setAccess(ANN, ada.id, access(ANN))).status, "ok");
});
