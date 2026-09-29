import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("page data starts while one shared context lookup is pending", async () => {
  for (const [path, resource] of [
    ["/crons", "/api/crons"],
    ["/webhooks", "/api/webhooks"],
    ["/apps", "/api/deployments"],
    ["/files", "/api/files?limit="],
  ]) {
    const h = await harness({ path: path!, holdContexts: true });
    try {
      await h.boot();
      for (let i = 0; i < 100 && !h.requests.some((request) => request.startsWith(resource!)); i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(
        h.requests.some((request) => request.startsWith(resource!)),
        `${path} data waits for contexts`,
      );
      assert.equal(h.contextsState.loaded, false);
      assert.equal(h.requests.filter((request) => request === "/api/contexts").length, 1);
      h.releaseContexts();
      await h.ensureContexts();
      assert.equal(h.contextsState.loaded, true);
    } finally {
      await h.close();
    }
  }
});

test("context reads share pending work, retry errors and discard pre-reset responses", async () => {
  const h = await harness({ path: "/" });
  const fetch = globalThis.fetch;
  const pending: Array<{ resolve: (value: Response) => void; reject: (reason: Error) => void }> = [];
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/contexts");
    return await new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
  };
  try {
    const first = h.ensureContexts();
    const shared = h.ensureContexts(true);
    assert.equal(pending.length, 1);
    pending[0]!.reject(new Error("offline"));
    assert.deepEqual(await Promise.all([first, shared]), [[], []]);
    assert.equal(h.contextsState.loaded, false);
    const stale = h.ensureContexts();
    assert.equal(pending.length, 2);
    h.resetContexts();
    const fresh = h.ensureContexts();
    assert.equal(pending.length, 3);
    pending[2]!.resolve(Response.json({ contexts: [{ scopeId: "personal:new", kind: "personal" }] }));
    await fresh;
    pending[1]!.resolve(Response.json({ contexts: [{ scopeId: "personal:old", kind: "personal" }] }));
    await stale;
    assert.equal(h.contextsState.list[0]?.scopeId, "personal:new");
    await h.ensureContexts();
    assert.equal(pending.length, 3);
    const forced = h.ensureContexts(true);
    assert.equal(pending.length, 4);
    pending[3]!.resolve(Response.json({ contexts: [] }));
    assert.deepEqual(await forced, []);
  } finally {
    for (const row of pending) row.resolve(Response.json({ contexts: [] }));
    globalThis.fetch = fetch;
    await h.close();
  }
});
