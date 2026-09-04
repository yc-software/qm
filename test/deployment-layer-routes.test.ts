import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { agentApiMatches } from "../src/api/agent-api-catalog.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { DeploymentLayerPersistedError } from "../src/deployment/deployment-layer-store.ts";

const SECRET = "layer-routes-secret".repeat(3);
const PATH = "/v1/deployment-layer";

function start(overrides: { deploymentLayerDir?: string } = {}, serverDeps: Record<string, unknown> = {}) {
  const built = buildApp(testConfig({ signingSecret: SECRET, ...overrides }));
  const server = createServer(built.app, {
    signingSecret: SECRET,
    deploymentLayer: built.deploymentLayerStore,
    auditLog: built.auditLog,
    ...serverDeps,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((r) => server.close(() => r())),
    skills: built.skills,
    auditLog: built.auditLog,
    deploymentLayerStore: built.deploymentLayerStore,
  };
}

function signed(method: string, body: string, ts = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${PATH}\n${body}`),
  };
}

const bundle = JSON.stringify({
  contract: 1,
  tools: [{ path: "tools/acme/tool.json", content: JSON.stringify({ id: "acme", advertise: "acme CLI" }) }],
  skills: [{ path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: Use acme.\n---\nRun acme.\n" }],
});

test("an empty layer GETs the version-0 shape with a source discriminator under source auth", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { contract: 1, version: 0, contentHash: null, source: "none", resolved: null });
  } finally {
    await srv.close();
  }
});

test("a baked filesystem layer with no durable record GETs source=filesystem and its live resolved state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "layer-routes-fs-"));
  mkdirSync(join(dir, "tools", "acme"), { recursive: true });
  writeFileSync(join(dir, "tools", "acme", "tool.json"), JSON.stringify({ id: "acme", advertise: "acme CLI (baked)" }));
  const srv = start({ deploymentLayerDir: dir });
  try {
    const res = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version: number;
      source: string;
      resolved: { advertisedTools: string[] } | null;
    };
    assert.equal(body.version, 0);
    assert.equal(body.source, "filesystem");
    assert.deepEqual(
      body.resolved?.advertisedTools,
      ["acme CLI (baked)"],
      "the live baked layer is reported, not a bare empty shape",
    );
  } finally {
    await srv.close();
  }
});

test("a signed PUT lands under portal-identity enforcement (deploy-time sync is a SYSTEM write)", async () => {
  const srv = start(
    {},
    { requireSignedPortalIdentity: true, capabilitySecret: `${SECRET}-cap`, portalIdentitySecret: `${SECRET}-portal` },
  );
  try {
    const unsigned = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: bundle,
    });
    assert.equal(unsigned.status, 401);
    const put = await fetch(`${srv.base}${PATH}`, { method: "PUT", headers: signed("PUT", bundle), body: bundle });
    assert.equal(put.status, 200);
    const putBody = (await put.json()) as { ok: boolean; version: number };
    assert.equal(putBody.ok, true);
    assert.equal(putBody.version, 1);
  } finally {
    await srv.close();
  }
});

test("a correctly signed PUT replaces the layer and a signed GET reads it back", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}${PATH}`, { method: "PUT", headers: signed("PUT", bundle), body: bundle });
    assert.equal(put.status, 200);
    const putBody = (await put.json()) as {
      ok: boolean;
      version: number;
      durable: boolean;
      resolved: { advertisedTools: string[] };
    };
    assert.equal(putBody.ok, true);
    assert.equal(putBody.version, 1);
    assert.equal(putBody.durable, false, "a memory-backed core reports the PUT as non-durable");
    assert.deepEqual(putBody.resolved.advertisedTools, ["acme CLI"]);

    const get = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    assert.equal(get.status, 200);
    const getBody = (await get.json()) as {
      version: number;
      contentHash: string | null;
      status: string;
      runtimeContentHash: string | null;
      source: string;
    };
    assert.equal(getBody.version, 1);
    assert.equal(getBody.status, "applied");
    assert.equal(getBody.runtimeContentHash, getBody.contentHash);
    assert.equal(getBody.source, "durable");
    assert.ok(getBody.contentHash);
  } finally {
    await srv.close();
  }
});

