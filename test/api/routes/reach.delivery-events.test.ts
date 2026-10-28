import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../support/build-app.ts";
import { scopeId } from "../../../src/types.ts";
import { testConfig } from "../../support/test-config.ts";
import { mockPrompts } from "../../support/mock-harness/turn.ts";

describe("agent → teammate DM: delivery events in the recipient's session (anti-amnesia, §10)", () => {
  const slackDm = () => {
    const built = buildApp(testConfig());
    built.outbound.register(["principal", "slack"], async () => ({ recipientThreadRef: "dm:D-alice" }));
    return built;
  };
  const settle = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it("records a recipient delivery event without appending a normal assistant turn", async () => {
    const built = slackDm();
    await built.app.upsertDirectory([
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
    ]);
    await built.outbound.send({
      destination: {
        type: "principal",
        target: "U-alice",
        audienceScopeId: scopeId("personal", "U-alice"),
        onBehalfOf: "U-carol",
      },
      text: "the deploy is done",
      idempotencyKey: "k1",
      provenance: {
        trigger: "cron",
        surface: "cron",
        fireKey: "cron:c1:slot",
        sourceScopeId: scopeId("personal", "U-carol"),
        sourceThreadRef: "cron:c1:slot",
        sourceSessionId: "source-session",
        sourceUserSeq: 0,
        sourceAssistantEntrySeq: 1,
      },
    });

    await settle(async () => {
      const s = await built.sessions.getByThread("dm:D-alice");
      return !!s && (await built.sessions.participantsOf(s.id)).includes("U-alice");
    });
    const session = await built.sessions.getByThread("dm:D-alice");
    assert.ok(session, "recipient DM session created");
    assert.equal(session!.surface, "slack");
    assert.ok((await built.sessions.participantsOf(session!.id)).includes("U-alice"));
    assert.equal(
      (await built.sessions.getItems(session!.id)).some((e) => e.kind === "AgentMessage"),
      false,
      "principal delivery is not fake chat history",
    );

    await new Promise((r) => setTimeout(r, 20));
    await built.app.turn({
      origin: { kind: "direct" },
      surface: "test",
      actor: { externalId: "U-alice" },
      conversation: { kind: "dm", threadRef: "dm:D-alice" },
      text: "what was that?",
    });
    const footer = mockPrompts(session!.id).at(-1)!.messages.at(-1)!.content;
    assert.match(footer, /Delivered here since the user's last message/);
    assert.match(footer, /\[cron\] from U-carol: the deploy is done/);
  });

  it("is a no-op for a non-principal delivery", async () => {
    const built = slackDm();
    await built.outbound.send({
      destination: { type: "slack", target: "C1" },
      text: "hi channel",
      idempotencyKey: "k2",
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await built.sessions.getByThread("dm:D-alice"), null);
  });
});
