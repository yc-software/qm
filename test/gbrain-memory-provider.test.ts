import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Errors } from "typebox/value";
import { installPrincipalLinks } from "../src/directory/person.ts";
import type { MemoryProviderOutcome, MemoryService } from "../src/memory/memory-service.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import { createConfiguredMemoryService } from "../src/memory/provider-factory.ts";
import { withProviders, writeFacts } from "../src/memory/provider-outcome.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";

const contract = JSON.parse(
  readFileSync(new URL("./fixtures/gbrain/qm-memory-provider-v1.json", import.meta.url), "utf8"),
) as {
  tools: Array<{
    name: string;
    description: string;
    mutating: boolean;
    input_schema: Tool["inputSchema"] & { properties: Record<string, unknown> };
  }>;
  actor: { header: string; argument: string; actor_id: { pattern: string } };
  memory_recall: { limits: { max_chars: { min: number; max: number } } };
  unlinked_recall: CallToolResult;
  memory_write: {
    limits: { facts: { min: number; max: number }; provenance_chars: number; idempotency_key: string };
    committed: { content: string };
    pending: { content: string };
  };
  errors: { codes: Array<{ code: string; class: string; summary: string; reasons?: Array<{ reason: string }> }> };
};

const guide = readFileSync(new URL("../docs/memory-providers.md", import.meta.url), "utf8");
const recipe = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(guide.split("\n## gbrain\n")[1] ?? "")?.[1] ?? "null") as {
  providers: Array<Record<string, unknown>>;
  routes: unknown[];
};

const SECRETS = {
  GBRAIN_RO_CLIENT_ID: "ro",
  GBRAIN_RO_CLIENT_SECRET: "x",
  GBRAIN_RW_CLIENT_ID: "rw",
  GBRAIN_RW_CLIENT_SECRET: "y",
};
const JORDAN = "personal:U0JORDAN";

interface Call {
  name: string;
  args: Record<string, unknown>;
  actor?: string;
}

async function gbrain(
  t: { after(fn: () => Promise<void>): void },
  answer: (name: string, args: Record<string, unknown>) => CallToolResult,
) {
  installPrincipalLinks({
    canonical: (key) => (key === "jordan@acme.example" || key === "U0JORDAN" ? "U0JORDAN" : undefined),
    aliases: () => [],
  });
  t.after(async () => installPrincipalLinks(null));
  const calls: Call[] = [];
  const server = await startMcpTestServer(t, {
    tools: contract.tools.map(({ name, description, input_schema }) => ({
      name,
      description,
      inputSchema: input_schema,
    })),
    clients: { ro: "x", rw: "y" },
    stateless: true,
    json: true,
    call: (name, args, _authorization, actor) => {
      calls.push({ name, args, ...(actor ? { actor } : {}) });
      return answer(name, args);
    },
  });
  const notebookWrites: string[] = [];
  const notebook: MemoryService = {
    async recall() {
      return [{ text: "notebook fact", score: 0.2 }];
    },
    async capture(_scope, facts) {
      notebookWrites.push(...facts);
      return facts.length;
    },
    async query() {
      return [];
    },
    async read() {
      return "";
    },
  };
  const memory = createConfiguredMemoryService({
    defaultMemory: notebook,
    config: parseMemoryProviderConfig(
      JSON.stringify({ ...recipe, providers: [{ ...recipe.providers[0], url: server.url }] }),
      SECRETS,
    ),
    onError: () => {},
  });
  return { server, calls, memory, notebookWrites };
}

function violations({ name, args }: Call): string[] {
  const tool = contract.tools.find((entry) => entry.name === name);
  if (!tool) return [`${name} is not a contract tool`];
  const undeclared = tool.mutating ? Object.keys(args).filter((key) => !(key in tool.input_schema.properties)) : [];
  return [
    ...[...Errors(tool.input_schema, args)].map(({ instancePath, message }) => `${name}${instancePath} ${message}`),
    ...undeclared.map((key) => `${name}/${key} is not declared, and gbrain refuses unknown arguments to a write`),
  ];
}

const gbrainOutcomes = (outcomes: readonly MemoryProviderOutcome[]) =>
  outcomes
    .filter(({ provider }) => provider === "gbrain")
    .map(({ outcome, code }) => (code ? `${outcome}:${code}` : outcome));
const recallLines = (facts: Array<{ text: string; date: string; kind: string }>) =>
  facts.map(({ text, date, kind }) => `- ${text} (${date}; ${kind})`).join("\n");
