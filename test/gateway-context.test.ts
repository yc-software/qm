import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderGatewayContext } from "../src/core/gateway-context.ts";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("renders gateway + location + identifier lines", () => {
  const out = renderGatewayContext("slack", {
    location: "#eng-platform",
    details: { channel: "C0123", channel_name: "#eng-platform", thread_ts: "1718.0001" },
  });
  assert.match(out, /^## Where you are/);
  assert.match(out, /over slack, in #eng-platform/);
  assert.match(out, /- channel: C0123/);
  assert.match(out, /- channel_name: #eng-platform/);
  assert.match(out, /- thread_ts: 1718\.0001/);
});

test("gateway only (no surface-provided context) still names the gateway", () => {
  const out = renderGatewayContext("slack");
  assert.match(out, /over slack\./);
  assert.doesNotMatch(out, /Identifiers for this conversation/);
});

test("web gateway warns scheduled notifications need an external destination", () => {
  const out = renderGatewayContext("web");
  assert.match(out, /over web\./);
  assert.match(out, /web UI cannot receive future external notifications/);
  assert.match(out, /use `recipient` for a Slack DM/);
  assert.match(out, /Do not put "deliver to Slack" only inside `action`/);
});

test("surface-supplied instructions are appended verbatim (and alone are enough to render)", () => {
  const out = renderGatewayContext("slack", { location: "#eng", instructions: "To react, write [[react: eyes]]." });
  assert.match(out, /To react, write \[\[react: eyes\]\]\./);
  const only = renderGatewayContext(undefined, { instructions: "do the thing" });
  assert.match(only, /^## Where you are/);
  assert.match(only, /do the thing/);
});

test("reactionGuidance is detection-only — never rendered into the main prompt", () => {
  const out = renderGatewayContext("slack", { location: "#eng", reactionGuidance: "react with :pray:" });
  assert.doesNotMatch(out, /react with :pray:/);
  assert.equal(renderGatewayContext(undefined, { reactionGuidance: "react with :pray:" }), "");
});

test("empty when there is nothing to say", () => {
  assert.equal(renderGatewayContext(undefined), "");
  assert.equal(renderGatewayContext("", { details: {} }), "");
  assert.equal(renderGatewayContext("  ", { location: "  ", details: { "": "x", k: "  " } }), "");
});

function freshApp() {
  const config: Config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-")),
  });
  return buildApp(config);
}

test("gateway context flows into the system prompt the harness sees", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text: "!sysprompt",
    gatewayContext: { location: "a direct message with the user", details: { channel: "D9" } },
  });
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /## Where you are/);
  assert.match(res.reply ?? "", /over slack, in a direct message with the user/);
  assert.match(res.reply ?? "", /- channel: D9/);
});

test("no gateway context: prompt names the surface but adds no identifier lines", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "slack",
    actor: { externalId: "U2" },
    conversation: { kind: "dm", threadRef: "dm:U2:t1" },
    text: "!sysprompt",
  });
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /over slack\./);
  assert.doesNotMatch(res.reply ?? "", /Identifiers for this conversation/);
});

test("web prompt tells cron creators to use a real notification destination", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "web",
    actor: { externalId: "U3" },
    conversation: { kind: "dm", threadRef: "web:U3:t1" },
    text: "!sysprompt",
  });
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /web UI cannot receive future external notifications/);
  assert.match(res.reply ?? "", /recipient.*Slack DM/s);
  assert.match(res.reply ?? "", /Do not put "deliver to Slack" only inside `action`/);
});

test("triggered destination turns tell the agent to return the deliverable, not self-send it", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "cron:c1:slot" },
    text: "!sysprompt",
    triggered: true,
    triggerDestination: {
      type: "principal",
      target: "U1",
      audienceScopeId: scopeId("personal", "U1"),
      onBehalfOf: "U1",
    },
  });
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /platform-managed destination/);
  assert.match(res.reply ?? "", /Core will deliver your final reply/);
  assert.match(res.reply ?? "", /Do not call Slack, email, chat, or other send APIs/);
});
