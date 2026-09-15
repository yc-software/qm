import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
async function render(data: Record<string, unknown>) {
  const elements = new Map<string, any>();
  const start = html.indexOf("async function loadSlackInstallation() {");
  const end = html.indexOf('$("slack-installation-start").onclick', start);
  await vm.runInNewContext(html.slice(start, end) + "loadSlackInstallation()", {
    $: (id: string) => {
      assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
      if (!elements.has(id)) {
        const hidden = new Set<string>();
        elements.set(id, {
          open: false,
          classList: {
            toggle: (name: string, value: boolean) => (value ? hidden.add(name) : hidden.delete(name)),
            contains: (name: string) => hidden.has(name),
          },
        });
      }
      return elements.get(id);
    },
    api: async () => ({ ok: true, data }),
    slackLinkStarted: false,
    URLSearchParams,
    location: { search: "" },
  });
  return (id: string) => elements.get(id);
}

test("public QM leads with manifest setup and hides hosted actions and instructions", async () => {
  const el = await render({
    configured: false,
    source: "none",
    createUrl: "https://api.slack.com/apps?manifest_json=test",
  });
  assert.equal(el("slack-installation-start").classList.contains("hidden"), true);
  assert.equal(el("slack-own-app-guide").open, true);
  assert.equal(el("slack-own-app-label").textContent, "Set up Slack");
  assert.equal(el("slack-hosted-switch").classList.contains("hidden"), true);
  assert.match(el("slack-installation-description").textContent, /manifest/);
  assert.match(el("slack-installation-create").href, /manifest_json/);
});

test("hosted connection offers re-add and keeps custom setup secondary", async () => {
  const el = await render({ configured: true, source: "service", installAvailable: true, teamName: "Development YC" });
  assert.equal(el("slack-installation-start-label").textContent, "Re-add to Slack");
  assert.equal(el("slack-installation-start").disabled, false);
  assert.equal(el("slack-installation-state").textContent, "Development YC");
  assert.equal(el("slack-own-app-label").textContent, "Use your own Slack app");
  assert.equal(el("slack-own-app-guide"), undefined);
});

test("custom connection cannot be replaced by hosted OAuth without disconnecting", async () => {
  const el = await render({ configured: true, source: "admin", installAvailable: true });
  assert.equal(el("slack-installation-start").disabled, true);
  assert.equal(el("slack-installation-description").textContent, "Custom app");
});

test("managed credentials alone do not block retry of an unfinished route activation", () => {
  assert.match(
    html,
    /r\.data\.configured && !\(r\.data\.source === "service" && r\.data\.setup\?\.connected === false\)/,
  );
});
