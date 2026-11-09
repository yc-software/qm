import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as netServer, type AddressInfo, type Socket } from "node:net";
import { createMcpClient } from "../src/mcp/mcp-client.ts";
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
  recall: async () => [{ text: "notebook fact" }],
  capture: async (_scope, facts) => facts.length,
  query: async () => [{ text: "notebook hit" }],
  read: async () => "",
};

function ownedBy(url: string, owner: string): MemoryRegistry {
  const registered = putBrain(
    EMPTY_MEMORY_REGISTRY,
    BRAIN,
    {
      preset: "gbrain-v1",
      url: "https://brain.alice.example/mcp",
      clientId: "qm-member",
      clientSecret: "member-secret",
      label: "Alice's brain",
      timeoutMs: 300,
    },
    change,
  );
  const owned = { ...registered, brains: registered.brains.map((brain) => ({ ...brain, url, owner })) };
  return putBinding(owned, BRAIN, { brain: BRAIN, scope: `personal:${owner}`, capture: "explicit" }, change);
}

function serving(record: MemoryRegistry, registryFetch?: AddressFetch) {
  const errors: unknown[] = [];
  const memory = createRegistryMemoryService({
    defaultMemory: notebook,
    registry: { ...emptyMemoryRegistry, current: async () => ({ version: "1", record }) },
    ...(registryFetch ? { registryFetch } : {}),
    onError: (error) => void errors.push(error),
  });
  const search = () =>
    withProviders("search", async (report) =>
      (await memory.query("personal:U1", "bees", 5, { actorId: "U1", audienceScopeId: "personal:U1", report })).map(
        ({ text }) => text,
      ),
    );
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
  for (let waited = 0; brain.openSessions() && waited < 2_000; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(brain.openSessions(), 0);
});

test("a brain that never answers its session end can't hold a call past its deadline", async (t) => {
  for (const [call, expected, endCancelled] of [
    [() => new Promise(() => {}), "rejected", false],
    [() => ({ content: [{ type: "text", text: "bees" }] }), "fulfilled", true],
  ] as const) {
    const brain = await brainServer(t, call);
    const ends: Array<AbortSignal | null | undefined> = [];
    const wedged: AddressFetch = (input, init) => {
      if (init?.method !== "DELETE") return loopbackFetch(input, init);
      ends.push(init.signal);
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    };
    const client = createMcpClient({
      url: brain.url,
      auth: { mode: "client-credentials", clientId: "qm-member", clientSecret: "member-secret" },
      fetch: wedged,
    });
    const outcome = await Promise.race([
      client.callTool("memory_recall", {}, undefined, AbortSignal.timeout(300)).then(
        () => "fulfilled",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(resolve, 1_500, "pending").unref()),
    ]);
    assert.equal(outcome, expected);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]?.aborted, endCancelled);
  }
});

test("a session end the brain trickles is cut off by the call timeout, not kept open by each byte", async (t) => {
  const brain = await startMcpTestServer(t, {
    tools: [{ name: "memory_recall", inputSchema: { type: "object" } }],
    call: () => new Promise(() => {}),
  });
  const ends: Array<{ socket: Socket; closed: boolean }> = [];
  const trickle = netServer((socket) => {
    const end = { socket, closed: false };
    ends.push(end);
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 OK\r\nx-trickle: ");
      const drip = setInterval(() => socket.write("a"), 20);
      socket.once("close", () => {
        clearInterval(drip);
        end.closed = true;
      });
    });
  });
  trickle.listen(0, "127.0.0.1");
  await new Promise((resolve) => trickle.once("listening", resolve));
  t.after(() => {
    for (const { socket } of ends) socket.destroy();
    trickle.close();
  });
  const endpoint = `http://127.0.0.1:${(trickle.address() as AddressInfo).port}/mcp`;
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => timeout(ms / 1_000));
  const client = createMcpClient({
    url: brain.url,
    auth: { mode: "bearer", token: "member-token" },
    fetch: (input, init) => loopbackFetch(init?.method === "DELETE" ? endpoint : input, init),
  });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100).unref();
  await assert.rejects(client.callTool("memory_recall", {}, undefined, stop.signal));
  for (let waited = 0; !ends[0]?.closed && waited < 3_000; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ends.length, 1);
  assert.equal(ends[0]?.closed, true);
});

test("an https brain can't move QM's token request, and the client secret in it, onto http", async () => {
  const origin = "https://brain.alice.example";
  const seen: string[] = [];
  const tls: AddressFetch = async (input) => {
    const url = new URL(input);
    seen.push(url.href);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/`] });
    if (url.pathname.startsWith("/.well-known/"))
      return Response.json({
        issuer: `${origin}/`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: "http://brain.alice.example/token",
        response_types_supported: ["code"],
        grant_types_supported: ["client_credentials"],
      });
    if (url.protocol === "http:") return Response.json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } },
    );
  };
  const brain = serving(ownedBy(`${origin}/mcp`, "U1"), tls);
  assert.deepEqual(
    (await brain.search()).problems.map(({ code }) => code),
    ["memory_provider_failed"],
  );
  assert.ok(seen.some((href) => href.startsWith(`${origin}/.well-known/`)));
  assert.deepEqual(
    seen.filter((href) => href.startsWith("http:")),
    [],
  );
  assert.match(causes(brain.errors[0]), /requests stay on https/);
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
  for (let waited = 0; !closedAt && waited < 2_000; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(closedAt > started && closedAt - started < 1_000, `the stream ran for ${closedAt - started}ms`);
});