test("GET distinguishes a poisoned stored revision from the prior durable revision still live", async (t) => {
  const first = JSON.stringify({
    contract: 1,
    tools: [{ path: "tools/acme/tool.json", content: JSON.stringify({ id: "acme", advertise: "acme v1" }) }],
    skills: [],
  });
  const poisoned = JSON.stringify({
    contract: 1,
    tools: [{ path: "tools/acme/tool.json", content: JSON.stringify({ id: "acme", advertise: "acme v2" }) }],
    skills: [
      { path: "skills/broken/SKILL.md", content: "---\nname: broken\ndescription: Broken.\n---\nRun broken.\n" },
    ],
  });
  const srv = start();
  t.mock.method(console, "error", () => undefined);
  try {
    const initialPut = await fetch(`${srv.base}${PATH}`, { method: "PUT", headers: signed("PUT", first), body: first });
    assert.equal(initialPut.status, 200);
    const initialHash = ((await initialPut.json()) as { contentHash: string }).contentHash;

    t.mock.method(srv.skills, "create", async () => {
      throw new Error("poisoned skill store");
    });
    const failedPut = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: signed("PUT", poisoned),
      body: poisoned,
    });
    assert.equal(failedPut.status, 202, "a persisted revision is reported as accepted but degraded");
    const failedBody = (await failedPut.json()) as { ok: boolean; status: string; message: string };
    assert.equal(failedBody.ok, true);
    assert.equal(failedBody.status, "degraded");
    assert.match(failedBody.message, /poisoned skill store/);
    const audits = await srv.auditLog.events();
    assert.equal(
      audits.filter((event) => event.action === "deployment_layer.updated").length,
      2,
      "both persisted revisions are audited",
    );

    const get = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    assert.equal(get.status, 200);
    const body = (await get.json()) as {
      contentHash: string;
      status: string;
      runtimeContentHash: string | null;
      source: string;
      resolved: { advertisedTools: string[] };
    };
    assert.notEqual(body.contentHash, initialHash, "the desired stored revision remains observable");
    assert.equal(body.status, "degraded");
    assert.equal(body.runtimeContentHash, initialHash);
    assert.equal(body.source, "durable");
    assert.deepEqual(
      body.resolved.advertisedTools,
      ["acme v1"],
      "GET reports the prior revision this instance still serves",
    );
  } finally {
    await srv.close();
  }
});

test("a bad signature and a stale timestamp are both rejected 401", async () => {
  const srv = start();
  try {
    const forged = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: { ...signed("PUT", bundle), "x-signature": "v0=deadbeef" },
      body: bundle,
    });
    assert.equal(forged.status, 401);

    const stale = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: signed("PUT", bundle, Math.floor(Date.now() / 1000) - 3600),
      body: bundle,
    });
    assert.equal(stale.status, 401);

    const get = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    assert.deepEqual(
      await get.json(),
      { contract: 1, version: 0, contentHash: null, source: "none", resolved: null },
      "rejected PUTs never landed",
    );
  } finally {
    await srv.close();
  }
});

test("a malformed bundle is a 400, shaped, and never becomes the current layer", async () => {
  const srv = start();
  try {
    const notABundle = JSON.stringify({ contract: 2 });
    const shape = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: signed("PUT", notABundle),
      body: notABundle,
    });
    assert.equal(shape.status, 400);
    const shapeBody = (await shape.json()) as { error: string; message: string };
    assert.equal(shapeBody.error, "bad_request");
    assert.match(shapeBody.message, /contract: 1, tools\[\], and skills\[\] required/);

    const invalid = JSON.stringify({
      contract: 1,
      tools: [],
      skills: [
        { path: "skills/a/SKILL.md", content: "---\nname: same\ndescription: One.\n---\nbody\n" },
        { path: "skills/b/SKILL.md", content: "---\nname: same\ndescription: Two.\n---\nbody\n" },
      ],
    });
    const dup = await fetch(`${srv.base}${PATH}`, { method: "PUT", headers: signed("PUT", invalid), body: invalid });
    assert.equal(dup.status, 400);
    const dupBody = (await dup.json()) as { error: string; message: string };
    assert.equal(dupBody.error, "invalid_deployment_layer");
    assert.match(dupBody.message, /duplicate deployment skill name/);

    const get = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    assert.equal(((await get.json()) as { version: number }).version, 0);
  } finally {
    await srv.close();
  }
});

