import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

test("Slack feed avatars use stable identities and fall back to initials when a photo fails", async () => {
  const f = await createInboxFixture();
  try {
    await f.vite.ssrLoadModule("/src/shell.ts");
    const { participantsTpl, contextTpl, toInboxItem } = await f.vite.ssrLoadModule("/src/inbox.ts");
    const { render } = await f.vite.ssrLoadModule("lit");
    const item = toInboxItem({
      id: "slack-1",
      loopId: "inbox",
      dedupeKey: "D1",
      source: "slack",
      state: "held",
      sourceAt: 1000,
      updatedAt: 1000,
      thread: [],
      sourcePayload: {
        from: "Alex",
        snippet: "Waiting message",
        slack: { channelId: "D1", ts: "1.0", userId: "U1" },
        participants: [
          { id: "U1", name: "Alex", avatarUrl: "https://avatars.slack-edge.com/alex.png" },
          { id: "U2", name: "Alex", avatarUrl: "https://avatars.slack-edge.com/other-alex.png" },
          { id: "U3", name: "Sam" },
        ],
      },
    });
    render(participantsTpl(item), f.host);
    assert.equal(f.host.querySelectorAll(".inbox-avatar").length, 3);
    assert.equal(f.host.querySelectorAll("img").length, 2);
    const photo = f.host.querySelector("img")!;
    assert.equal(photo.getAttribute("referrerpolicy"), "no-referrer");
    photo.dispatchEvent(new f.dom.window.Event("error"));
    assert.equal(photo.hidden, true);
    assert.match(photo.parentElement!.textContent!, /A/);
    item.participants[0].avatarUrl = "https://avatars.slack-edge.com/updated.png";
    render(participantsTpl(item), f.host);
    assert.equal(f.host.querySelector("img")!.hidden, false);
    assert.equal(f.host.querySelector("img")!.getAttribute("src"), "https://avatars.slack-edge.com/updated.png");
    render(contextTpl(item), f.host);
    assert.equal(
      f.host.querySelector(".inbox-avatar img")!.getAttribute("src"),
      "https://avatars.slack-edge.com/updated.png",
    );
    item.slack.userId = undefined;
    item.participants[0].name = "Alex Morgan";
    render(contextTpl(item), f.host);
    assert.equal(f.host.querySelector(".inbox-context-author")!.textContent, "Alex Morgan");
    assert.equal(
      f.host.querySelector(".inbox-avatar img")!.getAttribute("src"),
      "https://avatars.slack-edge.com/updated.png",
    );
    item.participants[0].name = "Alex";
    item.sourceContextFetched = true;
    item.context = [
      { author: "Alex", authorId: "U2", avatarUrl: "https://avatars.slack-edge.com/other-alex.png", text: "Reply" },
    ];
    render(contextTpl(item), f.host);
    assert.equal(
      f.host.querySelector(".inbox-avatar img")!.getAttribute("src"),
      "https://avatars.slack-edge.com/other-alex.png",
    );
    item.participants[1].name = "Alex Rivera";
    render(contextTpl(item), f.host);
    assert.equal(f.host.querySelector(".inbox-context-author")!.textContent, "Alex Rivera");
    item.participants[1].name = "Alex";
    item.participants[1].avatarUrl = "https://avatars.slack-edge.com/latest-alex.png";
    render(contextTpl(item), f.host);
    assert.equal(
      f.host.querySelector(".inbox-avatar img")!.getAttribute("src"),
      "https://avatars.slack-edge.com/latest-alex.png",
    );
    item.participants[1].avatarUrl = undefined;
    render(contextTpl(item), f.host);
    assert.equal(f.host.querySelectorAll(".inbox-avatar img").length, 0);
    item.context[0].authorId = "U4";
    item.context[0].avatarUrl = "javascript:alert(1)";
    render(contextTpl(item), f.host);
    assert.equal(f.host.querySelectorAll(".inbox-avatar img").length, 0);
    item.context[0].authorId = "U2";
    item.context.push({ author: "Casey", authorId: "U4", text: "Earlier message" });
    render(participantsTpl(item), f.host);
    assert.equal(f.host.querySelectorAll(".inbox-avatar").length, 4);
    assert.match(f.host.querySelector(".inbox-avatars")!.getAttribute("aria-label")!, /Alex, Alex, Sam, Casey/);
    item.context.push({ author: "Jordan", authorId: "U5", text: "Another message" });
    render(participantsTpl(item), f.host);
    assert.equal(f.host.querySelector(".inbox-avatar.more")!.textContent!.trim(), "+2");
    item.slack = undefined;
    item.from = "Alex Smith";
    render(participantsTpl(item), f.host);
    assert.equal(f.host.querySelector(".inbox-avatar.more")!.textContent!.trim(), "+2");
    assert.doesNotMatch(f.host.querySelector(".inbox-avatars")!.getAttribute("aria-label")!, /Alex Smith/);
    item.source = "gmail";
    render(participantsTpl(item), f.host);
    assert.equal(f.host.querySelectorAll("img").length, 0);
  } finally {
    await f.close();
  }
});
