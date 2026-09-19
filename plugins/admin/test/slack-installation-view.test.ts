import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";
const bundle = buildSync({
  entryPoints: [new URL("../ui/integrations.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ui",
}).outputFiles[0].text;
async function render(data: Record<string, unknown>) {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    runScripts: "outside-only",
    url: "http://localhost/admin/slack-settings",
  });
  dom.window.eval(
    bundle +
      ";window.ui=ui;ui.mountCards();ui.configure({api:async()=>({ok:true,data:" +
      JSON.stringify(data) +
      '}),orgScope:()=>"org:test",connectorName:x=>x,fmtTime:x=>x});',
  );
  await dom.window.eval("ui.loadSlackInstallation()");
  const result = (id: string) => dom.window.document.getElementById(id) as any;
  test.after(() => dom.window.close());
  return result;
}

test("public QM leads with manifest setup and hides hosted actions and instructions", async () => {
  const el = await render({
    configured: false,
    source: "none",
    createUrl: "https://api.slack.com/apps?manifest_json=test",
  });
  assert.equal(el("slack-installation-start").classList.contains("hidden"), true);
  assert.equal(el("slack-own-app-guide").open, true);
  assert.equal(el("slack-own-app-label").textContent.trim(), "Set up Slack");
  assert.equal(el("slack-hosted-switch").classList.contains("hidden"), true);
  assert.match(el("slack-installation-description").textContent.trim(), /manifest/);
  assert.match(el("slack-installation-create").href, /manifest_json/);
});

test("hosted connection offers re-add and keeps custom setup secondary", async () => {
  const el = await render({ configured: true, source: "service", installAvailable: true, teamName: "Development YC" });
  assert.equal(el("slack-installation-start-label").textContent.trim(), "Re-add to Slack");
  assert.equal(el("slack-installation-start").disabled, false);
  assert.equal(el("slack-installation-state").textContent.trim(), "Development YC");
  assert.equal(el("slack-own-app-label").textContent.trim(), "Use your own Slack app");
  assert.equal(el("slack-own-app-guide").open, false);
});

test("custom connection cannot be replaced by hosted OAuth without disconnecting", async () => {
  const el = await render({ configured: true, source: "admin", installAvailable: true });
  assert.equal(el("slack-installation-start").disabled, true);
  assert.equal(el("slack-installation-description").textContent.trim(), "Custom app");
});

test("managed credentials alone do not block retry of an unfinished route activation", async () => {
  const dom = new JSDOM('<template data-integrations-card="card-slack-installation"></template>', {
    runScripts: "outside-only",
    url: "http://localhost/admin/slack-settings?slack=install",
  });
  try {
    dom.window.eval(
      bundle +
        ';window.ui=ui;window.methods=[];ui.mountCards();ui.configure({api:async(method)=>{methods.push(method);return {ok:true,data:{configured:true,source:"service",installAvailable:true,setup:{connected:false}}}},orgScope:()=>"org:test"});',
    );
    await dom.window.eval("ui.loadSlackInstallation()");
    assert.deepEqual(JSON.parse(String(dom.window.eval("JSON.stringify(methods)"))), ["GET", "POST"]);
  } finally {
    dom.window.close();
  }
});
