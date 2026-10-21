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
const PICKER_CATALOG =
  '[{provider:"github",setupGuide:{url:"https://example.com",console:"GitHub",steps:["Create app"]},redirectPath:"github/callback",scopes:["repo"]},{provider:"zoom",configured:true,setupGuide:{url:"https://example.com",console:"Zoom",steps:["Create app"]},redirectPath:"zoom/callback",scopes:[]}]';
function configurePicker(dom: JSDOM, connectors: string) {
  dom.window.eval(
    `ui.configure({api:async(m,p)=>p==="/api/connector-catalog"?{ok:true,data:{catalog:${PICKER_CATALOG}}}:{ok:true,data:{connectors:${connectors}}},orgScope:()=>"org:test",connectorName:id=>id,fmtTime:x=>x})`,
  );
}
test("Connector picker lists the catalog, follows the draft, and locks while editing", async () => {
  const dom = setup();
  try {
    configurePicker(dom, '[{provider:"github",clientId:"gid"}]');
    await dom.window.eval("ui.loadConnectors()");
    const doc = dom.window.document;
    doc.getElementById("add-oauth-app")!.click();
    const select = doc.getElementById("conn-provider") as HTMLSelectElement;
    assert.deepEqual(
      [...select.options].map((o) => [o.value, o.textContent!.trim()]),
      [
        ["github", "github"],
        ["zoom", "zoom (configured)"],
      ],
    );
    assert.equal(select.value, "github");
    assert.equal(select.disabled, false);
    select.value = "zoom";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(dom.window.eval("ui.connectors.draft.provider"), "zoom");
    assert.match(doc.getElementById("conn-guide")!.textContent!, /oauth\/zoom\/callback/);
    dom.window.eval('ui.connectors.edit({provider:"github",clientId:"gid"})');
    assert.equal(select.value, "github");
    assert.equal(select.disabled, true);
    dom.window.eval('ui.connectors.edit({provider:"zoom",inherited:true})');
    assert.equal(select.value, "zoom");
    assert.equal(select.disabled, false);
  } finally {
    dom.window.close();
  }
});
test("Connector picker settles on a real provider when the catalog arrives after the editor opens", async () => {
  const dom = setup();
  try {
    const doc = dom.window.document;
    doc.getElementById("add-oauth-app")!.click();
    configurePicker(dom, "[]");
    await dom.window.eval("ui.loadConnectors()");
    const select = doc.getElementById("conn-provider") as HTMLSelectElement;
    assert.equal(dom.window.eval("ui.connectors.draft.provider"), "github");
    assert.equal(select.value, "github");
    assert.match(doc.getElementById("conn-guide")!.textContent!, /oauth\/github\/callback/);
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
const ASANA = {
  provider: "asana",
  label: "Asana",
  authUrl: "https://app.asana.com/-/oauth_authorize",
  tokenUrl: "https://app.asana.com/-/oauth_token",
  hosts: ["app.asana.com"],
  scopes: [],
  clientAuth: "body",
};
function providerApi(dom: JSDOM, initial: unknown[]) {
  dom.window
    .eval(`window.puts=[];window.saved=${JSON.stringify(initial)};window.reply=null;window.apps=[];window.confirm=()=>true;
    ui.configure({orgScope:()=>"org:test",connectorName:id=>id,fmtTime:x=>x,api:async(m,p,b)=>{
      if(m==="PUT"){puts.push([p,b]);if(reply)return reply;
        saved=b.delete?saved.filter(x=>x.provider!==b.provider):[...saved.filter(x=>x.provider!==b.provider),b];return{ok:true,data:{ok:true}}}
      if(p==="/api/connector-catalog")return{ok:true,data:{catalog:[{provider:"github",label:"GitHub",redirectPath:"github/callback"},...saved.map(x=>({provider:x.provider,label:x.label,redirectPath:x.provider+"/callback",scopes:x.scopes,setupGuide:{console:x.label,url:"",steps:[]}}))]}};
      return{ok:true,data:{connectors:apps,connectorProviders:saved}}}})`);
  return {
    puts: () => JSON.parse(dom.window.eval("JSON.stringify(puts)") as string),
    reply: (value: unknown) => dom.window.eval(`reply=${JSON.stringify(value)}`),
  };
}
function type(dom: JSDOM, id: string, value: string) {
  const el = dom.window.document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}
const settle = () => new Promise((r) => setTimeout(r, 0));
test("Custom provider form shows server errors, saves the record, and feeds the OAuth app picker", async () => {
  const dom = setup();
  try {
    const api = providerApi(dom, []);
    await dom.window.eval("ui.loadConnectors()");
    const doc = dom.window.document;
    assert.equal(doc.getElementById("op-list")!.textContent!.trim(), "No custom providers.");
    doc.getElementById("add-oauth-provider")!.click();
    assert.equal(doc.getElementById("op-editor")!.classList.contains("hidden"), false);
    const status = () => doc.getElementById("st-oauth-providers")!.textContent;
    const save = async () => {
      doc.getElementById("op-save")!.click();
      await settle();
    };
    type(dom, "op-name", "asana");
    assert.match(
      doc.getElementById("op-redirect")!.textContent!,
      /http:\/\/localhost\/v1\/connectors\/oauth\/asana\/callback/,
    );
    type(dom, "op-label", " Asana ");
    type(dom, "op-auth-url", "https://app.asana.com/-/oauth_authorize");
    type(dom, "op-token-url", "https://app.asana.com/-/oauth_token");
    type(dom, "op-hosts", "https://app.asana.com/api/1.0");
    type(dom, "op-client-auth", "body");
    api.reply({
      ok: false,
      status: 400,
      data: { message: "hosts.0: must be a bare hostname such as api.example.com" },
    });
    await save();
    assert.equal(status(), "hosts.0: must be a bare hostname such as api.example.com");
    assert.equal(doc.getElementById("op-editor")!.classList.contains("hidden"), false);
    api.reply({ ok: false, status: 502, data: null });
    await save();
    assert.equal(status(), "Save failed. (HTTP 502)");
    api.reply(null);
    type(dom, "op-hosts", "app.asana.com\n");
    type(dom, "op-auth-params", "access_type");
    await save();
    assert.equal(status(), "Use key=value for authorization parameters, one per line.");
    assert.equal(api.puts().length, 2);
    type(dom, "op-auth-params", "");
    await save();
    await settle();
    assert.deepEqual(api.puts().at(-1), ["/api/scopes/org%3Atest/connector-providers", ASANA]);

    assert.equal(status(), "Saved. Add its OAuth app above to make it linkable.");
    assert.equal(doc.getElementById("op-editor")!.classList.contains("hidden"), true);
    doc.getElementById("add-oauth-provider")!.click();
    type(dom, "op-name", "asana");
    await save();
    assert.equal(status(), "A provider named asana already exists.");
    assert.equal(api.puts().length, 3);
    doc.getElementById("op-reset")!.click();
    assert.match(doc.getElementById("op-list")!.textContent!, /Asana\s*asana\s*app\.asana\.com\s*No OAuth app/);
    doc.body.insertAdjacentHTML("beforeend", '<section id="card-built-in-connectors"></section>');
    dom.window.eval("ui.mountBuiltIns()");
    doc.getElementById("add-oauth-app")!.click();
    const picker = doc.getElementById("conn-provider") as HTMLSelectElement;
    assert.deepEqual(
      [...picker.options].map((o) => [o.value, o.textContent!.trim()]),
      [
        ["github", "GitHub"],
        ["asana", "Asana"],
      ],
    );
    type(dom, "conn-provider", "asana");
    assert.match(doc.getElementById("conn-guide")!.textContent!, /oauth\/asana\/callback/);
    assert.equal(doc.querySelector("#conn-guide a"), null);
    assert.equal(
      doc.getElementById("built-in-connectors")!.textContent!.replace(/\s+/g, " ").trim(),
      "GitHub Requires an OAuth app Not configured",
    );
  } finally {
    dom.window.close();
  }
});
test("Custom provider edit locks identity fields, keeps unmanaged fields, and delete updates the list", async () => {
  const dom = setup();
  try {
    const api = providerApi(dom, [{ ...ASANA, authParams: { prompt: "consent" }, updatedBy: "admin", updatedAt: 1 }]);
    await dom.window.eval("ui.loadConnectors()");
    const doc = dom.window.document;
    const button = (label: string) =>
      [...doc.querySelectorAll<HTMLButtonElement>("#op-list button")].find((b) => b.textContent!.trim() === label)!;
    button("Edit").click();
    for (const id of ["op-name", "op-auth-url", "op-token-url", "op-hosts"])
      assert.equal((doc.getElementById(id) as HTMLInputElement).disabled, true);
    assert.equal((doc.getElementById("op-label") as HTMLInputElement).disabled, false);
    assert.equal((doc.getElementById("op-hosts") as HTMLTextAreaElement).value, "app.asana.com");
    assert.equal((doc.getElementById("op-auth-params") as HTMLTextAreaElement).value, "prompt=consent");
    type(dom, "op-scopes", "default, email");
    type(dom, "op-client-auth", "basic");
    doc.getElementById("op-save")!.click();
    await settle();
    await settle();
    assert.deepEqual(api.puts().at(-1)[1], {
      ...ASANA,
      scopes: ["default", "email"],
      clientAuth: "basic",
      authParams: { prompt: "consent" },
    });
    assert.equal(doc.getElementById("st-oauth-providers")!.textContent, "Saved");
    dom.window.eval('apps=[{provider:"asana",clientId:"id"}]');
    await dom.window.eval("ui.loadConnectors()");
    assert.match(doc.getElementById("op-list")!.textContent!, /OAuth app set/);
    button("Delete").click();
    assert.equal(doc.getElementById("st-oauth-providers")!.textContent, "Delete the Asana OAuth app above first.");
    dom.window.eval("apps=[]");
    await dom.window.eval("ui.loadConnectors()");
    api.reply({ ok: false, status: 409, data: { message: "remove the asana OAuth app before deleting its provider" } });
    button("Delete").click();
    await settle();
    assert.equal(
      doc.getElementById("st-oauth-providers")!.textContent,
      "remove the asana OAuth app before deleting its provider",
    );
    api.reply(null);
    button("Delete").click();
    await settle();
    await settle();
    assert.deepEqual(api.puts().at(-1)[1], { provider: "asana", delete: true });
    assert.equal(doc.getElementById("op-list")!.textContent!.trim(), "No custom providers.");
    assert.equal(doc.getElementById("st-oauth-providers")!.textContent, "Deleted");
  } finally {
    dom.window.close();
  }
});
