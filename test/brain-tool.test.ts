import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "../src/agent/agent.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { turnToolRef } from "../src/agent/turn-open.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { turnAuthority } from "../src/memory/memory-service.ts";
import type { TurnRequest } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";
import type { AddressFetch } from "../src/util/network.ts";
import { buildApp } from "./support/build-app.ts";
import { contract, contractTools } from "./support/gbrain-contract.ts";
import { routedTo, startMcpTestServer } from "./support/mcp-test-server.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

type Row = Record<string, unknown>;
type Step = { search: string } | { call: { server?: string; tool: string; args?: Row } } | "revoke";
interface Call {
  tool: string;
  args: Row;
  actor?: string;
}

const HOT_MEMORY = "Alice prefers morning meetings before 10am.";
const LOOKUPS = contract.personal_tools.tools.filter(({ mutating }) => !mutating).map(({ name }) => name);
const PRIYA = { slug: "people/priya-raman", source_id: "default", title: "Priya Raman", type: "person" };

function gbrainAnswer(tool: string, args: Row): CallToolResult {
  const structured = { tool, args, results: [PRIYA] };
  return {
    structuredContent: structured,
    content: [
      { type: "text", text: JSON.stringify(structured) },
      { type: "text", text: "[gbrain degraded: embed_unavailable] partial" },
    ],
    _meta: { brain_hot_memory: HOT_MEMORY },
  };
}

async function gbrain(t: { after(fn: () => Promise<void>): void }) {
  const calls: Call[] = [];
  const failures = new Map<string, CallToolResult | number>();
  const server = await startMcpTestServer(t, {
    tools: contractTools.map(({ name, description, mutating, input_schema }) => ({
      name,
      description,
      inputSchema: input_schema,
      annotations: { readOnlyHint: !mutating },
    })),
    clients: { qm: "brain-secret" },
    call: async (tool, args, _authorization, actor) => {
      calls.push({ tool, args, ...(actor ? { actor } : {}) });
      if (tool === "memory_recall") return { content: [] };
      const failure = failures.get(String(args.query));
      if (typeof failure === "number") await sleep(failure);
      else if (failure) return failure;
      return gbrainAnswer(tool, args);
    },
  });
  return Object.assign(server, { calls, failures });
}

