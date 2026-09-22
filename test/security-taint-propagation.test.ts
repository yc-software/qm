import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { localizeSecuritySources } from "../src/core/orchestrator/security-screen.ts";
import { createTranscriptSource } from "../src/harness/tape-projection.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { SecurityScreener } from "../src/security/security-screener.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const databaseUrl = process.env.DATABASE_URL;
const actor = { externalId: "U1" };

function memoryApp(securityScreener: SecurityScreener) {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-taint-memory-")) }), {
    securityScreener,
  });
}

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

test("source localization preserves duplicate-content identity and bounds classifier work", async () => {
  const first = { id: "first", content: "identical" };
  const second = { id: "second", content: "identical" };
  let call = 0;
  const verdicts = await localizeSecuritySources([first, second], async () =>
    call++ === 0 ? { decision: "auto" } : { decision: "strict", reason: "second source" },
  );
  assert.deepEqual(verdicts?.get(first), { decision: "auto" });
  assert.deepEqual(verdicts?.get(second), { decision: "strict", reason: "second source" });
  assert.equal(call, 2);

  let active = 0;
  let peak = 0;
  await localizeSecuritySources(
    Array.from({ length: 8 }, (_, index) => ({ id: `bounded-${index}` })),
    async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { decision: "auto" };
    },
  );
  assert.equal(peak, 4);

  call = 0;
  const overflow = await localizeSecuritySources(
    Array.from({ length: 17 }, (_, index) => ({ id: String(index), content: "x" })),
    async () => {
      call++;
      return { decision: "auto" };
    },
  );
  assert.equal(overflow, null);
  assert.equal(call, 0);
});

test("orchestrator keeps failed and ambiguous source localization quarantined", async () => {
  let classifications = 0;
  const scripted: SecurityScreener = {
    provider: "taint-fast-regression",
    shadow: false,
    async classify({ payload }) {
      classifications++;
      const sources = JSON.parse(payload) as Array<{ content: string }>;
      if (sources.length > 1) return { verdict: { decision: "strict", reason: "aggregate" }, score: 1, threshold: 0.5 };
      const content = sources[0]?.content ?? "";
      if (content.includes("strict-source"))
        return { verdict: { decision: "strict", reason: "localized" }, score: 1, threshold: 0.5 };
      if (content.includes("failed-source")) throw new Error("screen failed");
      if (content.includes("undefined-source")) return undefined as never;
      if (content.includes("unscreened-source"))
        return {
          verdict: { decision: "auto", unscreened: true, reason: "unavailable" },
          score: 0,
          threshold: 0.5,
        };
      return { verdict: { decision: "auto" }, score: 0, threshold: 0.5 };
    },
  };
  const built = memoryApp(scripted);
  const mixed = await built.app.turn(
    channel("ch:C862:fast-mixed", [
      { ts: "fast.1", role: "user", text: "strict-source" },
      { ts: "fast.2", role: "user", text: "failed-source" },
      { ts: "fast.3", role: "user", text: "undefined-source" },
      { ts: "fast.4", role: "user", text: "unscreened-source" },
      { ts: "fast.5", role: "user", text: "clean-source" },
    ]),
  );
  assert.equal(mixed.status, "pending_approval");
  const mixedEntries = await built.sessions.getEntries(mixed.sessionId!);
  const taintByTs = new Map(
    mixedEntries
      .filter((entry) => (entry.payload as { overheard?: boolean }).overheard)
      .map((entry) => {
        const payload = entry.payload as { ts: string; securityTainted?: boolean };
        return [payload.ts, payload.securityTainted === true];
      }),
  );
  assert.deepEqual(
    taintByTs,
    new Map([
      ["fast.1", true],
      ["fast.2", true],
      ["fast.3", true],
      ["fast.4", true],
      ["fast.5", false],
    ]),
  );
  const tapeTaintByTs = new Map(
    (await built.sessions.getTape(mixed.sessionId!))
      .filter((row) => typeof row.meta?.ts === "string")
      .map((row) => [row.meta!.ts!, row.meta?.securityTainted === true]),
  );
  assert.deepEqual(tapeTaintByTs, taintByTs);

  const ambiguous = await built.app.turn(
    channel("ch:C862:fast-ambiguous", [
      { ts: "fast.6", role: "user", text: "aggregate-auto-one" },
      { ts: "fast.7", role: "user", text: "aggregate-auto-two" },
    ]),
  );
  assert.equal(ambiguous.status, "pending_approval");
  assert.equal(
    (await built.sessions.getEntries(ambiguous.sessionId!))
      .filter((entry) => (entry.payload as { overheard?: boolean }).overheard)
      .every((entry) => (entry.payload as { securityTainted?: boolean }).securityTainted === true),
    true,
  );

  const beforeOverflow = classifications;
  const overflow = await built.app.turn(
    channel(
      "ch:C862:fast-overflow",
      Array.from({ length: 17 }, (_, index) => ({
        ts: `fast.overflow.${index}`,
        role: "user" as const,
        text: `source-${index}`,
      })),
    ),
  );
  assert.equal(overflow.status, "pending_approval");
  assert.equal(classifications, beforeOverflow + 1);
  assert.equal(
    (await built.sessions.getEntries(overflow.sessionId!))
      .filter((entry) => (entry.payload as { overheard?: boolean }).overheard)
      .every((entry) => (entry.payload as { securityTainted?: boolean }).securityTainted === true),
    true,
  );
});

