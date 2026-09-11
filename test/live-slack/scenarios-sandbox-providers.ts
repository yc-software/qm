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
  kubernetes: true,
};

export const sandboxProviders = Object.keys(providerCoverage) as SandboxBackendName[];

export function assertSandboxExecution(entries: readonly unknown[], sandboxId: string, stdout: string): void {
  const calls = new Set<string>();
  let executed = false;
  for (const entry of entries) {
    if (!isObj(entry) || !isObj(entry.payload)) continue;
    const p = entry.payload;
    if (p.tool !== "sandbox" || typeof p.callId !== "string") continue;
    if (entry.type === "tool_call" && p.action === "exec" && p.sandbox_id === sandboxId) {
      calls.add(p.callId);
      continue;
    }
    if (entry.type !== "tool_result" || !calls.has(p.callId) || p.isError !== false) continue;
    const structured = "code" in p || "timedOut" in p || "stdout" in p || "action" in p;
    if (
      structured
        ? p.action === "exec" && p.code === 0 && p.timedOut === false && p.stdout === stdout
        : p.result === `${stdout}\n[exit 0]`
    )
      executed = true;
  }
  assert.ok(calls.size, `no sandbox exec call targeted ${sandboxId}`);
  assert.ok(executed, `no successful sandbox exec result with exact stdout on ${sandboxId}`);
}

export const sandboxProviderScenarios: Scenario[] = sandboxProviders.map((backend) => ({
  name: `sandbox-execute-${backend}`,
  lane: "parallel",
  tags: ["sandbox", "provider-execution"],
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const core = ctx.core.withSignal(AbortSignal.timeout(4 * 60_000));
    const ch = await ctx.freshChannel();
    const scopeId = `channel:${ch.id}`;
    const inventory = await core.listSandboxes(scopeId);
    const provider = inventory.providers.find((p) => p.name === backend);
    assert.ok(provider, `required sandbox provider ${backend} is unavailable`);
    assert.ok(provider.actions.includes("create"), `${backend} cannot create a test sandbox`);
    assert.ok(provider.actions.includes("retire"), `${backend} cannot clean up a test sandbox`);
    const name = ctx.marker();
    const failures: unknown[] = [];
    try {
      const sandbox = await core.manageSandbox(scopeId, { action: "create", backend, name });
      assert.equal(sandbox.backend, backend);
      assert.ok(sandbox.id);
      await core.manageSandbox(scopeId, { action: "default", sandboxId: sandbox.id });
      const left = randomUUID();
      const right = randomUUID();
      const root = await ch.mention(
        `Use the sandbox tool with action exec and sandbox_id ${sandbox.id} to run exactly this command: printf '%s%s\\n' '${left}' '${right}'. Set timeout_seconds to 30. Report the result. Do not use another sandbox or a background process.`,
      );
      await ch.waitForBotReply(root, { timeoutMs: 3 * 60_000 });
      const session = await core.findSessionByThread(ch.id, root);
      assert.ok(session, `no session for ${backend} execution`);
      assertSandboxExecution(session.entries, sandbox.id, `${left}${right}\n`);
    } catch (error) {
      failures.push(error);
    }
    try {
      const core = ctx.core.withSignal(AbortSignal.timeout(90_000));
      const inventory = await core.listSandboxes(scopeId);
      const created = inventory.sandboxes.filter((s) => s.name === name && s.backend === backend);
      if (created.length) {
        await core.manageSandbox(scopeId, { action: "default", sandboxId: null });
        const cleanup = await Promise.allSettled(
          created.map((s) => core.manageSandbox(scopeId, { action: "retire", sandboxId: s.id })),
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

export function selectSandboxProviderScenarios(value: string | undefined): Scenario[] {
  if (value === undefined) return [];
  if (value === "all") return sandboxProviderScenarios;
  const names = value.split(",").map((name) => name.trim());
  assert.ok(
    names.length && names.every((name) => name && Object.hasOwn(providerCoverage, name)),
    "LIVE_E2E_SANDBOX_PROVIDERS must be all or a comma-separated list of supported providers",
  );
  assert.equal(new Set(names).size, names.length, "sandbox provider list contains duplicates");
  return sandboxProviderScenarios.filter((scenario) =>
    names.some((name) => scenario.name === `sandbox-execute-${name}`),
  );
}
