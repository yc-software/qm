import { test } from "node:test";
import assert from "node:assert/strict";
import { screenChunks } from "../src/core/orchestrator/security-screen.ts";
import type { SecurityScreenVerdict } from "../src/security/security-posture.ts";

const clean: SecurityScreenVerdict = { decision: "auto" };
const strict: SecurityScreenVerdict = { decision: "strict", reason: "injection" };
const failedOpen: SecurityScreenVerdict = { decision: "auto", unscreened: true };

function screener(verdicts: Record<string, SecurityScreenVerdict | undefined>) {
  const seen: string[] = [];
  return {
    seen,
    classify: async (chunk: string) => {
      seen.push(chunk);
      return verdicts[chunk];
    },
  };
}

test("every chunk clean is clean", async () => {
  const { classify, seen } = screener({ a: clean, b: clean });
  assert.deepEqual(await screenChunks(["a", "b"], classify), clean);
  assert.deepEqual(seen, ["a", "b"]);
});

test("nothing to screen is clean", async () => {
  assert.deepEqual(await screenChunks([], async () => strict), { decision: "auto" });
});

test("a strict chunk wins over an earlier failed-open chunk and stops screening", async () => {
  const { classify, seen } = screener({ a: failedOpen, b: strict, c: clean });
  assert.deepEqual(await screenChunks(["a", "b", "c"], classify), strict);
  assert.deepEqual(seen, ["a", "b"]);
});

test("a failed-open or missing verdict makes the whole result unscreened", async () => {
  for (const verdict of [failedOpen, undefined]) {
    const { classify, seen } = screener({ a: verdict, b: clean });
    const result = await screenChunks(["a", "b"], classify);
    assert.equal(result.decision, "auto");
    assert.equal(result.unscreened, true);
    assert.deepEqual(seen, ["a", "b"], "screening continues past an unscreened chunk by default");
  }
});

test("stopUnclean stops at the first chunk that is not clean", async () => {
  const { classify, seen } = screener({ a: failedOpen, b: strict });
  const result = await screenChunks(["a", "b"], classify, { stopUnclean: true });
  assert.equal(result.unscreened, true);
  assert.deepEqual(seen, ["a"]);
});

test("batches screen in parallel and stop after the batch holding a strict verdict", async () => {
  const { classify, seen } = screener({ a: clean, b: strict, c: clean, d: clean, e: clean });
  assert.deepEqual(await screenChunks(["a", "b", "c", "d", "e"], classify, { batch: 2 }), strict);
  assert.deepEqual(seen, ["a", "b"]);
});

test("an aborted signal stops screening before the next chunk", async () => {
  const abort = new AbortController();
  const seen: string[] = [];
  const pending = screenChunks(
    ["a", "b"],
    async (chunk) => {
      seen.push(chunk);
      abort.abort(new Error("cancelled"));
      return clean;
    },
    { signal: abort.signal },
  );
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(seen, ["a"]);
});
