import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("Slack conversations show directory Slack photos on messages and in the header", async () => {
  const session = {
    ...SESSION,
    type: "group" as const,
    createdAt: 1,
    surface: "slack",
    canContinue: false,
    channelName: "mpdm-eve--regan-1",
  };
  const photos: Record<string, string> = {
    "eve@example.com": "https://avatars.slack-edge.com/eve_72.jpg",
    "regan@example.com": "https://avatars.slack-edge.com/regan_72.png",
  };
  const lookups: string[] = [];
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    api: (path) => {
      const url = new URL(path, "http://localhost");
      if (url.pathname !== "/api/directory/resolve") return undefined;
      const id = url.searchParams.get("q")!;
      lookups.push(id);
      return Response.json({
        matches: photos[id] ? [{ principalId: id, displayName: id, type: "internal", avatarUrl: photos[id] }] : [],
      });
    },
    items: [
      item("UserMessage", { seq: 1, createdAt: 1, text: "hi", body: { name: "Eve", speakerId: "eve@example.com" } }),
      item("UserMessage", {
        seq: 2,
        createdAt: 2,
        text: "yo",
        body: { name: "Regan", speakerId: "regan@example.com" },
      }),
      item("UserMessage", { seq: 3, createdAt: 3, text: "again", body: { name: "Eve", speakerId: "eve@example.com" } }),
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    const srcs = () => [...document.querySelectorAll(".speaker-label img")].map((i) => i.getAttribute("src"));
    for (let i = 0; i < 100 && srcs().length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(srcs(), [photos["eve@example.com"], photos["regan@example.com"], photos["eve@example.com"]]);
    assert.deepEqual(
      [...document.querySelectorAll(".chat-participants img")].map((i) => i.getAttribute("src")),
      [photos["eve@example.com"], photos["regan@example.com"]],
    );
    assert.ok(document.querySelector(".chat-participant-names")?.textContent?.includes(","));
    assert.equal(document.querySelector(".chat-subtitle"), null);
    assert.deepEqual(lookups.sort(), ["eve@example.com", "regan@example.com", "tester"], "one lookup per person");
  } finally {
    await h.close();
  }
});

test("a Slack channel transcript groups a speaker's run and shows the Slack app icon", async () => {
  const session = { ...SESSION, type: "channel" as const, createdAt: 1, surface: "slack", canContinue: false };
  const said = (kind: "UserMessage" | "SteeringMessage", seq: number, text: string, body: Record<string, unknown>) =>
    item(kind, { seq, createdAt: seq, turnId: "t", text, body });
  const h = await harness({
    path: `/s/${session.id}`,
    session,
    listSessions: [session],
    api: (path) =>
      path === "/me"
        ? Response.json({
            user: "tester",
            personalScope: "personal:tester",
            org: "test",
            slackAppIconUrl: "https://avatars.slack-edge.com/app_72.png",
          })
        : undefined,
    items: [
      said("UserMessage", 1, "deploys broke", { name: "Pete", overheard: true }),
      said("UserMessage", 2, "@qm DM me", { name: "T", speakerId: "tester" }),
      item("ToolCall", { seq: 3, turnId: "t", callId: "c", tool: "slack", body: { action: "reach" } }),
      item("ToolResult", { seq: 4, turnId: "t", callId: "c", tool: "slack", body: { ok: true } }),
      said("SteeringMessage", 5, "thanks!", { name: "T", speakerId: "tester" }),
      item("AgentMessage", { seq: 6, turnId: "t", body: { workStartedAt: 1, workFinishedAt: 6 } }),
      item("AgentMessage", { seq: 7, turnId: "u", text: "as Ada", body: { personaId: "ada", workFinishedAt: 7 } }),
      item("UserMessage", {
        seq: 8,
        turnId: "v",
        text: '[Slack reaction] Pete reacted with :eyes: on your message: "as Ada" (it now has :eyes:).',
        body: { name: "Pete", overheard: true },
      }),
    ],
  });
  try {
    h.releaseSessions();
    await h.boot();
    const rows = [...document.querySelectorAll(".message-stack > .message-row")];
    assert.deepEqual(
      rows.map((row) => [
        Boolean(row.querySelector(":scope > .speaker-label")),
        row.querySelector(".slack-wire-text")?.textContent?.trim(),
        row.querySelector(":scope > .speaker-label > .brand-mark > img")?.getAttribute("src"),
        row.classList.contains("continued-row"),
      ]),
      [
        [true, "deploys broke", undefined, false],
        [true, "@qm DM me", undefined, false],
        [false, "thanks!", undefined, true],
        [true, undefined, "https://avatars.slack-edge.com/app_72.png", false],
        [true, undefined, undefined, false],
      ],
    );
    assert.equal(rows.at(-1)!.querySelector(".slack-reaction")!.textContent!.replaceAll(/\s/g, ""), "👀1");
    assert.ok(
      rows.at(-1)!.querySelector(":scope > .speaker-label > .brand-mark"),
      "a persona's reply keeps the brand mark",
    );
    assert.equal(rows.at(-2)!.querySelectorAll(".user-row").length, 0);
  } finally {
    await h.close();
  }
});
