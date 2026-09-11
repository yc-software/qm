import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SandboxBackendName } from "../../src/sandbox/sandbox-routing.ts";
import { isObj } from "../../src/util/objects.ts";
import type { Scenario } from "./harness.ts";

const providerCoverage: Record<SandboxBackendName, true> = {
  sprites: true,
  aws: true,
  local: true,
  smolmachines: true,
  e2b: true,
  modal: true,
  porter: true,
  agent37: true,
};

export const sandboxProviders = Object.keys(providerCoverage) as SandboxBackendName[];

export function assertSandboxExecution(entries: readonly unknown[], sandboxId: string, stdout: string): void {
  const calls = new Set(
    entries.flatMap((entry) => {
      if (!isObj(entry) || entry.type !== "tool_call" || !isObj(entry.payload)) return [];
      const p = entry.payload;
      return p.tool === "sandbox" && p.action === "exec" && p.sandbox_id === sandboxId && typeof p.callId === "string"
        ? [p.callId]
        : [];
    }),
  );
  assert.ok(calls.size, `no sandbox exec call targeted ${sandboxId}`);
  assert.ok(
    entries.some((entry) => {
      if (!isObj(entry) || entry.type !== "tool_result" || !isObj(entry.payload)) return false;
      const p = entry.payload;
      return (
        p.tool === "sandbox" &&
        p.action === "exec" &&
        typeof p.callId === "string" &&
        calls.has(p.callId) &&
        p.isError === false &&
        p.code === 0 &&
        p.timedOut === false &&
        p.stdout === stdout
      );
    }),
    `no successful sandbox exec result with exact stdout on ${sandboxId}`,
  );
}

export const sandboxProviderScenarios: Scenario[] = sandboxProviders.map((backend) => ({
  name: `sandbox-execute-${backend}`,
  lane: "parallel",
  tags: ["sandbox", "provider-execution"],
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const ch = await ctx.freshChannel();
    const scopeId = `channel:${ch.id}`;
    const inventory = await ctx.core.listSandboxes(scopeId);
    const provider = inventory.providers.find((p) => p.name === backend);
    assert.ok(provider, `required sandbox provider ${backend} is unavailable`);
    assert.ok(provider.actions.includes("create"), `${backend} cannot create a test sandbox`);
    assert.ok(provider.actions.includes("retire"), `${backend} cannot clean up a test sandbox`);
    const name = ctx.marker();
    const failures: unknown[] = [];
    try {
      const sandbox = await ctx.core.manageSandbox(scopeId, { action: "create", backend, name });
      assert.equal(sandbox.backend, backend);
      assert.ok(sandbox.id);
      await ctx.core.manageSandbox(scopeId, { action: "default", sandboxId: sandbox.id });
      const left = randomUUID();
      const right = randomUUID();
      const root = await ch.mention(
        `Use the sandbox tool with action exec and sandbox_id ${sandbox.id} to run exactly this command: printf '%s%s\\n' '${left}' '${right}'. Set timeout_seconds to 30. Report the result. Do not use another sandbox or a background process.`,
      );
      await ch.waitForBotReply(root, { timeoutMs: 3 * 60_000 });
      const session = await ctx.core.findSessionByThread(ch.id, root);
      assert.ok(session, `no session for ${backend} execution`);
      assertSandboxExecution(session.entries, sandbox.id, `${left}${right}\n`);
    } catch (error) {
      failures.push(error);
    }
    try {
      const inventory = await ctx.core.listSandboxes(scopeId);
      const created = inventory.sandboxes.filter((s) => s.name === name && s.backend === backend);
      if (created.length) {
        await ctx.core.manageSandbox(scopeId, { action: "default", sandboxId: null });
        const cleanup = await Promise.allSettled(
          created.map((s) => ctx.core.manageSandbox(scopeId, { action: "retire", sandboxId: s.id })),
        );
        const failures = cleanup.filter((r) => r.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((r) => r.reason),
            `${backend} cleanup failed`,
          );
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, `${backend} execution or cleanup failed: ${failures.map(String).join("; ")}`);
  },
}));
