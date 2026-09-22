import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { SecurityScreener } from "../src/security/security-screener.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const databaseUrl = process.env.DATABASE_URL;
const actor = { externalId: "U1" };

function channel(
  threadRef: string,
  overheard: TurnRequest["overheard"],
  extra: Partial<TurnRequest> = {},
): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "channel", threadRef, channelRef: "C862", audience: [actor] },
    text: "summarize the thread",
    overheard,
    ...extra,
  };
}

const screener: SecurityScreener = {
  provider: "taint-regression",
  shadow: false,
  async classify({ payload }) {
    const sources = JSON.parse(payload) as Array<{ content: string }>;
    const aggregate = sources.length > 1;
    if (!aggregate && sources[0]?.content.includes("screen-error")) throw new Error("screen failed");
    const strict = aggregate || payload.includes("flagged-source");
    return {
      verdict: strict ? { decision: "strict", reason: "test verdict" } : { decision: "auto" },
      score: strict ? 1 : 0,
      threshold: 0.5,
    };
  },
};

test(
  "mixed source taint stays attributed across Postgres history and later thread imports",
  { skip: databaseUrl ? false : "set DATABASE_URL to a disposable Postgres database" },
  async () => {
    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "qm-taint-")),
        databaseUrl,
        sessionStore: "postgres",
        backgroundWorkEnabled: false,
      }),
      { securityScreener: screener },
    );
    const mixed = [
      { ts: "862.1", role: "user" as const, name: "Alice", text: "clean-source" },
      { ts: "862.2", role: "user" as const, name: "Mallory", text: "flagged-source" },
    ];
    try {
      for (const suffix of ["first", "later"]) {
        const result = await built.app.turn(channel(`ch:C862:${suffix}-${Date.now()}`, mixed));
        assert.equal(result.status, "pending_approval");
        const entries = await built.sessions.getEntries(result.sessionId!);
        const clean = entries.find((entry) => (entry.payload as { ts?: string }).ts === "862.1");
        const flagged = entries.find((entry) => (entry.payload as { ts?: string }).ts === "862.2");
        assert.deepEqual(clean?.payload, {
          overheard: true,
          ts: "862.1",
          name: "Alice",
          text: "clean-source",
        });
        assert.equal((flagged?.payload as { securityTainted?: boolean }).securityTainted, true);
        const tape = await built.sessions.getTape(result.sessionId!);
        const cleanTape = tape.find((row) => row.meta?.ts === "862.1");
        const flaggedTape = tape.find((row) => row.meta?.ts === "862.2");
        assert.equal(cleanTape?.meta?.overheard, true);
        assert.equal(cleanTape?.meta?.author, "Alice");
        assert.notEqual(cleanTape?.meta?.securityTainted, true);
        assert.equal(flaggedTape?.meta?.securityTainted, true);
      }

      const triggered = await built.app.turn(
        channel(
          `ch:C862:triggered-${Date.now()}`,
          [{ ts: "862.7", role: "user", name: "Alice", text: "clean-triggered-history" }],
          { surface: "webhook", triggered: true, securityScreenData: "flagged-source" },
        ),
      );
      assert.equal(triggered.status, "pending_approval");
      assert.match(triggered.pendingApprovals?.[0]?.reason ?? "", /flagged sources: webhook/);
      assert.doesNotMatch(triggered.pendingApprovals?.[0]?.reason ?? "", /overheard/);
      const triggeredEntries = await built.sessions.getEntries(triggered.sessionId!);
      const triggeredClean = triggeredEntries.find((entry) => (entry.payload as { ts?: string }).ts === "862.7");
      assert.notEqual((triggeredClean?.payload as { securityTainted?: boolean }).securityTainted, true);

      for (const [suffix, messages] of [
        [
          "ambiguous",
          [
            { ts: "862.3", role: "user" as const, text: "clean-one" },
            { ts: "862.4", role: "user" as const, text: "clean-two" },
          ],
        ],
        [
          "error",
          [
            { ts: "862.5", role: "user" as const, text: "screen-error" },
            { ts: "862.6", role: "user" as const, text: "clean-three" },
          ],
        ],
      ] as const) {
        const result = await built.app.turn(channel(`ch:C862:${suffix}-${Date.now()}`, [...messages]));
        assert.equal(result.status, "pending_approval");
        const entries = await built.sessions.getEntries(result.sessionId!);
        const imported = entries.filter((entry) => (entry.payload as { overheard?: boolean }).overheard === true);
        assert.equal(imported.length, 2);
        assert.equal(
          imported.every((entry) => (entry.payload as { securityTainted?: boolean }).securityTainted === true),
          true,
        );
      }
    } finally {
      await built.runtime.stop();
    }
  },
);
