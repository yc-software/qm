import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SandboxBackendName } from "../../src/sandbox/sandbox-routing.ts";
import { redactSecrets } from "../../src/harness/redact-secrets.ts";
import type { Item } from "../../src/sessions/items.ts";
import { headSlice, tailSlice } from "../../src/util/text.ts";
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
  superserve: true,
  "do-managed-agents": true,
};

export const sandboxProviders = Object.keys(providerCoverage) as SandboxBackendName[];

export function succeededWithStdout(item: Item, stdout: string): boolean {
  const b = item.body;
  const structured = "code" in b || "timedOut" in b || "action" in b;
  return (
    item.isError === false &&
    item.text === `${stdout}\n[exit 0]` &&
    (!structured || (b.code === 0 && b.timedOut === false))
  );
}

function describeExecuteResult(item: Item): string {
  const result = typeof item.text === "string" ? redactSecrets(item.text) : item.text;
  const shown =
    typeof result === "string" && result.length > 400 ? `${headSlice(result, 150)}…${tailSlice(result, 250)}` : result;
  return JSON.stringify({ isError: item.isError, code: item.body.code, timedOut: item.body.timedOut, result: shown });
}

export function assertSandboxExecution(items: readonly Item[], sandboxId: string, stdout: string): void {
  const calls = new Set<string>();
  const unmatched: string[] = [];
  let executed = false;
  for (const item of items) {
    if (item.tool !== "execute" || item.body.background === true || !item.callId) continue;
    if (item.kind === "ToolCall" && item.body.sandbox_id === sandboxId) {
      calls.add(item.callId);
      continue;
    }
    if (item.kind !== "ToolResult" || !calls.has(item.callId)) continue;
    if (succeededWithStdout(item, stdout)) executed = true;
    else unmatched.push(describeExecuteResult(item));
  }
  assert.ok(calls.size, `no execute call targeted ${sandboxId}`);
  const seen = unmatched.length ? `; results: ${unmatched.join(" | ")}` : "; no result recorded";
  assert.ok(executed, `no successful execute result with exact stdout on ${sandboxId}${seen}`);
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
    await core.waitForChannelMembership(ch.id, ctx.env.qaUserId);
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
        `Use the execute tool with sandbox_id ${sandbox.id} to run exactly this command: printf '%s%s\\n' '${left}' '${right}'. Set timeout_seconds to 30. Report the result. Do not use another sandbox or a background process.`,
      );
      await ch.waitForBotReply(root, { timeoutMs: 3 * 60_000 });
      const session = await core.findSessionByThread(ch.id, root);
      assert.ok(session, `no session for ${backend} execution`);
      assertSandboxExecution(session.items, sandbox.id, `${left}${right}\n`);
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
