import assert from "node:assert/strict";
import { test } from "node:test";
import { withTapedEntryMirrors } from "../src/harness/harness-shared.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewTapeRecord } from "../src/sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

const scope = "personal:mirror@example.com" as ScopeId;

function stubTurn(taped: NewTapeRecord[] | null): HarnessTurnInput {
  let seq = 0;
  return {
    emit: async (entry: { type: SessionEntry["type"]; payload: unknown; scopeLabel: ScopeId }) =>
      ({
        ...entry,
        sessionId: "s1",
        seq: seq++,
        parentSeq: null,
        createdAt: 1000 + seq,
      }) as SessionEntry,
    ...(taped
      ? {
          tape: async (rec: NewTapeRecord) => {
            taped.push(rec);
          },
        }
      : {}),
    scopeLabel: scope,
  } as unknown as HarnessTurnInput;
}

test("withTapedEntryMirrors tapes one mirror annotation per emitted entry", async () => {
  const taped: NewTapeRecord[] = [];
  const turn = withTapedEntryMirrors(stubTurn(taped));
  const user = await turn.emit({ type: "user", payload: { text: "hi" }, scopeLabel: scope });
  const call = await turn.emit({
    type: "tool_call",
    payload: { tool: "execute", command: "ls", callId: "c1" },
    scopeLabel: scope,
  });
  assert.equal(taped.length, 2);
  assert.deepEqual(taped[0], {
    kind: "annotation",
    payload: { entry: { type: "user", payload: { text: "hi" }, at: user.createdAt } },
    scopeLabel: scope,
    entrySeq: user.seq,
  });
  assert.equal(taped[1]!.entrySeq, call.seq);
  assert.equal((taped[1]!.payload as { entry: { type: string } }).entry.type, "tool_call");
});

test("withTapedEntryMirrors mirrors with the entry's own scope label", async () => {
  const taped: NewTapeRecord[] = [];
  const turn = withTapedEntryMirrors(stubTurn(taped));
  const otherScope = "personal:someone-else@example.com" as ScopeId;
  await turn.emit({
    type: "tool_result",
    payload: { tool: "gmail", callId: "c2", isError: false, result: "inbox" },
    scopeLabel: otherScope,
  });
  assert.equal(taped[0]!.scopeLabel, otherScope);
});

test("withTapedEntryMirrors is a no-op without a tape", async () => {
  const turn = stubTurn(null);
  assert.equal(withTapedEntryMirrors(turn), turn);
});

test("a failed mirror write is swallowed, not surfaced through emit", async () => {
  const base = stubTurn([]);
  const turn = withTapedEntryMirrors({
    ...base,
    tape: async () => {
      throw new Error("tape unavailable");
    },
  } as HarnessTurnInput);
  const saved = await turn.emit({ type: "user", payload: { text: "still lands" }, scopeLabel: scope });
  assert.equal((saved.payload as { text: string }).text, "still lands");
});

test("the harness router mirrors for foreign adapters and leaves native-tape adapters alone", async () => {
  const { createHarnessRouter } = await import("../src/harness/harness-router.ts");
  const seen: Record<string, number> = {};
  const adapterFor = (id: string, capabilities: string[]) =>
    ({
      profile: { id, capabilities: new Set(capabilities) },
      turns: {
        async runTurn(input: HarnessTurnInput) {
          await input.emit({ type: "user", payload: { text: "hi" }, scopeLabel: scope });
          return { reply: "ok" };
        },
      },
    }) as never;
  const adapters = new Map<string, never>([
    ["pi", adapterFor("pi", ["native-tape"])],
    ["codex", adapterFor("codex", [])],
  ]);
  const router = createHarnessRouter(
    adapters as never,
    adapters.get("pi")!,
    (input) => ({ harnessId: (input as { runtime?: { harnessId?: string } }).runtime?.harnessId ?? "pi" }) as never,
  );
  for (const harnessId of ["pi", "codex"]) {
    const taped: NewTapeRecord[] = [];
    const base = stubTurn(taped);
    await router.turns.runTurn({
      ...base,
      session: { id: `s-${harnessId}` },
      runtime: { harnessId },
    } as unknown as HarnessTurnInput);
    seen[harnessId] = taped.length;
  }
  assert.equal(seen.pi, 0);
  assert.equal(seen.codex, 1);
});