test("strict attachment data does not taint clean overheard attribution", async () => {
  const built = memoryApp(screener);
  const blob = await built.blobTransfer.put(Buffer.from("flagged-source"));
  const attachment = {
    name: "instructions.txt",
    mimetype: "text/plain",
    sizeBytes: blob.sizeBytes,
    blobId: blob.blobId,
    sourceId: "attachment-source-id",
  };
  const request = channel(
    "ch:C862:attachment",
    [{ ts: "attachment.1", role: "user", name: "Alice", text: "clean-attachment-history" }],
    { attachments: [attachment] },
  );
  const result = await built.app.turn(request);
  assert.equal(result.status, "pending_approval");
  const entries = await built.sessions.getEntries(result.sessionId!);
  const clean = entries.find((entry) => (entry.payload as { ts?: string }).ts === "attachment.1");
  assert.notEqual((clean?.payload as { securityTainted?: boolean }).securityTainted, true);
  const trigger = entries.find(
    (entry) =>
      (entry.payload as { securityTainted?: boolean; overheard?: boolean }).securityTainted === true &&
      !(entry.payload as { overheard?: boolean }).overheard,
  );
  assert.deepEqual((trigger?.payload as { quarantinedAttachmentSourceIds?: string[] }).quarantinedAttachmentSourceIds, [
    "attachment-source-id",
  ]);
});

