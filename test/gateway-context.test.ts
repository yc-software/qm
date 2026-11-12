import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderGatewayContext, shownPlace, webSurfaceLabel } from "../src/core/orchestrator/prompt-blocks.ts";
import { buildApp } from "./support/build-app.ts";
import type { Config } from "../src/config.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("renders gateway + location + identifier lines", () => {
  const out = renderGatewayContext("slack", {
    location: "#eng-platform",
    hostIds: { channel: "C0123", thread_ts: "1718.0001" },
    details: { channel_name: "#eng-platform" },
  });
  assert.match(out, /^## Where you are/);
  assert.match(out, /^Slack, in #eng-platform\.$/m);
  assert.match(out, /- channel: C0123/);
  assert.match(out, /- channel_name: #eng-platform/);
  assert.match(out, /- thread_ts: 1718\.0001/);
});

test("the screen reads the place the prompt shows, and never host IDs", () => {
  const ctx = { location: "Room", details: { location: "Detail" }, hostIds: { channel: "C1" } };
  assert.deepEqual(shownPlace("slack", ctx, true), { details: { location: "Detail" } });
  assert.deepEqual(shownPlace(undefined, ctx, true), { location: "Room", details: { location: "Detail" } });
  assert.match(renderGatewayContext(undefined, ctx, "ada"), /^In Room\.$/m);
  const twice = { details: { " topic": "Hidden", topic: "Shown" } };
  assert.deepEqual(shownPlace("slack", twice, false), { details: { topic: "Shown" } });
  assert.doesNotMatch(renderGatewayContext("slack", twice), /Hidden/);
  assert.doesNotMatch(renderGatewayContext("web", ctx, ""), /Room/);
});

test("gateway only (no surface-provided context) still names the gateway", () => {
  const out = renderGatewayContext("slack");
  assert.match(out, /^Slack conversation\.$/m);
  assert.doesNotMatch(out, /Identifiers for this conversation/);
});

test("web gateway keeps scheduled deliveries in the web conversation by default", () => {
  const out = renderGatewayContext("web", undefined, "ada");
  assert.match(out, /^Web DM with ada\.$/m);
  assert.match(out, /post back here/);
});

test("surface-supplied instructions are appended verbatim (and alone are enough to render)", () => {
  const out = renderGatewayContext("slack", { location: "#eng", instructions: "To react, write [[react: eyes]]." });
  assert.match(out, /To react, write \[\[react: eyes\]\]\./);
  const only = renderGatewayContext(undefined, { instructions: "do the thing" });
  assert.match(only, /^## Where you are/);
  assert.match(only, /do the thing/);
});

test("a web chat relayed by another app says so and that web UI widgets won't render there", () => {
  assert.equal(webSurfaceLabel("QM", false), "the QM web app");
  assert.match(webSurfaceLabel("QM", true), /^another app that relays this chat to QM .*non-web paths/);
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

test("gateway context flows into the system prompt the agent sees", async () => {
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
  assert.match(res.reply ?? "", /^Slack DM with U1\.$/m);
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
  assert.match(res.reply ?? "", /^Slack DM with U2\.$/m);
  assert.doesNotMatch(res.reply ?? "", /Identifiers for this conversation/);
});

test("a DM names the person by the name stored at sign-in, then by email, never by the raw sign-in id", async () => {
  const { app, users } = freshApp();
  const dmWith = async (externalId: string) => {
    const res = await app.turn({
      surface: "web",
      actor: { externalId },
      conversation: { kind: "dm", threadRef: `web:${externalId}:t1` },
      text: "!sysprompt",
    });
    assert.equal(res.status, "ok", JSON.stringify(res));
    return res.reply ?? "";
  };
  await users.setDisplayName("oidc:issuer:ada", "Ada Founder");
  const named = await dmWith("oidc:issuer:ada");
  assert.match(named, /^Web DM with Ada Founder\.$/m);
  assert.doesNotMatch(named, /oidc:issuer:ada\./);
  assert.match(await dmWith("grace@example.com"), /^Web DM with grace@example\.com\.$/m);
  assert.match(await dmWith("oidc:issuer:nobody"), /^Web DM with Unknown person\.$/m);
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
  assert.match(res.reply ?? "", /^Crons you create here post back here\.$/m);
  assert.doesNotMatch(res.reply ?? "", /cannot receive future external notifications/);
});

test("triggered destination turns tell the agent to return the deliverable, not self-send it", async () => {
  const { app } = freshApp();
  const res = await app.turn({
    surface: "cron",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "cron:c1:slot" },
    text: "!sysprompt",
    origin: {
      kind: "automation",
      destination: {
        type: "principal",
        target: "U1",
        audienceScopeId: scopeId("personal", "U1"),
        onBehalfOf: "U1",
      },
    },
  });
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /platform-managed destination/);
  assert.match(res.reply ?? "", /Core will deliver your final reply/);
  assert.match(res.reply ?? "", /Do not call Slack, email, chat, or other send APIs/);
});

test("a web turn's default delivery destination is its own web session", async () => {
  const { deliveryCandidatesFor } = await import("../src/core/orchestrator/turn-helpers.ts");
  const delivery = deliveryCandidatesFor(
    { surface: "web", deliveryTarget: "web:session-1" },
    scopeId("personal", "a@example.com"),
  );
  const chosen = delivery.candidates.find((c) => c.key === delivery.defaultKey);
  assert.equal(chosen?.type, "web");
  assert.equal(chosen?.target, "web:session-1");
});
