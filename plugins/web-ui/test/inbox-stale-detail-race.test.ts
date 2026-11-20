import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture, inboxRuntime, until } from "./inbox-composer-fixture.ts";

// LAB-186: an item response read before a draft save can land after it. It must not roll the item back to the
// older draft revision, or the next "Send it" carries a stale revision and core rejects it with 409.
async function openInbox(options: { followupError?: { status: number; message: string } } = {}) {
  const fixture = await createInboxFixture();
  const { vite, host } = fixture;
  await vite.ssrLoadModule("/src/shell.ts");
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  appState.me = { user: "taylor@example.com", permissions: ["inbox"] };
  const inbox = await vite.ssrLoadModule("/src/inbox.ts");
  inbox.resetInboxState();
  // Mirrors core: proposal.at bumps on edit; follow-ups 409 when expectedProposalAt is not the current revision.
  const server = {
    id: "item-1",
    loopId: "loop-1",
    state: "held",
    source: "gmail",
    dedupeKey: "gmail:1",
    sourcePayload: { title: "Re: Update", from: "Sam <sam@example.com>", snippet: "Any news?" },
    proposal: {
      data: { body: "Original draft", to: ["sam@example.com"], subject: "Re: Update" },
      by: "agent",
      at: 100,
    },
    thread: [],
    updatedAt: 100,
  };
  const followups: unknown[] = [];
  const held: Array<() => void> = [];
  const hold = { detail: false, feed: false };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    if (path.includes("runtime-config")) return Response.json(inboxRuntime);
    if (path.startsWith("/api/inbox")) {
      const body = structuredClone(server);
      if (hold.feed && path.includes("view=handled")) await new Promise<void>((release) => held.push(release));
      return Response.json({
        migrationPending: false,
        filter: "human",
        selected: [{ id: "loop-1", name: "Email", source: "gmail", sources: ["gmail"], selected: true }],
        available: [],
        items: path.includes("view=handled") ? [] : [body],
        total: 1,
        nextCursor: null,
      });
    }
    if (method === "GET" && path.startsWith("/api/loops/loop-1/items/item-1")) {
      const body = structuredClone(server);
      if (hold.detail) await new Promise<void>((release) => held.push(release));
      return Response.json({ item: body, outputs: [] });
    }
    if (method === "POST" && path.endsWith("/action")) {
      const req = JSON.parse(String(init?.body));
      if (req.args?.expectedProposalAt !== undefined && req.args.expectedProposalAt !== server.proposal.at)
        return Response.json(
          { error: "conflict", message: "the draft changed since you last saw it" },
          { status: 409 },
        );
      server.proposal = { data: req.args.proposal, by: "human", at: server.proposal.at + 1 };
      server.updatedAt = server.proposal.at;
      return Response.json({ item: structuredClone(server) });
    }
    if (method === "POST" && path.endsWith("/followup")) {
      const req = JSON.parse(String(init?.body));
      followups.push(req.expectedProposalAt);
      if (options.followupError)
        return Response.json(
          { error: "failed", message: options.followupError.message },
          { status: options.followupError.status },
        );
      if (typeof req.expectedProposalAt === "number" && req.expectedProposalAt !== server.proposal.at)
        return Response.json(
          { error: "conflict", message: "the draft changed; review it before continuing" },
          { status: 409 },
        );
      return Response.json({ item: structuredClone(server) });
    }
    return Response.json({});
  };
  const pane = inbox.mountInboxPane({ host, viewId: "all", density: () => "full", onDensityChange: () => {} });
  await until(() => Boolean(host.querySelector(".inbox-item-row")));
  return { ...fixture, inbox, server, followups, held, hold, pane };
}

for (const mode of ["detail", "feed"] as const) {
  test(`a stale ${mode} response does not replace a newer saved draft, so Send it succeeds`, async () => {
    const t = await openInbox();
    const { dom, host, inbox, server, followups, held, hold } = t;
    try {
      if (mode === "detail") hold.detail = true;
      host.querySelector<HTMLButtonElement>(".inbox-item-row")!.click(); // opens the item; detail load starts
      await until(
        () =>
          Boolean(host.querySelector(".inbox-draft-body")) &&
          Boolean(host.querySelector(".composer-input:not(:disabled)")),
      );
      if (mode === "feed") {
        // A background refresh reads the pre-edit draft and is still in flight when the save completes.
        hold.feed = true;
        void inbox.refreshInbox({ silent: true });
      }
      await until(() => held.length === 1);
      const draft = host.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!;
      draft.value = "Edited by me";
      draft.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      draft.dispatchEvent(new dom.window.Event("blur"));
      await until(() => inbox.inboxState.items[0]?.draftAt === 101);
      hold.detail = hold.feed = false;
      for (const release of held.splice(0)) release(); // the stale response lands after the save
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(inbox.inboxState.items[0].draftAt, 101);
      assert.equal(host.querySelector<HTMLTextAreaElement>(".inbox-draft-body")!.value, "Edited by me");
      host.querySelector<HTMLButtonElement>(".inbox-suggest-chip.primary")!.click(); // "Send it"
      await until(() => followups.length === 1 && !host.querySelector(".inbox-chat-working"));
      assert.deepEqual(followups, [server.proposal.at]);
      assert.equal(host.querySelector(".composer-error"), null);
      t.pane.dispose();
    } finally {
      await t.close();
    }
  });
}

test("a failed Send it shows the real reason in the composer", async () => {
  const t = await openInbox({ followupError: { status: 503, message: "the agent is unavailable right now" } });
  const { host } = t;
  try {
    host.querySelector<HTMLButtonElement>(".inbox-item-row")!.click();
    await until(() => Boolean(host.querySelector(".composer-input:not(:disabled)")));
    host.querySelector<HTMLButtonElement>(".inbox-suggest-chip.primary")!.click();
    await until(() => Boolean(host.querySelector(".composer-error")));
    const error = host.querySelector(".composer-error")!.textContent!.trim();
    assert.match(error, /the agent is unavailable right now/);
    assert.match(error, /Your message has been kept\./);
    t.pane.dispose();
  } finally {
    await t.close();
  }
});