test(
  "mixed source taint stays attributed across Postgres history and later thread imports",
  { skip: databaseUrl ? false : "set DATABASE_URL to a disposable Postgres database" },
  async () => {
    const config = testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "qm-taint-")),
      databaseUrl,
      sessionStore: "postgres",
      backgroundWorkEnabled: false,
    });
    let built = buildApp(config, { securityScreener: screener });
    const mixed = [
      {
        ts: "862.1",
        role: "self" as const,
        name: "QM",
        text: "clean-source",
        files: ["F-clean"],
        mentions: { U2: "Bob" },
      },
      { ts: "862.2", role: "user" as const, name: "Mallory", text: "flagged-source" },
    ];
    const firstThread = `ch:C862:first-${Date.now()}`;
    const firstRequest = channel(firstThread, mixed);
    try {
      const first = await built.app.turn(firstRequest);
      assert.equal(first.status, "pending_approval");
      const entries = await built.sessions.getEntries(first.sessionId!);
      const clean = entries.find((entry) => (entry.payload as { ts?: string }).ts === "862.1");
      const flagged = entries.find((entry) => (entry.payload as { ts?: string }).ts === "862.2");
      assert.deepEqual(clean?.payload, {
        overheard: true,
        ts: "862.1",
        sourceRole: "agent",
        name: "QM",
        text: "clean-source",
        files: ["F-clean"],
        mentions: { U2: "Bob" },
      });
      assert.equal((flagged?.payload as { securityTainted?: boolean }).securityTainted, true);
      const tape = await built.sessions.getTape(first.sessionId!);
      const cleanTape = tape.find((row) => row.meta?.ts === "862.1");
      const flaggedTape = tape.find((row) => row.meta?.ts === "862.2");
      assert.equal(cleanTape?.meta?.overheard, true);
      assert.equal(cleanTape?.meta?.sourceRole, "agent");
      assert.equal(cleanTape?.meta?.author, "QM");
      assert.deepEqual(cleanTape?.meta?.attachments, ["F-clean"]);
      assert.notEqual(cleanTape?.meta?.securityTainted, true);
      assert.equal(flaggedTape?.meta?.securityTainted, true);

      const denied = await built.app.turn({
        ...firstRequest,
        approval: { requestId: first.pendingApprovals![0]!.requestId, approved: false },
      });
      assert.equal(denied.status, "refused");
      await built.runtime.stop();
      const reopenedSessions = createPostgresSessionStore(databaseUrl!);
      const persisted = await reopenedSessions.getEntries(first.sessionId!);
      assert.notEqual(
        (
          persisted.find((entry) => (entry.payload as { ts?: string }).ts === "862.1")?.payload as {
            securityTainted?: boolean;
          }
        ).securityTainted,
        true,
      );
      assert.equal(
        (
          persisted.find((entry) => (entry.payload as { ts?: string }).ts === "862.2")?.payload as {
            securityTainted?: boolean;
          }
        ).securityTainted,
        true,
      );
      const persistedTranscript = (await createTranscriptSource(reopenedSessions).forRender(first.sessionId!)).entries;
      built = buildApp(config, { securityScreener: screener });

      const followup = await built.app.turn(channel(firstThread, [], { text: "follow up after readback" }));
      assert.equal(followup.status, "ok");
      const followupContext = [...(await built.sessions.listLlmRequests(first.sessionId!))]
        .reverse()
        .find((request) => request.model !== "mock-security")?.promptEnvelope;
      assert.match(JSON.stringify(followupContext), /clean-source/);
      assert.doesNotMatch(JSON.stringify(followupContext), /flagged-source/);

      const importedHistory = persistedTranscript
        .filter((entry) => (entry.payload as { overheard?: boolean }).overheard === true)
        .map((entry) => {
          const payload = entry.payload as {
            ts: string;
            sourceRole?: "agent";
            name?: string;
            text: string;
            files?: string[];
            mentions?: Record<string, string>;
          };
          return {
            ts: payload.ts,
            role: payload.sourceRole === "agent" ? ("self" as const) : ("user" as const),
            ...(payload.name ? { name: payload.name } : {}),
            text: payload.text,
            ...(payload.files ? { files: payload.files } : {}),
            ...(payload.mentions ? { mentions: payload.mentions } : {}),
          };
        });
      assert.deepEqual(
        importedHistory.map((message) => message.ts),
        ["862.1", "862.2"],
      );
      const laterThread = `ch:C862:later-${Date.now()}`;
      const laterRequest = channel(laterThread, importedHistory);
      const later = await built.app.turn(laterRequest);
      assert.equal(later.status, "pending_approval");
      const laterEntries = await built.sessions.getEntries(later.sessionId!);
      assert.notEqual(
        (
          laterEntries.find((entry) => (entry.payload as { ts?: string }).ts === "862.1")?.payload as {
            securityTainted?: boolean;
          }
        ).securityTainted,
        true,
      );
      assert.equal(
        (
          laterEntries.find((entry) => (entry.payload as { ts?: string }).ts === "862.2")?.payload as {
            securityTainted?: boolean;
          }
        ).securityTainted,
        true,
      );
      const laterDenied = await built.app.turn({
        ...laterRequest,
        approval: { requestId: later.pendingApprovals![0]!.requestId, approved: false },
      });
      assert.equal(laterDenied.status, "refused");
      const laterFollowup = await built.app.turn(channel(laterThread, [], { text: "later thread follow up" }));
      assert.equal(laterFollowup.status, "ok");
      const laterContext = [...(await built.sessions.listLlmRequests(later.sessionId!))]
        .reverse()
        .find((request) => request.model !== "mock-security")?.promptEnvelope;
      assert.match(JSON.stringify(laterContext), /clean-source/);
      assert.doesNotMatch(JSON.stringify(laterContext), /flagged-source/);

      const triggered = await built.app.turn(
        channel(
          `ch:C862:triggered-${Date.now()}`,
          [{ ts: "862.7", role: "user", name: "Alice", text: "clean-triggered-history" }],
          { surface: "webhook", triggered: true, securityScreenData: "flagged-source" },
        ),
      );
      assert.equal(triggered.status, "pending_approval");
      assert.match(triggered.pendingApprovals?.[0]?.reason ?? "", /flagged sources: message/);
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
