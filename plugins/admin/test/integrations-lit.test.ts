import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { configure, ConnectorsState, SlackSetting, SlackInstallationState } from "../ui/integrations-state.ts";
const bundle = buildSync({
  entryPoints: [new URL("../ui/integrations.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "integrationsUI",
}).outputFiles[0].text;
function setup() {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    runScripts: "outside-only",
    url: "http://localhost/admin/slack-settings",
  });
  dom.window.eval(
    bundle +
      ';window.ui=integrationsUI;ui.mountCards();ui.configure({api:async()=>({ok:true,data:{}}),orgScope:()=>"org:test",connectorName:id=>id,fmtTime:x=>x});',
  );
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}
test("Slack settings are state driven and preserve newer drafts when committing", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'ui.loadScope({externalSlackParticipants:false,internalMemberOverrides:[],channelHeaderPinDefault:false,ackEmoji:[]},"org:test")',
    );
    const doc = dom.window.document;
    const radio = doc.querySelector<HTMLInputElement>('[name="external-slack-choice"][value="on"]')!;
    radio.click();
    assert.equal(dom.window.eval('ui.collect("external-slack-participants").on'), true);
    assert.equal(doc.querySelector<HTMLButtonElement>('[data-save="external-slack-participants"]')!.disabled, false);
    dom.window.eval('ui.status("external-slack-participants","Saving","saving")');
    doc.querySelector<HTMLInputElement>('[name="external-slack-choice"][value="off"]')!.click();
    dom.window.eval('ui.commit("external-slack-participants",{on:true})');
    assert.equal(doc.getElementById("st-external-slack-participants")!.textContent, "Unsaved changes");
    assert.equal(doc.querySelector<HTMLInputElement>("#external-slack-participants")!.checked, false);
  } finally {
    dom.window.close();
  }
});
test("Slack member overrides normalize from the draft and update the count", () => {
  const s = new SlackSetting("internal-member-overrides");
  s.load([], "org:test", true);
  s.change({ text: " User@Example.com,USER@example.com\n U123 " });
  assert.deepEqual(s.collect(), { members: ["user@example.com", "u123"] });
  assert.equal(s.dirty, true);
});
test("Connector editor renders guides and keeps fields and focus stable while typing", () => {
  const dom = setup();
  try {
    dom.window.eval(
      'ui.connectors.catalog=[{provider:"github",setupGuide:{url:"https://example.com",console:"GitHub",steps:["Create app"]},redirectPath:"github",scopes:["repo"]}];ui.connectors.render()',
    );
    const doc = dom.window.document;
    doc.getElementById("add-oauth-app")!.click();
    const input = doc.getElementById("conn-client-id") as HTMLInputElement;
    input.value = "my client";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(doc.activeElement, input);
    assert.equal(dom.window.eval("ui.connectors.draft.clientId"), "my client");
    assert.match(
      doc.getElementById("conn-guide")!.textContent!,
      /Callback URL: http:\/\/localhost\/v1\/connectors\/oauth\/github/,
    );
    assert.equal(doc.getElementById("conn-editor")!.classList.contains("hidden"), false);
    doc.getElementById("conn-reset")!.click();
    assert.equal(doc.getElementById("conn-editor")!.classList.contains("hidden"), true);
  } finally {
    dom.window.close();
  }
});
test("Connector saves use captured payloads and retain edits made during a request", async () => {
  let resolve!: (value: any) => void;
  const bodies: unknown[] = [];
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: async (method, _path, body) => {
      if (method === "PUT") {
        bodies.push(body);
        return new Promise((r) => (resolve = r));
      }
      return { ok: true, data: { catalog: [], connectors: [] } };
    },
  });
  const s = new ConnectorsState();
  s.edit({ provider: "github" });
  s.change("clientId", "first");
  s.change("clientSecret", "secret");
  const saving = s.save();
  s.change("clientId", "newer");
  resolve({ ok: true, data: {} });
  await saving;
  assert.deepEqual(bodies, [{ provider: "github", clientId: "first", clientSecret: "secret", enabled: true }]);
  assert.equal(s.draft.clientId, "newer");
  assert.equal(s.editor, true);
  assert.equal(s.saving, false);
});
test("Connector load ignores out of order responses and preserves the open editor", async () => {
  const pending: Array<(value: any) => void> = [];
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: () => new Promise((r) => pending.push(r)),
  });
  const s = new ConnectorsState();
  const old = s.load();
  const latest = s.load();
  pending[2]({ ok: true, data: { catalog: [{ provider: "new" }] } });
  pending[3]({ ok: true, data: { connectors: [] } });
  await latest;
  s.edit({ provider: "new" });
  s.change("clientId", "draft");
  pending[0]({ ok: true, data: { catalog: [{ provider: "stale" }] } });
  pending[1]({ ok: true, data: { connectors: [] } });
  await old;
  assert.equal(s.catalog[0].provider, "new");
  assert.equal(s.draft.clientId, "draft");
});
test("Slack connection validates token drafts before submitting", async () => {
  let called = false;
  configure({
    orgScope: () => "org:test",
    connectorName: (x) => x,
    fmtTime: (x) => x,
    api: async () => {
      called = true;
      return { ok: true, data: {} };
    },
  });
  const s = new SlackInstallationState();
  s.botToken = "xoxb-example";
  await s.save();
  assert.equal(called, false);
  assert.equal(s.message, "Both Slack tokens are required.");
});
