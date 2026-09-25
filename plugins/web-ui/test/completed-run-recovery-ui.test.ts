import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Conversation } from "../src/conv-types.ts";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test("the mounted conversation recovers a saved answer after a local polling timeout", async (t) => {
  const user: SessionEntry = {
    type: "user",
    seq: 1,
    createdAt: 100,
    payload: { text: "Compute the result", runId: "run-current" },
  };
  const answer: SessionEntry = {
    type: "assistant",
    seq: 2,
    createdAt: 200,
    payload: { text: "The saved result is 42." },
  };
  const entries = [user];
  const h = await harness({ path: `/s/${SESSION.id}`, entries });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    const chat = h.visibleConversation() as Conversation;
    const agent = chat.state.agent!;
    const fixtureFetch = globalThis.fetch;
    let runStatus = "done";
    let runStatusCode = 200;
    let resultStatus: string | null = "ok";
    globalThis.fetch = async (...args) => {
      if (String(args[0]) === "/api/runs/run-current") {
        assert.ok(args[1]?.signal, "recovery status lookup has a request deadline");
        return Response.json(
          { status: runStatus, result: resultStatus ? { status: resultStatus } : null },
          { status: runStatusCode },
        );
      }
      return fixtureFetch(...args);
    };
    const timeout = (): AssistantWork => ({
      ...(entriesToMessages([answer])[0] as AssistantWork),
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "Timed out waiting for the agent to respond.",
      interruptedRunId: "run-current",
    });
    const reset = (last = timeout()): void => {
      agent.state.messages = [...entriesToMessages([user]), last];
      chat.drawActiveChat();
    };
    const refresh = async (): Promise<void> => {
      chat.onDelivery(SESSION.threadRef);
      await settle();
    };
    reset();
    assert.match(h.mainText(), /Timed out waiting for the agent/);

    await t.test("a transcript without the answer keeps the timeout visible", async () => {
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork)?.stopReason, "error");
      assert.match(h.mainText(), /Timed out waiting for the agent/);
    });

    await t.test("a late delivery replaces the timeout with the saved answer", async () => {
      entries.push(answer);
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork)?.stopReason, "stop");
      assert.match(h.mainText(), /The saved result is 42/);
      assert.doesNotMatch(h.mainText(), /Timed out waiting for the agent/);
    });

    await t.test("an old saved subturn does not hide an active or retrying run", async () => {
      for (const status of ["running", "pending"]) {
        reset();
        runStatus = status;
        resultStatus = null;
        await refresh();
        assert.equal((agent.state.messages.at(-1) as AssistantWork).stopReason, "error");
      }
      runStatus = "done";
      resultStatus = "ok";
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork).stopReason, "stop");
    });

    await t.test("failed or incomplete outcomes cannot be hidden by an earlier saved response", async () => {
      for (const outcome of ["failed", "refused", "pending_approval", null]) {
        reset();
        resultStatus = outcome;
        await refresh();
        assert.equal((agent.state.messages.at(-1) as AssistantWork).stopReason, "error");
      }
      resultStatus = "ok";
      runStatus = "failed";
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork).stopReason, "error");
      runStatus = "done";
    });

    await t.test("status lookup failure preserves the timeout until connectivity returns", async () => {
      reset();
      runStatusCode = 503;
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork).stopReason, "error");
      runStatusCode = 200;
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork).stopReason, "stop");
    });

    await t.test("another run's saved answer does not erase this run's timeout", async () => {
      reset();
      entries.splice(
        0,
        entries.length,
        { ...user, payload: { text: "Compute the result", runId: "other-run" } },
        answer,
      );
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork)?.stopReason, "error");
      entries.splice(0, entries.length, user, answer);
    });

    await t.test("genuine failures and user cancellation remain visible", async () => {
      const backendFailure = timeout();
      delete backendFailure.interruptedRunId;
      backendFailure.errorMessage = "The backend failed.";
      reset(backendFailure);
      await refresh();
      assert.equal(agent.state.messages.at(-1), backendFailure);
      const aborted = { ...timeout(), stopReason: "aborted" as const };
      reset(aborted);
      await refresh();
      assert.equal(agent.state.messages.at(-1), aborted);
    });

    await t.test("a failed history read keeps the error and a later delivery can recover", async () => {
      reset();
      h.setTranscriptStatus(503);
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork)?.stopReason, "error");
      h.setTranscriptStatus(200);
      await refresh();
      assert.equal((agent.state.messages.at(-1) as AssistantWork)?.stopReason, "stop");
    });

    const holdRefresh = async (phase = "transcript"): Promise<() => Promise<void>> => {
      reset();
      const originalFetch = globalThis.fetch;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let started = false;
      globalThis.fetch = async (...args) => {
        if (
          phase === "status"
            ? String(args[0]) === "/api/runs/run-current"
            : String(args[0]).startsWith(`/api/sessions/${SESSION.id}`) &&
              String(args[0]).includes("/approvals") === (phase === "approvals")
        ) {
          started = true;
          await held;
        }
        return originalFetch(...args);
      };
      chat.onDelivery(SESSION.threadRef);
      await settle();
      assert.equal(started, true);
      return async () => {
        release();
        await settle();
        globalThis.fetch = originalFetch;
      };
    };

    await t.test("a late history response cannot overwrite a newly streaming turn", async () => {
      const release = await holdRefresh();
      const before = agent.state.messages;
      Object.assign(agent.state, { isStreaming: true });
      await release();
      assert.equal(agent.state.messages, before);
      Object.assign(agent.state, { isStreaming: false });
    });

    for (const phase of ["status", "transcript", "approvals"]) {
      await t.test(`a new prompt that fails during ${phase} fetch is preserved`, async () => {
        const release = await holdRefresh(phase);
        const originalFetch = globalThis.fetch;
        let releaseList!: () => void;
        const listHeld = new Promise<void>((resolve) => (releaseList = resolve));
        globalThis.fetch = async (...args) => {
          if (String(args[0]) === "/api/sessions") await listHeld;
          return originalFetch(...args);
        };
        const originalStream = agent.streamFn;
        const originalConvert = agent.convertToLlm;
        const originalModel = agent.state.model;
        Object.assign(agent.state, {
          model: { id: "synthetic", api: "anthropic-messages", provider: "anthropic" } as NonNullable<
            typeof originalModel
          >,
        });
        agent.convertToLlm = () => [{ role: "user", content: "New request", timestamp: 300 }];
        agent.streamFn = () => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const error = { ...timeout(), interruptedRunId: undefined, errorMessage: "New send failed" };
            stream.push({ type: "error", reason: "error", error });
            stream.end(error);
          });
          return stream;
        };
        try {
          await agent.prompt("New request");
          const messages = agent.state.messages;
          assert.equal(agent.state.isStreaming, false);
          assert.equal((messages.at(-1) as AssistantWork).errorMessage, "New send failed");
          await release();
          assert.equal(agent.state.messages, messages);
          assert.ok(
            agent.state.messages.some(
              (message) => message.role === "user" && JSON.stringify(message.content).includes("New request"),
            ),
          );
        } finally {
          releaseList();
          await settle();
          agent.streamFn = originalStream;
          agent.convertToLlm = originalConvert;
          Object.assign(agent.state, { model: originalModel });
        }
      });
    }

    await t.test("a late history response cannot overwrite the conversation after navigation", async () => {
      const release = await holdRefresh();
      const before = agent.state.messages;
      chat.resetChatState();
      await release();
      assert.equal(agent.state.messages, before);
      assert.equal(chat.state.agent, null);
    });
  } finally {
    await h.close();
  }
});
