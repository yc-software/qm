import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { ADMIN_RESOURCES } from "../src/api/routes/admin-resources.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { orgScope } from "../src/config.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

const SHAPES = ["null", "[]", "7", '"text"'];
const ADMIN = "admin-alice";

async function start() {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "object-body-")),
    adminGrants: `${ADMIN}:org_admin`,
  });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, {
    ...serverDeps(config, built),
    capabilitySecret: TEST_CAPABILITY_SECRET,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const cap = (aud: string = CONTROL_PLANE_AUD) =>
    mintCapabilityToken(
      {
        actorId: ADMIN,
        scopeId: scopeId("personal", ADMIN),
        aud,
        liveActor: true,
        liveAuthor: true,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      TEST_CAPABILITY_SECRET,
    );
  const send = async (method: string, path: string, body: string, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { "x-agent-capability": token } : {}) },
      body,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as { message?: string } | null };
  };
  return { built, cap, send, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("routes that read named body fields answer non-object JSON with 400, not 500", async () => {
  const s = await start();
  try {
    const control = await s.cap();
    const scope = encodeURIComponent(orgScope());
    const pack = await s.built.app.registerSkillPack({
      kind: "git",
      url: "https://example.com/pack.git",
      ref: "main",
      syncMode: "pinned",
      trustTier: "internal",
      targetScopeId: orgScope() as ScopeId,
      subset: "all",
      createdBy: ADMIN,
    });
    const routes: Array<[string, string, string | undefined]> = [
      ["POST", "/v1/sessions/s1/title", undefined],
      ["POST", "/v1/sessions/s1/fork", undefined],
      ["POST", "/v1/sessions/s1/adopt", undefined],
      ["POST", "/v1/sessions/s1/detach", undefined],
      ["POST", "/v1/sessions/s1", undefined],
      ["PUT", "/v1/ui-state", undefined],
      ["PUT", "/v1/memory", undefined],
      ["POST", "/v1/grants/revoke", undefined],
      ["POST", "/v1/soul", undefined],
      ["POST", "/v1/directory", undefined],
      ["POST", "/v1/connectors/token", undefined],
      ["POST", "/v1/connectors/oauth/revoke", undefined],
      ["POST", "/v1/keychain/drops/d1", undefined],
      ["POST", "/v1/soul", control],
      ["POST", "/v1/crons", control],
      ["POST", "/v1/webhooks", control],
      ["POST", "/v1/keychain/credentials", control],
      ["POST", "/v1/keychain/asks", control],
      ["POST", "/v1/keychain/drops", control],
      ["POST", "/v1/memory/restore", control],
      ["POST", "/v1/memory/facts", control],
      ["PUT", "/v1/memory/self", control],
      ["POST", "/v1/connectors/oauth/revoke", control],
      ["POST", "/v1/connectors/oauth/consent/mint", await s.cap("oauth-consent")],
      ["POST", "/v1/credentials/broker", await s.cap("credential-broker")],
      ["PUT", "/v1/admin/slack-installation", control],
      ["PUT", "/v1/admin/mcp-servers/docs", control],
      ["PUT", "/v1/admin/custom-providers/acme", control],
      ["POST", `/v1/admin/files/upload?scope=${scope}`, control],
      ["PUT", `/v1/admin/memory?scope=${scope}`, control],
      ["PUT", `/v1/admin/users/${ADMIN}/onboarding`, control],
      ["PATCH", `/v1/admin/skill-packs/${pack.id}`, control],
      ["PUT", `/v1/admin/scopes/${scope}/command-policy-simulate`, control],
    ];
    const misses: string[] = [];
    for (const [method, path, token] of routes)
      for (const shape of SHAPES) {
        const { status, json } = await s.send(method, path, shape, token);
        if (status !== 400 || json?.message !== "expected a JSON object body")
          misses.push(`${method} ${path} ${token ? "capability" : "source"} ${shape} -> ${status} ${json?.message}`);
      }
    assert.deepEqual(misses, []);
  } finally {
    await s.close();
  }
});

test("admin governance resources reject non-object bodies without writing", async () => {
  const s = await start();
  try {
    const control = await s.cap();
    const scope = encodeURIComponent(orgScope());
    const branding = await s.send("PUT", `/v1/admin/scopes/${scope}/branding`, '{"accent":"#4f46e5"}', control);
    assert.equal(branding.status, 200);
    const misses: string[] = [];
    for (const { id } of ADMIN_RESOURCES)
      for (const shape of SHAPES) {
        if (shape === "null" && ["cron-runtime", "subagent-runtime", "fallback-runtime"].includes(id)) continue;
        const { status } = await s.send("PUT", `/v1/admin/scopes/${scope}/${id}`, shape, control);
        if (status === 200 || status >= 500) misses.push(`${id} ${shape} -> ${status}`);
      }
    assert.deepEqual(misses, []);
    assert.equal(s.built.config.getBranding(orgScope())?.accent, "#4f46e5");
  } finally {
    await s.close();
  }
});

test("a null body still clears an org purpose runtime", async () => {
  const s = await start();
  try {
    const control = await s.cap();
    const path = `/v1/admin/scopes/${encodeURIComponent(orgScope())}/cron-runtime`;
    await s.built.config.setPurposeRuntime("cron", { harnessId: "mock", modelId: "claude-sonnet-5" });
    assert.ok(await s.built.config.getPurposeRuntimeDurable("cron"));
    assert.equal((await s.send("PUT", path, "null", control)).status, 200);
    assert.equal(await s.built.config.getPurposeRuntimeDurable("cron"), undefined);
  } finally {
    await s.close();
  }
});
