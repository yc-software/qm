import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";
import { webhookEventOf } from "../src/webhook-event.ts";
import { harness } from "./deep-link-boot-fixture.ts";

Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: new JSDOM().window.DOMParser });

const wake = `<wake reason="webhook" surface="webhook" webhook-id="deploy-check" scheme="github" delivery-id="delivery-7">
  <standing-orders>Review the deployment &amp; report failures.</standing-orders>
  <event>{"status":"failed","description":"&lt;script&gt;alert(1)&lt;/script&gt;"}</event>
</wake>`;
const entry = (seq: number, type: SessionEntry["type"], payload: unknown): SessionEntry => ({
  seq,
  type,
  payload,
  createdAt: seq + 1,
});
const slackEntries = [
  entry(0, "user", { text: "Check the build" }),
  entry(1, "tool_call", { tool: "slack", action: "post", text: "Checking the build.", callId: "post" }),
  entry(2, "tool_result", { tool: "slack", action: "post", ok: true, callId: "post", deliveryKey: "delivery-1" }),
  entry(3, "assistant", { text: "" }),
  entry(4, "user", {
    text: "Checking the build.",
    overheard: true,
    sourceRole: "agent",
    ts: "1.1",
    deliveryKey: "delivery-1",
  }),
  entry(5, "user", { text: "Checking the build.", overheard: true, name: "Sam", ts: "1.2" }),
  entry(6, "user", { text: "A separate bot announcement.", overheard: true, sourceRole: "agent", ts: "1.3" }),
];

test("Slack echoes occur once on the assistant side without hiding identical human messages or unmatched bot posts", () => {
  const messages = entriesToMessages(slackEntries);
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.deepEqual((messages[1] as AssistantWork).entrySeqs, [1, 2, 4]);
  assert.equal((messages[2] as { content: string }).content, "Checking the build.");
  assert.deepEqual((messages[3] as AssistantWork).content, [{ type: "text", text: "A separate bot announcement." }]);
  assert.equal(
    entriesToMessages([entry(0, "user", { text: "private", overheard: true, sourceRole: "agent", hidden: true })])
      .length,
    0,
  );
});

test("historical hidden webhook prompts expose event data while other hidden prompts remain hidden", () => {
  const event = webhookEventOf({ text: wake });
  assert.equal(event?.action, "Review the deployment & report failures.");
  assert.equal(event?.deliveryId, "delivery-7");
  assert.ok(event!.payload.includes("<script>"));
  const messages = entriesToMessages([
    entry(0, "user", { text: wake, hidden: true }),
    entry(1, "user", { text: "internal resume instruction", hidden: true }),
    entry(2, "assistant", { text: "The deployment failed." }),
  ]);
  assert.equal(messages.length, 2);
  assert.match((messages[0] as { content: string }).content, /failed/);
  assert.equal((entriesToMessages([entry(0, "user", { text: wake })])[0] as { content: string }).content, wake);
  assert.deepEqual((messages[0] as unknown as { webhookEvent: unknown }).webhookEvent, event);
  assert.equal(webhookEventOf({ text: wake.slice(0, -7) }), undefined);
  assert.equal(webhookEventOf({ text: wake.replace('reason="webhook"', 'reason="cron"') }), undefined);
});

test("only matching delivery identities fold echoes and preserve revision markers", () => {
  const messages = entriesToMessages([
    ...slackEntries,
    entry(7, "user", {
      text: "Checking the build.",
      overheard: true,
      sourceRole: "agent",
      ts: "2.1",
      deliveryKey: "another-delivery",
    }),
    entry(8, "user", { text: "Checking the build.", overheard: true, sourceRole: "agent", ts: "2.2" }),
    entry(9, "system", { kind: "message_revision", action: "edited", ts: "1.1", text: "Build complete" }),
    entry(10, "system", { kind: "message_revision", action: "deleted", ts: "2.2" }),
  ]);
  const assistants = messages.filter((message) => message.role === "assistant") as AssistantWork[];
  assert.equal(assistants.length, 4);
  assert.equal(assistants[0]!.edited, true);
  assert.equal(assistants[2]!.edited, undefined);
  assert.equal(assistants[3]!.deleted, true);
  const changedText = entriesToMessages([
    ...slackEntries.slice(0, 4),
    entry(4, "user", {
      text: "Checking the build, as rendered by Slack.",
      overheard: true,
      sourceRole: "agent",
      ts: "1.1",
      deliveryKey: "delivery-1",
    }),
  ]);
  assert.equal(changedText.filter((message) => message.role === "assistant").length, 1);
});

test("mounted read-only conversations display webhook payloads as text and assistant echoes once", async () => {
  const session = (surface: "slack" | "webhook") => ({
    id: `external-${surface}`,
    threadRef: surface === "slack" ? "dm:DTEST" : "webhook:test:1",
    scopeId: "personal:tester",
    surface,
    type: "dm" as const,
    createdAt: 1,
    title: "External conversation",
  });
  const h = await harness({
    path: "/s/external-webhook",
    session: session("webhook"),
    entries: [
      entry(0, "user", { text: wake, hidden: true }),
      entry(1, "assistant", { text: "The deployment failed." }),
    ],
    api(path) {
      if (path.startsWith("/api/sessions/external-slack"))
        return Response.json({ session: session("slack"), entries: slackEntries });
    },
  });
  try {
    await h.boot();
    h.releaseSessions();
    await h.sessionsReady();
    assert.match(h.mainText(), /Webhook received/);
    assert.match(h.mainText(), /Review the deployment & report failures/);
    assert.match(document.querySelector(".webhook-event pre")!.textContent!, /<script>alert/);
    assert.equal(document.querySelector(".webhook-event script"), null);
    await h.openSession(session("slack"));
    assert.equal(document.querySelector(".slack-wire-text")!.textContent, "Check the build");
    assert.equal(document.querySelectorAll(".user-row").length, 2);
    assert.equal(document.querySelectorAll(".assistant-row").length, 2);
  } finally {
    await h.close();
  }
});