const committed = (n: number, requestId: string): CallToolResult => ({
  content: [{ type: "text", text: contract.memory_write.committed.content.replace("<N>", String(n)) }],
  structuredContent: { status: "committed", request_id: requestId, fact_ids: ["43"] },
});
const refusal = (code: string, reason?: string): CallToolResult => {
  const { summary } = contract.errors.codes.find((entry) => entry.code === code) ?? { summary: "" };
  const error = { code, message: summary, ...(reason ? { reason } : {}) };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ...error, suggestion: "" }) }],
    structuredContent: { error },
  };
};

test("the documented gbrain recipe keeps the notebook first everywhere and sends only personal turns to gbrain", async (t) => {
  const facts = [{ text: "Prefers aisle seats", date: "2026-10-30", kind: "preference" }];
  const { calls, memory, notebookWrites } = await gbrain(t, (name) =>
    name === "memory_recall"
      ? { content: [{ type: "text", text: recallLines(facts) }], structuredContent: { facts, truncated: false } }
      : committed(1, "8c1f7a0e-0000-5000-8000-000000000001"),
  );

  const answered: Record<string, string[]> = {};
  for (const scope of ["personal:U0JORDAN", "channel:C0ROOM", "group:G0CREW", "team:T0ACME", "org:acme"]) {
    const { outcomes } = await withProviders("search", (report) =>
      memory.recall(scope, { query: "seats", actorId: "U0JORDAN", maxChars: 6000, report }),
    );
    answered[scope] = outcomes.map(({ provider, scope: answeredScope }) => `${provider}@${answeredScope}`).sort();
  }
  assert.deepEqual(answered, {
    "personal:U0JORDAN": ["default@personal:U0JORDAN", "gbrain@personal:U0JORDAN"],
    "channel:C0ROOM": ["default@channel:C0ROOM"],
    "group:G0CREW": ["default@group:G0CREW"],
    "team:T0ACME": ["default@team:T0ACME"],
    "org:acme": ["default@org:acme"],
  });

  await memory.capture(JORDAN, ["Prefers window seats"], 1, "U0JORDAN", { mode: "automatic", actorId: "U0JORDAN" });
  assert.deepEqual(notebookWrites, ["Prefers window seats"]);
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["memory_recall"],
  );
});

test("QM's gbrain requests satisfy the vendored contract's tools and actor rules", async (t) => {
  const { server, calls, memory } = await gbrain(t, (name) =>
    name === "memory_recall"
      ? { content: [{ type: "text", text: "" }], structuredContent: { facts: [], truncated: false } }
      : committed(1, "8c1f7a0e-0000-5000-8000-000000000002"),
  );
  const context = { mode: "explicit" as const, actorId: "jordan@acme.example", conversationScopeId: JORDAN };
  await withProviders("search", (report) =>
    memory.recall(JORDAN, { query: "seats", actorId: "jordan@acme.example", maxChars: 6000, report }),
  );
  await writeFacts(memory, JORDAN, ["Prefers aisle seats", "Takes notes by hand"], "U0JORDAN", context, "run-1");
  await writeFacts(memory, JORDAN, ["Prefers aisle seats", "Takes notes by hand"], "U0JORDAN", context, "run-1");
  await writeFacts(memory, JORDAN, ["Prefers aisle seats", "Takes notes by hand"], "U0JORDAN", context, undefined);

  const [recall, ...writes] = calls;
  assert.deepEqual(calls.flatMap(violations), []);
  assert.equal(recall?.name, "memory_recall");
  const maxChars = Number(recall?.args.max_chars);
  const { min, max } = contract.memory_recall.limits.max_chars;
  assert.ok(maxChars >= min && maxChars <= max, `max_chars ${maxChars} is outside ${min}-${max}`);

  assert.deepEqual(
    calls.map(({ actor, args }) => [actor, args[contract.actor.argument]]),
    Array(4).fill(["U0JORDAN", "U0JORDAN"]),
  );
  const sent = server.requests.filter(({ rpc }) => rpc).map(({ actor }) => actor);
  assert.deepEqual(new Set(sent), new Set(["U0JORDAN"]));
  for (const actor of sent) assert.match(String(actor), new RegExp(contract.actor.actor_id.pattern));
  assert.deepEqual(
    server.requests.filter(({ method }) => method === "DELETE"),
    [],
  );

  const { limits } = contract.memory_write;
  const keys = writes.map(({ args }) => String(args.idempotency_key));
  for (const key of keys) assert.match(key, new RegExp(limits.idempotency_key));
  assert.equal(keys[1], keys[0]);
  assert.notEqual(keys[2], keys[0]);
  for (const { args } of writes) {
    const facts = args.facts as Array<{ fact: string; provenance: string }>;
    assert.ok(facts.length >= limits.facts.min && facts.length <= limits.facts.max);
    assert.deepEqual(
      facts.map(({ fact }) => fact),
      ["Prefers aisle seats", "Takes notes by hand"],
    );
    for (const { provenance } of facts) {
      assert.ok(provenance.length >= 1 && provenance.length <= limits.provenance_chars);
      assert.doesNotMatch(provenance, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|^qm:/i);
    }
  }
});

