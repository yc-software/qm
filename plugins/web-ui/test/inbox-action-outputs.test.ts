import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

for (const status of ["open", "dismissed"] as const) {
  test(`setting status ${status} keeps the item's review outputs`, async () => {
    const { vite, close } = await createInboxFixture({ dom: { url: "http://localhost/web-ui/" } });
    try {
      const { inboxState, toInboxItem, setItemStatus } = await vite.ssrLoadModule("/src/inbox.ts");
      const ledger = {
        id: "item-1",
        loopId: "loop-1",
        state: "held",
        source: "generic",
        sourcePayload: { title: "Weekly report" },
        thread: [],
      };
      const outputs = [{ id: "out-1", title: "Report", shipAction: "post", state: "ready" }];
      const item = { ...toInboxItem(ledger), outputs, detailLoaded: true };
      inboxState.items = [item];
      globalThis.fetch = (_url, init) =>
        Promise.resolve(Response.json(init?.method === "POST" ? { item: ledger } : {}));
      assert.equal(await setItemStatus(item, status), true);
      const stored = inboxState.items.find((entry: { id: string }) => entry.id === "item-1");
      assert.deepEqual(stored.outputs, outputs);
    } finally {
      await close();
    }
  });
}
