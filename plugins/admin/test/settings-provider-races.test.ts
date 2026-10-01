import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
const bundle = buildSync({
  entryPoints: [new URL("../ui/settings-providers.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "providers",
  platform: "browser",
}).outputFiles[0].text;
function fixture() {
  const dom = new JSDOM('<template data-settings-card="custom-provider-dialog"></template>', {
    runScripts: "outside-only",
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  dom.window.eval(bundle + ";window.providers = providers;");
  const ui = (dom.window as any).providers;
  const requests: Array<{ resolve: (value: any) => void; reject: (reason: unknown) => void }> = [];
  let refreshes = 0;
  ui.configureProviders({
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    refresh: async () => {
      refreshes++;
    },
  });
  ui.mountProviders();
  const open = (name: string) =>
    ui.openProvider({
      id: name,
      name,
      baseUrl: "https://api.example.com",
      protocol: "openai",
      models: [{ id: "test" }],
    });
  return { dom, ui, requests, open, refreshes: () => refreshes };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("custom provider save reports persisted snapshot while retaining newer edits", async () => {
  const { dom, ui, requests, open, refreshes } = fixture();
  open("first");
  dom.window.document.getElementById("custom-provider-save")!.click();
  const input = dom.window.document.getElementById("custom-provider-name") as HTMLInputElement;
  input.value = "Newer name";
  input.dispatchEvent(new dom.window.Event("input"));
  requests[0].resolve({ ok: true });
  await tick();
  assert.equal(ui.provider.draft.name, "Newer name");
  assert.equal(ui.provider.saving, false);
  assert.equal(refreshes(), 1);
  assert.match(ui.provider.message, /newer edits are not saved/);
  assert.equal((dom.window.document.getElementById("custom-provider-dialog") as HTMLDialogElement).open, true);
  dom.window.close();
});

test("old provider save cannot clear pending state in a reopened dialog", async () => {
  const { dom, ui, requests, open } = fixture();
  open("first");
  dom.window.document.getElementById("custom-provider-save")!.click();
  dom.window.document.getElementById("custom-provider-cancel")!.click();
  open("second");
  dom.window.document.getElementById("custom-provider-save")!.click();
  requests[0].reject(new Error("old error"));
  await tick();
  assert.equal(ui.provider.saving, true);
  assert.equal(ui.provider.draft.id, "second");
  assert.equal(ui.provider.message, "Saving…");
  requests[1].resolve({ ok: true });
  await tick();
  assert.equal(ui.provider.saving, false);
  assert.equal((dom.window.document.getElementById("custom-provider-dialog") as HTMLDialogElement).open, false);
  dom.window.close();
});

test("editing a provider keeps model fields the form does not show", async () => {
  const { dom, ui, requests } = fixture();
  ui.openProvider({
    id: "acme",
    name: "Acme",
    baseUrl: "https://api.example.com",
    protocol: "openai",
    models: [{ id: "acme-large", name: "Large", input: 2, output: 8, contextWindow: 1000 }],
  });
  ui.provider.draft.models = "acme-large | Larger";
  ui.provider.draft.name = "Acme 2";
  assert.deepEqual(JSON.parse(JSON.stringify(ui.providerBody().models)), [
    { id: "acme-large", name: "Larger", input: 2, output: 8 },
  ]);
  ui.openProvider();
  ui.provider.draft.models = "acme-large";
  assert.deepEqual(JSON.parse(JSON.stringify(ui.providerBody().models)), [{ id: "acme-large" }]);
  assert.equal(requests.length, 0);
  dom.window.close();
});