test("gbrain's answers and refusals become the outcomes the contract classes them as", async (t) => {
  const facts = [
    { id: "41", text: "Prefers aisle seats", date: "2026-10-30", kind: "preference" },
    { id: "42", text: "Takes notes by hand", date: "2026-10-31", kind: "commitment" },
  ];
  let answer: CallToolResult = { content: [] };
  const { memory } = await gbrain(t, () => answer);
  const recall = async (result: CallToolResult) => {
    answer = result;
    const { value, outcomes } = await withProviders("search", (report) =>
      memory.recall(JORDAN, { query: "seats", actorId: "U0JORDAN", maxChars: 6000, report }),
    );
    const rows = (value ?? []).filter(({ source }) => source?.provider === "gbrain").map(({ text }) => text);
    return { outcome: gbrainOutcomes(outcomes).join(","), rows };
  };

  assert.deepEqual(
    await recall({
      content: [{ type: "text", text: recallLines(facts) }],
      structuredContent: { facts, truncated: false },
    }),
    { outcome: "ok", rows: recallLines(facts).split("\n") },
  );
  assert.deepEqual(
    await recall({ content: [{ type: "text", text: "" }], structuredContent: { facts: [], truncated: false } }),
    { outcome: "empty", rows: [] },
  );
  assert.deepEqual(await recall(contract.unlinked_recall), { outcome: "empty:actor_unlinked", rows: [] });

  const expected = (code: string, cls: string) => `${cls === "host_only" ? "denied" : "failed"}:${code}`;
  for (const { code, class: cls, reasons } of contract.errors.codes)
    for (const reason of reasons?.map((entry) => entry.reason) ?? [undefined])
      assert.deepEqual(
        await recall(refusal(code, reason)),
        { outcome: expected(code, cls), rows: [] },
        `${code}/${reason}`,
      );

  const write = async (result: CallToolResult) => {
    answer = result;
    const { outcomes } = await writeFacts(
      memory,
      JORDAN,
      ["Prefers aisle seats"],
      "U0JORDAN",
      {
        mode: "explicit",
        actorId: "U0JORDAN",
      },
      "run-1",
    );
    return gbrainOutcomes(outcomes).join(",");
  };
  assert.equal(await write(committed(1, "8c1f7a0e-0000-5000-8000-000000000003")), "committed");
  assert.equal(
    await write({
      content: [{ type: "text", text: contract.memory_write.pending.content.replace("<N>", "1").replace("<M>", "1") }],
      structuredContent: {
        status: "pending",
        request_id: "8c1f7a0e-0000-5000-8000-000000000004",
        fact_ids: [],
        pending_request_ids: ["8c1f7a0e-0000-5000-8000-000000000005"],
      },
    }),
    "pending",
  );
  for (const { code, class: cls } of contract.errors.codes.filter(
    ({ code }) => code !== "on_behalf_of_invalid_audience",
  ))
    assert.equal(await write(refusal(code)), expected(code, cls), code);
});

test("an attested gbrain write never speaks for anyone but the turn's member", async (t) => {
  const { calls, memory, notebookWrites } = await gbrain(t, () => committed(1, "8c1f7a0e-0000-5000-8000-000000000006"));
  const { outcomes } = await writeFacts(
    memory,
    "personal:U0ALICE",
    ["Onboarding: completed v1"],
    "U0ADMIN",
    { mode: "explicit" },
    undefined,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(notebookWrites, ["Onboarding: completed v1"]);
  assert.deepEqual(gbrainOutcomes(outcomes), []);
});
