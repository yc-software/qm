import { compactTranscript } from "../src/agent/context-compaction.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryRecallDelta, shownFacts } from "../src/memory/recall-delta.ts";
import { renderFacts, type MemoryFact } from "../src/memory/facts.ts";
import type { SessionEntry } from "../src/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService, type MemoryProviderOutcome, type MemoryService } from "../src/memory/memory-service.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { recallAcrossScopes } from "../src/memory/cross-scope.ts";
import { McpCallError } from "../src/mcp/mcp-client.ts";
import { TimeoutError } from "../src/util/async.ts";
import { reportEnvelope } from "../src/memory/provider-outcome.ts";

const alice = "personal:alice";
const memoryFact = (id: string, text: string): MemoryFact => ({
  id,
  text,
  sensitivity: "ordinary",
  sources: [],
  sourceUnknown: false,
  createdAt: Date.parse("2026-10-01T12:00:00Z"),
  updatedAt: 0,
});
const fact = (id: string, text: string) => ({ scope: alice, id, text: renderFacts([memoryFact(id, text)]) });
const held = (...facts: Array<[string, string]>) =>
  new Map([[alice, shownFacts(facts.map(([id, text]) => memoryFact(id, text)))]]);
const entry = (record: unknown, seq = 1): SessionEntry => ({
  sessionId: "s",
  seq,
  type: "user",
  parentSeq: null,
  createdAt: 1,
  scopeLabel: alice,
  payload: { text: "hello", memoryRecall: JSON.parse(JSON.stringify(record)) },
});
const all = held(["1", "ALPHA"], ["2", "BETA"], ["3", "GAMMA"]);

test("the first recall is complete and an unchanged recall adds nothing", () => {
  const recalled = [fact("1", "ALPHA"), fact("2", "BETA")];
  const first = memoryRecallDelta(recalled, [], all, new Map([[alice, "Alice"]]));
  assert.equal(first.text, "### Alice\n```untrusted-data\n- (2026-10-01) ALPHA\n- (2026-10-01) BETA\n```");
  assert.equal(memoryRecallDelta(recalled, [entry(first.record)], all).text, "");
});

test("later recalls add only new facts, stay silent on held ones and withdraw deleted ones", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA"), fact("2", "BETA")], [], all);
  const second = memoryRecallDelta([fact("3", "GAMMA")], [entry(first.record)], all);
  assert.equal(
    second.text,
    "New or updated memory facts:\n\n### personal:alice\n```untrusted-data\n- (2026-10-01) GAMMA\n```",
  );
  const history = [entry(first.record), entry(second.record, 2)];
  assert.equal(memoryRecallDelta([fact("1", "ALPHA")], history, all).text, "");
  assert.equal(
    memoryRecallDelta([fact("3", "GAMMA")], history, held(["3", "GAMMA"])).text,
    "personal:alice: 2 earlier facts were consolidated or removed; rely only on the current list.",
  );
});

test("an edited fact withdraws its earlier text even when the new text is not selected", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA")], [], held(["1", "ALPHA"]));
  assert.equal(
    memoryRecallDelta([], [entry(first.record)], held(["1", "ALPHA revised"])).text,
    "personal:alice: 1 earlier fact was consolidated or removed; rely only on the current list.",
  );
});

test("withdrawals never quote facts from a notebook that is no longer readable", () => {
  const first = memoryRecallDelta([fact("1", "PRIVATE_FACT")], [], held(["1", "PRIVATE_FACT"]));
  const result = memoryRecallDelta([], [entry(first.record)], new Map());
  assert.doesNotMatch(result.text, /PRIVATE_FACT|personal:alice/);
  assert.match(result.text, /no longer included/);
});

test("display labels never change the stored checkpoint or earlier bytes", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA")], [], all, new Map([[alice, "Alice"]]));
  const history = [entry(first.record)];
  const before = JSON.stringify(history);
  const next = memoryRecallDelta([fact("1", "ALPHA"), fact("2", "BETA")], history, all, new Map([[alice, "Al"]]));
  assert.equal(next.text, "New or updated memory facts:\n\n### Al\n```untrusted-data\n- (2026-10-01) BETA\n```");
  assert.equal(JSON.stringify(history), before);
});

