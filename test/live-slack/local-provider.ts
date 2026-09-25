import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { buildApp } from "../../src/wiring.ts";
import { setOnboardingStatus } from "../../src/onboarding/onboarding.ts";
import { assertSandboxExecution } from "./scenarios-sandbox-providers.ts";

async function main(): Promise<void> {
  assert.ok(process.env.ANTHROPIC_API_KEY, "a live model credential is required");
  assert.ok(process.env.LOCAL_SANDBOX_IMAGE?.startsWith("sha256:"), "use an immutable local sandbox image ID");
  assert.ok(process.env.QM_CORE_CONTAINER, "the candidate core container name is required");
  assert.ok(process.env.EXPECTED_SOURCE_SHA, "the expected source pin is required");
  assert.equal(process.env.GIT_SHA, process.env.EXPECTED_SOURCE_SHA, "candidate image does not match the source pin");
  const config = loadConfig();
  const built = buildApp({
    ...config,
    dataDir: mkdtempSync(join(tmpdir(), "provider-qualification-")),
    sessionStore: "memory",
    runStore: "memory",
    harness: "pi",
    sandboxBackend: "local",
    sandboxResourcesEnabled: true,
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
    await built.deploymentLayerReady;
    await built.sandboxResources.initialize();
    await built.memory.replace(
      scopeId,
      setOnboardingStatus("", "completed", new Date().toISOString().slice(0, 10)),
      actorId,
    );
    const sandbox = await built.sandboxResources.create(actorId, scopeId, "local", name);
    assert.equal(sandbox.backend, "local");
    await built.sandboxResources.setDefault(actorId, scopeId, sandbox.id);
    const left = randomUUID();
    const right = randomUUID();
    const result = await built.app.turn({
      surface: "qualification",
      actor: { externalId: actorId },
      conversation: { kind: "dm", threadRef: `qualification:${randomUUID()}` },
      text: `Use sandbox action exec with sandbox_id ${sandbox.id} to run exactly: printf '%s%s\\n' '${left}' '${right}'. Set timeout_seconds to 30. Report the result.`,
    });
    assert.equal(result.status, "ok", result.reason ?? result.reply);
    assert.ok(result.sessionId);
    const entries = await built.sessions.getEntries(result.sessionId);
    try {
      assertSandboxExecution(entries, sandbox.id, `${left}${right}\n`);
    } catch (error) {
      console.error(JSON.stringify({ reply: result.reply, entries }));
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
