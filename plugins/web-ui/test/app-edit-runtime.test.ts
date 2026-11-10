import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { browserEnv } from "./browser-env.ts";
import type { ComposerSurface, ConvCtx } from "../src/conv-types.ts";
import type { RuntimeConfig } from "../src/runtime-config-cache.ts";
import { metadata } from "./model-metadata.ts";

test("app edit chats start on the app edit runtime and keep a person's pick", async () => {
  const models = ["alpha", "gpt-6.1-sol", "gpt-6.1-sol-ultrafast"];
  const config: RuntimeConfig = {
    scopeId: "personal:tester",
    models,
    modelCatalog: Object.fromEntries(models.map((id) => [id, metadata(id)])),
    orgDefault: { modelId: "alpha", revision: 1 },
    effective: { modelId: "alpha" },
    appEditRuntime: { modelId: "gpt-6.1-sol-ultrafast" },
    scopeOverride: null,
    upgradeAvailable: false,
  };
  const env = await browserEnv({ fetch: async () => Response.json(config) });
  localStorage.setItem(
    "web-ui:loadout",
    JSON.stringify([
      { value: "gpt-6.1-sol", effort: "high", fast: false },
      { value: "alpha", effort: "auto", fast: false },
    ]),
  );
  const { vite } = env;
  const composers: ComposerSurface[] = [];
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { createComposerSurface } = await vite.ssrLoadModule("/src/composer.ts");
    const { render } = await vite.ssrLoadModule("lit");
    appState.me = { user: "tester", org: "test" };
    const mount = async (threadRef: string) => {
      const host = document.createElement("section");
      document.body.append(host);
      const agent = { state: { isStreaming: false, messages: [] } } as unknown as Agent;
      const ctx = {
        pane: false,
        chat: {
          state: { agent, host, threadRef, sessionId: null, scopeId: null, resolvingApprovals: new Set<string>() },
          activePendingApprovals: () => [],
          hasUnresolvedApproval: () => false,
          turnRuntime: () => null,
          hasLiveRun: () => false,
          isStopping: () => false,
          drawActiveChat: () => render(composer.composerForm(agent), host),
        },
      } as unknown as ConvCtx;
      const composer = createComposerSurface(ctx) as ComposerSurface;
      ctx.composer = composer;
      composers.push(composer);
      await composer.refreshRuntimeSelection(null, agent);
      return { agent, host, composer };
    };

    const drawer = await mount("web:tester:app-edit:demo");
    assert.equal(drawer.agent.state.model.id, "gpt-6.1-sol-ultrafast");
    assert.equal(drawer.composer.followsDefault(), false, "drawer turns name the app edit model");
    const chat = await mount("web:tester:default");
    assert.equal(chat.agent.state.model.id, "alpha");
    const otherPersonsDrawer = await mount("web:someone-else:app-edit:demo");
    assert.equal(otherPersonsDrawer.agent.state.model.id, "alpha");

    drawer.host.querySelector<HTMLButtonElement>(".loadout-button")!.click();
    const alpha = [...drawer.host.querySelectorAll<HTMLButtonElement>(".loadout-pick")].find(
      (row) => row.querySelector(".loadout-name")?.textContent === "alpha",
    );
    assert.ok(alpha);
    alpha.click();
    assert.equal(drawer.agent.state.model.id, "alpha");
    drawer.composer.dispose();
    const reopened = await mount("web:tester:app-edit:demo");
    assert.equal(reopened.agent.state.model.id, "alpha");
  } finally {
    for (const composer of composers) composer.dispose();
    await env.close();
  }
});
