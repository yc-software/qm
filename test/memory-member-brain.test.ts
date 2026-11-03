import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { withProviders } from "../src/memory/provider-outcome.ts";
import { createRegistryMemoryService } from "../src/memory/registry-memory.ts";
import {
  EMPTY_MEMORY_REGISTRY,
  memberBrainId,
  putBinding,
  putBrain,
  type MemoryRegistry,
} from "../src/memory/registry.ts";
import type { AddressFetch } from "../src/util/network.ts";
import { loopbackFetch, startMcpTestServer } from "./support/mcp-test-server.ts";
import { emptyMemoryRegistry } from "./support/memory-registry.ts";

const change = { actor: "U1", now: 1_762_128_000_000, overlayIds: new Set<string>(), key: emptyMemoryRegistry.key };
const BRAIN = memberBrainId("U1");

const notebook: MemoryService = {
  recall: async () => [{ text: "notebook fact", score: 0.2 }],
  capture: async (_scope, facts) => facts.length,
  query: async () => ["notebook hit"],
  read: async () => "",
};

function ownedBy(url: string, owner: string): MemoryRegistry {
  const registered = putBrain(
    EMPTY_MEMORY_REGISTRY,
    BRAIN,
    {
      preset: "gbrain-v1",
      url,
      clientId: "qm-member",
      clientSecret: "member-secret",
      label: "Alice's brain",
      timeoutMs: 300,
    },
    change,
  );
  const owned = { ...registered, brains: registered.brains.map((brain) => ({ ...brain, owner })) };
  return putBinding(owned, BRAIN, { brain: BRAIN, scope: `personal:${owner}`, capture: "explicit" }, change);
}

function serving(record: MemoryRegistry, memberFetch?: AddressFetch) {
  const errors: unknown[] = [];
  const memory = createRegistryMemoryService({
    defaultMemory: notebook,
    registry: { ...emptyMemoryRegistry, current: async () => ({ version: "1", record }) },
    ...(memberFetch ? { memberFetch } : {}),
    onError: (error) => void errors.push(error),
  });
  const search = () =>
    withProviders("search", (report) => memory.query("personal:U1", "bees", 5, { actorId: "U1", report }));
  return { search, errors };
}

function causes(error: unknown): string {
  const messages: string[] = [];
  for (let at = error; at instanceof Error; at = at.cause) messages.push(at.message);
  return messages.join(" <- ");
}

function brainServer(t: { after(fn: () => Promise<void>): void }, call: () => unknown) {
  return startMcpTestServer(t, {
    tools: [{ name: "memory_recall", inputSchema: { type: "object" } }],
    clients: { "qm-member": "member-secret" },
    call: call as never,
  });
}

test("a member's brain is called only through the guarded fetch, which refuses private addresses", async (t) => {
  const brain = await brainServer(t, () => ({ content: [{ type: "text", text: "Alice keeps bees." }] }));
  const guarded = serving(ownedBy(brain.url, "U1"));
  const refused = await guarded.search();
  assert.deepEqual(refused.value, ["notebook hit"]);
  assert.deepEqual(
    refused.problems.map(({ code }) => code),
    ["memory_provider_failed"],
  );
  assert.match(causes(guarded.errors[0]), /private network address/);
  assert.deepEqual([brain.requests, brain.tokenRequests], [[], []]);

  const allowed = await serving(ownedBy(brain.url, "U1"), loopbackFetch).search();
  assert.deepEqual(allowed.value, ["notebook hit", "Alice keeps bees."]);
  assert.equal(brain.requests.at(-1)?.actor, "U1");
});

test("a stalled member brain ends at its deadline, and QM cancels the request it left open", async (t) => {
  const brain = await brainServer(t, () => new Promise(() => {}));
  const requests: Array<{ rpc?: string; signal?: AbortSignal | null }> = [];
  const watched: AddressFetch = (input, init) => {
    const rpc = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: string }).method : undefined;
    requests.push({ ...(rpc ? { rpc } : {}), signal: init?.signal });
    return loopbackFetch(input, init);
  };
  const started = Date.now();
  const { value, outcomes } = await serving(ownedBy(brain.url, "U1"), watched).search();
  const elapsed = Date.now() - started;
  assert.deepEqual(value, ["notebook hit"]);
  assert.deepEqual(
    outcomes.filter(({ provider }) => provider === BRAIN).map(({ outcome }) => outcome),
    ["timed_out"],
  );
  assert.ok(elapsed < 1_500, `took ${elapsed}ms`);
  const call = requests.find(({ rpc }) => rpc === "tools/call");
  assert.equal(call?.signal?.aborted, true);
});

test("an oversized or endless member brain response fails as soon as it passes the size limit", async (t) => {
  const oversized = await brainServer(t, () => ({ content: [{ type: "text", text: "x".repeat(1_100_000) }] }));
  const big = serving(ownedBy(oversized.url, "U1"), loopbackFetch);
  assert.deepEqual(
    (await big.search()).problems.map(({ code }) => code),
    ["memory_provider_failed"],
  );
  assert.match(causes(big.errors[0]), /larger than 1000000 bytes/);

  let closedAt = 0;
  const endless = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path.startsWith("/.well-known/")) return void res.writeHead(404).end();
    if (path === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ access_token: "t", token_type: "Bearer", expires_in: 3600 }));
    }
    res.on("close", () => void (closedAt = Date.now()));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = `: ${"x".repeat(64 * 1024)}\n\n`;
    const pump = () => {
      while (!closedAt && res.write(chunk));
    };
    res.on("drain", pump);
    pump();
  });
  endless.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => endless.once("listening", resolve));
  t.after(() => {
    endless.closeAllConnections();
    return new Promise<void>((resolve) => endless.close(() => resolve()));
  });
  const flood = serving(ownedBy(`http://127.0.0.1:${(endless.address() as AddressInfo).port}`, "U1"), loopbackFetch);
  const started = Date.now();
  assert.deepEqual(
    (await flood.search()).problems.map(({ code }) => code),
    ["memory_provider_failed"],
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `the call took ${elapsed}ms`);
  assert.match(causes(flood.errors[0]), /larger than 1000000 bytes/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(closedAt > started && closedAt - started < 1_000, `the stream ran for ${closedAt - started}ms`);
});
