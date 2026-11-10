import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

test("a followup replaces the item's review outputs with the server's", async () => {
  const { vite, close } = await createInboxFixture({ dom: { url: "http://localhost/web-ui/" } });
  try {
    const { inboxState, toInboxItem, askAgent } = await vite.ssrLoadModule("/src/inbox.ts");
    const ledger = {
      id: "item-1",
      loopId: "loop-1",
      state: "held",
      source: "generic",
      sourcePayload: { title: "Weekly report" },
      thread: [],
    };
    const output = (title: string) => ({ id: "out-1", title, shipAction: "post", state: "draft" });
    const item = { ...toInboxItem(ledger), outputs: [output("Old report")], detailLoaded: true };
    inboxState.items = [item];
    globalThis.fetch = (_url, init) =>
      Promise.resolve(Response.json(init?.method === "POST" ? { item: ledger, outputs: [output("New report")] } : {}));
    assert.equal(await askAgent(item, "Shorten it"), true);
    assert.deepEqual(
      inboxState.items
        .find((entry: { id: string }) => entry.id === "item-1")
        .outputs.map((o: { title: string }) => o.title),
      ["New report"],
    );
  } finally {
    await close();
  }
});