test("cross-tool credential collisions and unpaired surrogates are 400s", async () => {
  const srv = start();
  try {
    const nested = JSON.stringify({
      contract: 1,
      tools: [
        {
          path: "tools/a/tool.json",
          content: JSON.stringify({
            id: "a",
            auth: { check: "c", reauth: "r", credentialPaths: [{ path: ".acme", kind: "directory" }] },
          }),
        },
        {
          path: "tools/b/tool.json",
          content: JSON.stringify({
            id: "b",
            auth: { check: "c", reauth: "r", credentialPaths: [{ path: ".acme/sub/key", kind: "file" }] },
          }),
        },
      ],
      skills: [],
    });
    const collision = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: signed("PUT", nested),
      body: nested,
    });
    assert.equal(collision.status, 400);
    assert.match(((await collision.json()) as { message: string }).message, /incompatible credential paths/);

    const surrogate = `{"contract":1,"tools":[],"skills":[{"path":"skills/acme/SKILL.md","content":"---\\nname: acme\\ndescription: x\\n---\\nbad\\ud800body"}]}`;
    const invalidUnicode = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: signed("PUT", surrogate),
      body: surrogate,
    });
    assert.equal(invalidUnicode.status, 400);
    assert.match(((await invalidUnicode.json()) as { message: string }).message, /unpaired Unicode surrogate/);

    const get = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    assert.equal(((await get.json()) as { version: number }).version, 0);
  } finally {
    await srv.close();
  }
});

test("a skill collision racing after validation is accepted degraded and audited", async (t) => {
  const srv = start();
  try {
    const record = await srv.deploymentLayerStore.put({ contract: 1, tools: [], skills: [] }, "setup");
    t.mock.method(srv.deploymentLayerStore, "put", async () => {
      throw new DeploymentLayerPersistedError("deployment layer persisted but skills acme collide", record);
    });
    t.mock.method(srv.deploymentLayerStore, "isApplied", () => false);

    const put = await fetch(`${srv.base}${PATH}`, { method: "PUT", headers: signed("PUT", bundle), body: bundle });
    const responseText = await put.text();
    assert.equal(put.status, 202, responseText);
    const body = JSON.parse(responseText) as { ok: boolean; status: string; contentHash: string; message: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, "degraded");
    assert.match(body.message, /persisted but skills acme collide/);

    const events = await srv.auditLog.events();
    assert.ok(
      events.some((event) => event.action === "deployment_layer.updated" && event.resource === body.contentHash),
    );
    const get = await fetch(`${srv.base}${PATH}`, { headers: signed("GET", "") });
    const current = (await get.json()) as { contentHash: string; status: string };
    assert.equal(current.contentHash, body.contentHash);
    assert.equal(current.status, "degraded");
  } finally {
    await srv.close();
  }
});

test("a VALID capability token is rejected on the deployment-layer routes (source-auth only)", async () => {
  assert.equal(agentApiMatches("GET", PATH), false);
  assert.equal(agentApiMatches("PUT", PATH), false);

  const srv = start();
  try {
    const cap = await mintCapabilityToken(
      { actorId: "U1", scopeId: scopeId("personal", "U1"), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const get = await fetch(`${srv.base}${PATH}`, { headers: { "x-agent-capability": cap } });
    assert.equal(get.status, 403);
    const put = await fetch(`${srv.base}${PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: bundle,
    });
    assert.equal(put.status, 403);
  } finally {
    await srv.close();
  }
});