test("compacting away the recall anchor restores a current baseline", () => {
  const first = memoryRecallDelta([fact("1", "ALPHA")], [], all);
  const history = [entry({ ...first.record, anchorSeq: 1 }, 8)];
  assert.match(memoryRecallDelta([fact("1", "ALPHA")], history, all).text, /ALPHA/);
});

test("recall checkpoint metadata never leaks into attachment-only compaction input", () => {
  const recorded = entry(memoryRecallDelta([fact("1", "CHECKPOINT_ONLY_FACT")], [], all).record);
  recorded.payload = { ...(recorded.payload as Record<string, unknown>), text: "", environment: "file: report.csv" };
  const text = compactTranscript([recorded]);
  assert.match(text, /report.csv/);
  assert.doesNotMatch(text, /CHECKPOINT_ONLY_FACT|memoryRecall/);
});

test("id-less provider lines inject only new lines over 20 turns, and timeouts or denials never claim removal", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "recall-delta-provider-")));
  const notebook = createMemoryService(workspace);
  await workspace.ensureScope(alice);
  await notebook.capture(alice, ["NOTEBOOK_FACT prefers terse replies"], Date.parse("2026-10-01T12:00:00Z"));
  const line = (i: number) => `provider line ${i}: ${"detail ".repeat(6).trim()}`;
  let window = 0;
  let failure: Error | undefined;
  let unlinked = false;
  const knowledge: MemoryService = {
    async recall() {
      if (failure) throw failure;
      if (unlinked) {
        reportEnvelope({ code: "actor_unlinked" });
        return [];
      }
      return [{ text: Array.from({ length: 6 }, (_, k) => line(window + k)).join("\n"), score: 0.2 }];
    },
    async capture() {
      return 0;
    },
    async query() {
      return [];
    },
    async read() {
      return "";
    },
  };
  const memory = createRoutedMemoryService({
    providers: { default: notebook, knowledge },
    routes: [
      { provider: "default", scopes: ["personal"] },
      { provider: "knowledge", scopes: ["personal"], manage: false, label: "Knowledge", failOpen: true },
    ],
  });
  const labels = new Map([[alice, "Alice"]]);
  const history: SessionEntry[] = [];
  const turn = async () => {
    const outcomes: MemoryProviderOutcome[] = [];
    const report = (outcome: MemoryProviderOutcome) => void outcomes.push(outcome);
    const recalled = await recallAcrossScopes(memory, [alice], { query: "q", report }, labels);
    const held = new Map([[alice, shownFacts((await notebook.facts!(alice)) ?? [])]]);
    const delta = memoryRecallDelta(recalled, history, held, labels, outcomes);
    history.push(entry(delta.record, history.length + 1));
    return delta.text;
  };
  const block = (...lines: string[]) => `### Alice · Knowledge\n\`\`\`untrusted-data\n${lines.join("\n")}\n\`\`\``;

  const first = await turn();
  assert.match(first, /NOTEBOOK_FACT/);
  assert.ok(first.includes(block(...Array.from({ length: 6 }, (_, k) => line(k)))));
  const later: number[] = [];
  for (window = 1; window < 20; window++) {
    const text = await turn();
    assert.equal(text, `New or updated memory facts:\n\n${block(line(window + 5))}`);
    later.push(text.length);
  }
  assert.ok(Math.max(...later) / 4 < 40, `each later turn stays under 40 tokens: ${later.join(",")}`);

  window = 19;
  failure = new TimeoutError("memory provider timed out after 3000ms");
  assert.equal(await turn(), "");
  failure = undefined;
  assert.equal(await turn(), "");

  failure = new McpCallError("mcp tools/call failed (HTTP 403)", { status: 403 });
  assert.equal(
    await turn(),
    "Some previously recalled memory sources are no longer included. Do not rely on memory from sources that are not currently authorized.",
  );
  failure = undefined;
  const restored = await turn();
  assert.ok(restored.includes(block(...Array.from({ length: 6 }, (_, k) => line(window + k)))));
  assert.doesNotMatch(restored, /NOTEBOOK_FACT|consolidated or removed/);

  unlinked = true;
  assert.equal(
    await turn(),
    "Some previously recalled memory sources are no longer included. Do not rely on memory from sources that are not currently authorized.",
  );
});
