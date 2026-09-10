import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const policy = (supportsAmbient: boolean) => ({
  orders: "keep",
  bots: { CI: { mode: "action" } },
  ambientEnabled: true,
  updatedAt: 42,
  supportsAmbient,
});

test("member policy DOM and payloads follow server applicability across scope changes", async (t) => {
  const dom = new JSDOM('<!doctype html><main id="main"></main>', { url: "http://localhost/" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Document: dom.window.Document,
    CSSStyleSheet: dom.window.CSSStyleSheet,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const oldFetch = globalThis.fetch;
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    cacheDir: "node_modules/.vite-policy-test",
  });
  try {
    const mod = await vite.ssrLoadModule("/src/ambient-policy.ts");
    const { render } = await import("lit");
    const state = mod.ambientPolicyState;
    const host = document.querySelector("main")!;
    const redraw = () => render(mod.ambientPolicySection(state.scope), host);
    const save = () => host.querySelector<HTMLButtonElement>(".ambient-policy-actions button")!;
    const edit = () => {
      const input = host.querySelector<HTMLTextAreaElement>("#ambient-orders")!;
      input.value = "after";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    };
    await t.test(
      "project orders remain editable; Slack channel and group controls still send complete payloads",
      async () => {
        for (const [scope, supportsAmbient] of [
          ["group:web-project-317", false],
          ["group:G317", true],
          ["channel:C317", true],
          ["group:web-project-317", false],
        ] as const) {
          let sent: any;
          globalThis.fetch = async (_url, init) => {
            if (init?.method === "PUT") sent = JSON.parse(String(init.body));
            return Response.json({ policy: policy(supportsAmbient) });
          };
          await mod.loadAmbientPolicy(scope, redraw);
          assert.equal(host.querySelector<HTMLTextAreaElement>("#ambient-orders")!.value, "keep");
          assert.equal(!!host.querySelector("#ambient-enabled"), supportsAmbient);
          assert.equal(!!host.querySelector(".ambient-bot-add"), supportsAmbient);
          if (!supportsAmbient) assert.match(host.textContent!, /Used when QM responds in this project/);
          edit();
          save().click();
          await tick();
          assert.deepEqual(sent, {
            orders: "after",
            baseUpdatedAt: 42,
            ...(supportsAmbient ? { bots: policy(true).bots, ambientEnabled: true } : {}),
          });
        }
      },
    );
    await t.test("failed or incompatible loads cannot submit policy", async () => {
      for (const response of [
        () => Response.json({ message: "failed" }, { status: 500 }),
        () => Response.json({ policy: { orders: "old", bots: {}, updatedAt: 1 } }),
      ]) {
        mod.resetAmbientPolicy();
        let writes = 0;
        globalThis.fetch = async (_url, init) => {
          if (init?.method === "PUT") writes++;
          return response();
        };
        await mod.loadAmbientPolicy("group:web-project-317", redraw);
        edit();
        assert.equal(save().disabled, true);
        save().click();
        await tick();
        assert.equal(writes, 0);
        assert.match(host.textContent!, /failed|reload/i);
      }
    });
    await t.test("stale load and save responses cannot overwrite the newly selected scope", async () => {
      mod.resetAmbientPolicy();
      let resolve!: (r: Response) => void;
      globalThis.fetch = () =>
        new Promise<Response>((r) => {
          resolve = r;
        });
      const loading = mod.loadAmbientPolicy("group:G317", redraw);
      globalThis.fetch = async () => Response.json({ policy: policy(false) });
      await mod.loadAmbientPolicy("group:web-project-317", redraw);
      resolve(Response.json({ policy: policy(true) }));
      await loading;
      assert.equal(host.querySelector("#ambient-enabled"), null);
      globalThis.fetch = () =>
        new Promise<Response>((r) => {
          resolve = r;
        });
      edit();
      save().click();
      globalThis.fetch = async () => Response.json({ policy: { ...policy(true), orders: "new scope" } });
      await mod.loadAmbientPolicy("channel:C317", redraw);
      resolve(Response.json({ policy: { ...policy(false), orders: "stale" } }));
      await tick();
      assert.equal(state.orders, "new scope");
      assert.equal(state.notice, "");
      assert.ok(host.querySelector("#ambient-enabled"));
    });
  } finally {
    await vite.close();
    dom.window.close();
    globalThis.fetch = oldFetch;
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
