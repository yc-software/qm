import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DurableMap } from "../src/persistence/durable-map.ts";

function createMemoryDurableMap<T>(): DurableMap<T> {
  const m = new Map<string, T>();
  return {
    get: async (id: string) => m.get(id) ?? null,
    put: async (id: string, v: T) => {
      m.set(id, v);
    },
    delete: async (id: string) => {
      m.delete(id);
    },
    entries: async () => [...m.entries()],
  } as unknown as DurableMap<T>;
}
import { createPersonaSlackStore, personaSlackManifest } from "../src/surfaces/persona-slack.ts";
import { withTenant } from "../src/tenants/context.ts";

function fakeRes() {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead(this: { headersSent: boolean }, s: number, h?: Record<string, string>) {
      status = s;
      this.headersSent = true;
      if (h) Object.assign(headers, h);
    },
    end(chunk?: string) {
      if (chunk) body += chunk;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}

function fakeReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  req.method = "POST";
  req.headers = headers;
  return req;
}

function sign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return { "x-slack-signature": sig, "x-slack-request-timestamp": String(ts) };
}

describe("personaSlackStore", () => {
  it("builds an HTTP Events manifest with persona name, callback, and optional orgDeploy", () => {
    const m = personaSlackManifest({
      personaId: "p1",
      name: "Release Bot",
      description: "Tracks releases",
      publicUrl: "https://qm.example.com/",
      orgDeploy: true,
    });
    assert.equal(m.display_information.name, "Release Bot");
    assert.equal(m.display_information.description, "Tracks releases");
    assert.equal(m.settings.socket_mode_enabled, false);
    assert.equal(m.settings.org_deploy_enabled, true);
    assert.equal(m.settings.event_subscriptions.request_url, "https://qm.example.com/slack/events/persona/p1");
    assert.deepEqual(m.oauth_config.redirect_urls, ["https://qm.example.com/v1/personas/p1/slack/oauth/callback"]);
  });

  it("rotates config token, creates app, answers in-flight url_verification, completes OAuth, dispatches signed events, and deletes remotely", () =>
    withTenant("00000000-0000-4000-8000-000000000001", async () => {
      const calls: string[] = [];
      let verifyResult: { status: number; body: string } | undefined;

      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = url.split("/api/")[1]!;
        calls.push(method);
        if (method === "tooling.tokens.rotate") {
          return new Response(
            JSON.stringify({
              ok: true,
              token: "xoxe.xoxp-rotated",
              refresh_token: "xoxe-1-new-refresh",
              team_id: "T123",
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          );
        }
        if (method === "apps.manifest.create") {
          const out = fakeRes();
          await storeRef.handleEvent(
            fakeReq(JSON.stringify({ type: "url_verification", challenge: "chal-123" })),
            out.res,
            "p1",
          );
          verifyResult = { status: out.status, body: out.body };
          return new Response(
            JSON.stringify({
              ok: true,
              app_id: "A999",
              credentials: {
                client_id: "cid-1",
                client_secret: "csec-1",
                signing_secret: "ssec-1",
              },
            }),
          );
        }
        if (method === "oauth.v2.access") {
          const form = new URLSearchParams(String(init?.body ?? ""));
          assert.equal(form.get("code"), "oauth-code");
          assert.equal(form.get("client_id"), "cid-1");
          assert.equal(form.get("client_secret"), "csec-1");
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: "xoxb-persona-1",
              bot_user_id: "U_BOT",
              team: { id: "T123", name: "Acme" },
            }),
          );
        }
        if (method === "apps.manifest.delete") {
          return new Response(JSON.stringify({ ok: true }));
        }
        throw new Error(`unexpected method ${method}`);
      };

      const storeRef = createPersonaSlackStore({
        appsMap: createMemoryDurableMap(),
        configTokenMap: createMemoryDurableMap(),
        keyMaterial: "test-secret-key",
        publicUrl: "https://qm.example.com",
        fetchImpl,
      });

      const tokStatus = await storeRef.setConfigToken({
        refreshToken: "xoxe-1-initial",
        updatedBy: "admin@example.com",
      });
      assert.equal(tokStatus.configured, true);
      assert.equal(tokStatus.hasRefreshToken, true);
      assert.equal(tokStatus.teamId, "T123");

      const pending = await storeRef.createApp({
        persona: { id: "p1", name: "Ops Helper" },
        actorId: "admin@example.com",
      });
      assert.equal(pending.status, "pending_install");
      assert.equal(pending.appId, "A999");
      assert.ok(pending.oauthAuthorizeUrl?.includes("client_id=cid-1"));
      assert.equal(verifyResult?.status, 200);
      assert.deepEqual(JSON.parse(verifyResult!.body), { challenge: "chal-123" });

      const stateParam = new URL(pending.oauthAuthorizeUrl!).searchParams.get("state")!;
      await assert.rejects(() => storeRef.completeOAuth("p1", "oauth-code", "wrong-state"), /Invalid OAuth state/);

      let changes = 0;
      storeRef.onChange(() => changes++);
      const connected = await storeRef.completeOAuth("p1", "oauth-code", stateParam);
      assert.equal(connected.status, "connected");
      assert.equal(connected.botToken, "xoxb-persona-1");
      assert.equal(connected.teamName, "Acme");
      assert.equal(changes, 1);

      const badSig = fakeRes();
      await storeRef.handleEvent(
        fakeReq(JSON.stringify({ type: "event_callback", event: { type: "app_mention" } })),
        badSig.res,
        "p1",
      );
      assert.equal(badSig.status, 401);

      let received: unknown;
      const receiver = storeRef.receiver("p1");
      receiver.init({
        async processEvent(ev: { body: unknown; ack: () => Promise<void> }) {
          received = ev.body;
          await ev.ack();
        },
      } as never);
      await receiver.start();

      const payload = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: { type: "app_mention" } });
      const goodRes = fakeRes();
      await storeRef.handleEvent(fakeReq(payload, sign("ssec-1", payload)), goodRes.res, "p1");
      assert.equal(goodRes.status, 200);
      assert.deepEqual(received, JSON.parse(payload));

      await receiver.stop();
      await storeRef.disconnect("p1", { deleteRemote: true });
      assert.equal(await storeRef.get("p1"), null);
      assert.ok(calls.includes("apps.manifest.delete"));
    }));

  it("supports manual BYO Slack app attachment via auth.test", async () => {
    const store = createPersonaSlackStore({
      appsMap: createMemoryDurableMap(),
      configTokenMap: createMemoryDurableMap(),
      keyMaterial: "test-secret-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, user_id: "U_MANUAL", team_id: "T_M", team: "ManualTeam" })),
    });
    const app = await store.attachManual({
      personaId: "p2",
      botToken: "xoxb-manual",
      signingSecret: "ssec-manual",
      appId: "A_MAN",
      actorId: "owner@example.com",
    });
    assert.equal(app.status, "connected");
    assert.equal(app.botUserId, "U_MANUAL");
    assert.equal(app.teamName, "ManualTeam");
  });
});
