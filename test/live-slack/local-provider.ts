import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { buildApp } from "../../src/wiring.ts";
import { assertSandboxExecution } from "./scenarios-sandbox-providers.ts";

async function main(): Promise<void> {
  assert.ok(
    process.env.ANTHROPIC_API_KEY || process.env.MODEL_GATEWAY_URL,
    "a live model credential or model gateway is required",
  );
  assert.ok(process.env.LOCAL_SANDBOX_IMAGE?.startsWith("sha256:"), "use an immutable local sandbox image ID");
  assert.ok(process.env.QM_CORE_CONTAINER, "the candidate core container name is required");
  assert.ok(process.env.EXPECTED_SOURCE_SHA, "the expected source pin is required");
  assert.equal(process.env.GIT_SHA, process.env.EXPECTED_SOURCE_SHA, "candidate image does not match the source pin");
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point at a Postgres server");
  const config = loadConfig();
  const built = buildApp({
    ...config,
    dataDir: mkdtempSync(join(tmpdir(), "provider-qualification-")),
    databaseUrl: process.env.DATABASE_URL,
    sandboxBackend: "local",

    backgroundWorkEnabled: false,
    turnWallClockMs: 180_000,
    localSandbox: { ...config.localSandbox, coreContainer: process.env.QM_CORE_CONTAINER },
  });
  const actorId = `provider-qualification-${randomUUID()}`;
  const scopeId = `personal:${actorId}`;
  const name = `local-${randomUUID()}`;
  const failures: unknown[] = [];
  try {
    await built.identity.hydrate();
    await built.start();
    const sandbox = await built.sandboxResources.create(actorId, scopeId, "local", name);
    assert.equal(sandbox.backend, "local");
    await built.sandboxResources.setDefault(actorId, scopeId, sandbox.id);
    const left = randomUUID();
    const right = randomUUID();
    const result = await built.app.turn({
      origin: { kind: "direct" },
      surface: "qualification",
      actor: { externalId: actorId },
      conversation: { kind: "dm", threadRef: `qualification:${randomUUID()}` },
      text: `Use execute with sandbox_id ${sandbox.id} to run exactly: printf '%s%s\\n' '${left}' '${right}'. Set timeout_seconds to 30. Report the result.`,
    });
    assert.equal(result.status, "ok", result.reason ?? result.reply);
    assert.ok(result.sessionId);
    const items = await built.sessions.getItems(result.sessionId);
    try {
      assertSandboxExecution(items, sandbox.id, `${left}${right}\n`);
    } catch (error) {
      console.error(JSON.stringify({ reply: result.reply, items }));
      throw error;
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const { sandboxes } = await built.sandboxResources.list(actorId, scopeId);
    await built.sandboxResources.setDefault(actorId, scopeId, null);
    for (const sandbox of sandboxes.filter((s) => s.ownerScopeId === scopeId && s.name === name))
      await built.sandboxResources.retire(actorId, sandbox.id);
  } catch (error) {
    failures.push(error);
  }
  await built.runtime.stop();
  if (failures.length)
    throw new AggregateError(failures, `local qualification failed: ${failures.map(String).join("; ")}`);
  console.log(
    JSON.stringify({
      provider: "local",
      source: process.env.GIT_SHA,
      sandboxImage: process.env.LOCAL_SANDBOX_IMAGE,
      status: "pass",
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