async function brainApp(t: { after(fn: () => Promise<void>): void }) {
  const acme = await gbrain(t);
  const script: Step[] = [];
  const runs: Array<{ prompt: string; texts: string[] }> = [];
  const mock = createMockAgent();
  const agent: Agent = {
    ...mock,
    async runTurn(input) {
      const tools = createAgentTools(turnToolRef(input), input.mcpTools?.length ? { mcpTools: input.mcpTools } : {});
      const run = { prompt: input.systemPrompt, texts: [] as string[] };
      runs.push(run);
      if (!script.length) return mock.runTurn(input);
      await input.emit({ kind: "UserMessage", text: input.input, author: input.runtimeActorId ?? null, body: {} });
      for (const step of script.splice(0)) {
        if (step === "revoke") {
          await admin("DELETE", "/v1/admin/memory-registry/bindings/acme");
          continue;
        }
        const tool = tools.find(({ name }) => name === ("search" in step ? "tool_search" : "mcp_call"));
        if (!tool) {
          run.texts.push("[no connector tools]");
          continue;
        }
        const params = "search" in step ? { query: step.search } : step.call;
        const result = await tool.execute(randomUUID(), params as never, undefined, undefined, {} as never);
        run.texts.push(result.content.map((block) => ("text" in block ? block.text : "")).join("\n"));
      }
      await input.emit({ kind: "AgentMessage", text: "done" });
      return { reply: "done", modelCalls: 1 };
    },
  };
  const memoryRegistryFetch: AddressFetch = routedTo(acme.url);
  const built = buildApp(testConfig(), { memoryRegistryFetch, agent });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    memory: built.memory,
    memoryRegistry: built.memoryRegistry,
    capabilitySecret: TEST_CAPABILITY_SECRET,
  });
  server.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}${path}`, {
      method,
      headers: { "x-admin-actor": "admin-alice@default-org", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(res.status, 200, await res.text());
  };
  await admin("PUT", "/v1/admin/memory-registry/brains/acme", {
    preset: "gbrain-v1",
    url: "https://brain.acme.example/mcp",
    clientId: "qm",
    clientSecret: "brain-secret",
    label: "Acme brain",
    timeoutMs: 400,
  });
  await admin("PUT", "/v1/admin/memory-registry/bindings/acme", {
    brain: "acme",
    scope: "personal",
    capture: "explicit",
  });
  const turn = async (steps: Step[], request: Partial<TurnRequest> = {}) => {
    script.splice(0, script.length, ...steps);
    const before = runs.length;
    await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `dm:U1:${randomUUID()}` },
      text: "Prep me for Priya.",
      origin: { kind: "human" },
      ...request,
    });
    return runs.length > before ? runs.at(-1)! : undefined;
  };
  return { built, acme, turn };
}

const lookups = (brain: { calls: Call[] }) => brain.calls.filter(({ tool }) => tool !== "memory_recall");
const listings = (brain: { requests: Array<{ rpc?: string }> }) =>
  brain.requests.filter(({ rpc }) => rpc === "tools/list").length;
const whois = { call: { server: "acme", tool: "whois", args: { query: "Priya Raman" } } };

test("the person's own DM gets each brain's read-only tools through the connector bridge, called as them with the arguments as sent", async (t) => {
  const { acme, turn } = await brainApp(t);
  const run = (await turn([
    { search: "whois" },
    { call: { server: "acme", tool: "get_page", args: { slug: PRIYA.slug, include_deleted: true } } },
  ]))!;
  const listed = [...run.prompt.matchAll(/^ {2}- (\w+)/gm)].map(([, name]) => name);
  assert.deepEqual(listed.toSorted(), LOOKUPS.toSorted());
  assert.match(run.prompt, /^- Acme brain \[acme\] /m);
  const found = JSON.parse(run.texts[0]!.split("\n\n")[0]!) as Row;
  assert.deepEqual(
    { server: found.server, tool: found.tool, parameters: found.parameters },
    {
      server: "acme",
      tool: "whois",
      parameters: contract.personal_tools.tools.find(({ name }) => name === "whois")!.input_schema,
    },
  );
  assert.deepEqual(lookups(acme), [
    { tool: "get_page", args: { slug: PRIYA.slug, include_deleted: true }, actor: "U1" },
  ]);
  assert.match(run.texts[1]!, /"include_deleted":true[\s\S]*\[gbrain degraded: embed_unavailable\] partial/);
  assert.doesNotMatch(run.texts[1]!, /morning meetings/);
});

test("turns the person didn't send in their own DM never list, find or call the brain's tools", async (t) => {
  const { acme, turn } = await brainApp(t);
  const others: Array<Partial<TurnRequest>> = [
    { origin: { kind: "automation" } },
    {
      conversation: {
        kind: "group",
        threadRef: "G1",
        channelRef: "G1",
        isMpim: true,
        audience: [{ externalId: "U1" }, { externalId: "U2" }],
      },
    },
    { conversation: { kind: "channel", threadRef: "C1", channelRef: "C1" } },
    { actor: { externalId: "system:ambient:default-org" } },
  ];
  for (const request of others) {
    const run = (await turn([{ search: "*" }, whois], request))!;
    assert.doesNotMatch(run.prompt, /\[acme\]/, JSON.stringify(request));
    assert.deepEqual(run.texts, ["[no connector tools]", "[no connector tools]"], JSON.stringify(request));
  }
  assert.equal(listings(acme), 0);
  assert.deepEqual(lookups(acme), []);
  assert.match((await turn([]))!.prompt, /\[acme\]/);
  assert.equal(listings(acme), 1);
});

test("a lookup checks the person and the live binding when it runs, and sends nothing otherwise", async (t) => {
  const { built, acme, turn } = await brainApp(t);
  await assert.rejects(
    built.memory.lookup!("personal:U1", "acme:whois", { query: "Priya Raman" }, turnAuthority("U1", undefined), {
      audienceScopeId: "personal:U1",
    }),
    /^Error: \[brain_refused\] Only the person/,
  );
  const run = (await turn(["revoke", whois]))!;
  assert.match(run.texts[0]!, /^\[error\] no brain is connected to this conversation$/);
  assert.deepEqual(lookups(acme), []);
});

test("a lookup outlasts recall's timeout, and a refusal or failure answers with what to do next and the brain's own words", async (t) => {
  const { acme, turn } = await brainApp(t);
  const refusal = (code: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ code, message: `refused with ${code}` }) }],
  });
  acme.failures.set("slow", 600);
  acme.failures.set("Nobody", refusal("actor_unlinked"));
  acme.failures.set("Unlisted", refusal("actor_not_attested"));
  acme.failures.set("Broken", { isError: true, content: [{ type: "text", text: "search index is rebuilding" }] });
  const ask = (query: string) => ({ call: { server: "acme", tool: "query", args: { query } } });
  const { texts } = (await turn([ask("slow"), ask("Nobody"), ask("Unlisted"), ask("Broken")]))!;
  assert.match(texts[0]!, /"query":"slow"/);
  assert.match(
    texts[1]!,
    /^\[error\] \[memory_provider_denied\] .*Link this member's QM principal id[\s\S]*refused with actor_unlinked/,
  );
  assert.match(
    texts[2]!,
    /^\[error\] \[memory_provider_denied\] Memory provider acme refused query \(actor_not_attested\).*attest query with --attest-ops[\s\S]*refused with actor_not_attested/,
  );
  assert.match(texts[3]!, /^\[error\] \[memory_provider_failed\][\s\S]*search index is rebuilding/);
});

test("strict posture holds a brain lookup for approval, and dangerous runs it", async (t) => {
  const { built, acme, turn } = await brainApp(t);
  await built.config.setSecurityPosture("personal:U1", "strict");
  assert.match((await turn([whois]))!.texts[0]!, /needs human approval/);
  assert.deepEqual(lookups(acme), []);
  await built.config.setSecurityPosture("personal:U1", "dangerous");
  assert.match((await turn([whois]))!.texts[0]!, /"query":"Priya Raman"/);
});
