import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import type { App as BoltApp } from "@slack/bolt";
import { createSlackInstallationStore, type StoredSlackInstallation } from "../src/surfaces/slack-installation.ts";
import { buildSlackAppManifest } from "../src/surfaces/slack-manifest.ts";
import { withTenant } from "../src/tenants/context.ts";
import { tenantMap } from "./support/tenant-map.ts";

function mockReq(opts: { method?: string; headers?: Record<string, string>; body: string }): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = opts.method ?? "POST";
  req.headers = opts.headers ?? {};
  (req as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(opts.body, "utf8");
  };
  return req;
}

function mockRes() {
  let status = 200;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      status = code;
      if (hdrs) Object.assign(headers, hdrs);
      return this;
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()];
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
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
    json() {
      return JSON.parse(body) as Record<string, unknown>;
    },
  };
}

function signedHeaders(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": sig,
  };
}

describe("unified slackInstallationStore provisioning", () => {
  it("builds an HTTP Events manifest with name, callback, and optional orgDeploy", () => {
    const manifest = buildSlackAppManifest({
      name: "Bosun",
      description: "Fleet ops",
      eventsUrl: "https://qm.example.com/slack/events/app/p-1",
      redirectUrl: "https://qm.example.com/v1/slack/oauth/callback",
      orgDeploy: true,
    }) as {
      display_information: { name: string; description: string };
      oauth_config: { redirect_urls: string[] };
      settings: {
        socket_mode_enabled: boolean;
        org_deploy_enabled: boolean;
        event_subscriptions: { request_url: string };
      };
    };
    assert.equal(manifest.display_information.name, "Bosun");
    assert.equal(manifest.display_information.description, "Fleet ops");
    assert.equal(manifest.settings.socket_mode_enabled, false);
    assert.equal(manifest.settings.org_deploy_enabled, true);
    assert.equal(manifest.settings.event_subscriptions.request_url, "https://qm.example.com/slack/events/app/p-1");
    assert.deepEqual(manifest.oauth_config.redirect_urls, ["https://qm.example.com/v1/slack/oauth/callback"]);
  });

  it("provisions both base org app and persona app through one config token, OAuth callback, and HTTP Events receiver", () =>
    withTenant("00000000-0000-0000-0000-000000000001", async () => {
      const map = tenantMap<StoredSlackInstallation>();
      const calls: Array<{ url: string; body?: string }> = [];
      let nextAppNum = 1;

      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const bodyStr = typeof init?.body === "string" ? init.body : undefined;
        calls.push({ url, body: bodyStr });
        if (url.endsWith("/tooling.tokens.rotate")) {
          return Response.json({
            ok: true,
            token: "xoxe.xoxp-rotated-access",
            refresh_token: "xoxe-1-rotated-refresh",
            exp: Math.floor(Date.now() / 1000) + 43200,
          });
        }
        if (url.endsWith("/apps.manifest.create")) {
          const parsed = JSON.parse(bodyStr ?? "{}") as { manifest: string };
          const m = JSON.parse(parsed.manifest) as { settings: { event_subscriptions: { request_url: string } } };
          const target = m.settings.event_subscriptions.request_url.split("/").pop()!;
          const vRes = mockRes();
          await store.handleHttpEvent(
            target,
            mockReq({
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ type: "url_verification", challenge: `chal-${target}` }),
            }),
            vRes.res,
          );
          assert.equal(vRes.status, 200);
          assert.equal(vRes.json().challenge, `chal-${target}`);
          const num = nextAppNum++;
          return Response.json({
            ok: true,
            app_id: `A0APP${num}`,
            credentials: {
              client_id: `C0CLIENT${num}`,
              client_secret: `secret-${num}`,
              signing_secret: `sign-${num}`,
            },
          });
        }
        if (url.endsWith("/oauth.v2.access")) {
          return Response.json({
            ok: true,
            access_token: `xoxb-token-${nextAppNum}`,
            team: { id: "T0TEAM", name: "Acme" },
          });
        }
        if (url.endsWith("/apps.manifest.delete")) {
          return Response.json({ ok: true });
        }
        throw new Error(`unexpected fetch: ${url}`);
      };

      const store = createSlackInstallationStore("org-1", map, "test-key", {
        publicUrl: "https://qm.example.com",
        fetchImpl,
      });

      const cfg = await store.setConfigToken({ refreshToken: "xoxe-1-initial", updatedBy: "admin-1" });
      assert.equal(cfg.configured, true);
      assert.equal(cfg.hasRefreshToken, true);

      const baseCreated = await store.createApp({ name: "QM", updatedBy: "admin-1" });
      assert.equal(baseCreated.appId, "A0APP1");
      assert.equal(baseCreated.status.status, "pending_install");
      assert.equal(await store.get(), null);
      const baseState = new URL(baseCreated.oauthAuthorizeUrl).searchParams.get("state")!;
      const baseDone = await store.completeOAuth({ code: "code-base", state: baseState });
      assert.equal(baseDone.personaId, undefined);
      assert.equal((await store.get())?.signingSecret, "sign-1");

      const personaCreated = await store.createApp({
        personaId: "p-1",
        name: "Bosun",
        updatedBy: "owner-1",
      });
      assert.equal(personaCreated.appId, "A0APP2");
      const personaState = new URL(personaCreated.oauthAuthorizeUrl).searchParams.get("state")!;
      const personaDone = await store.completeOAuth({ code: "code-p1", state: personaState });
      assert.equal(personaDone.personaId, "p-1");
      const listed = await store.listPersonaApps();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.personaId, "p-1");

      let receivedEvent: Record<string, unknown> | undefined;
      const recv = store.receiver("p-1", "sign-2");
      recv.init({
        processEvent: async (ev: { body: Record<string, unknown>; ack: () => Promise<void> }) => {
          receivedEvent = ev.body;
          await ev.ack();
        },
      } as unknown as BoltApp);
      await recv.start();

      const eventBody = JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "hi" } });
      const badRes = mockRes();
      await store.handleHttpEvent(
        "p-1",
        mockReq({ headers: signedHeaders("wrong", eventBody), body: eventBody }),
        badRes.res,
      );
      assert.equal(badRes.status, 401);

      const okRes = mockRes();
      await store.handleHttpEvent(
        "p-1",
        mockReq({ headers: signedHeaders("sign-2", eventBody), body: eventBody }),
        okRes.res,
      );
      assert.equal(okRes.status, 200);
      assert.equal(receivedEvent?.type, "event_callback");
      await recv.stop();

      await store.deleteApp({ personaId: "p-1", updatedBy: "owner-1", deleteRemote: true });
      assert.equal((await store.listPersonaApps()).length, 0);
      assert.ok(calls.some((c) => c.url.endsWith("/apps.manifest.delete")));
    }));

  it("supports manual BYO HTTP Events attachment via auth.test", () =>
    withTenant("00000000-0000-0000-0000-000000000001", async () => {
      const store = createSlackInstallationStore("org-1", tenantMap<StoredSlackInstallation>(), "test-key", {
        publicUrl: "https://qm.example.com",
        fetchImpl: async () => Response.json({ ok: true, team_id: "T0BYO", team: "BYO Corp", app_id: "A0BYO" }),
      });
      const status = await store.attachHttpApp({
        personaId: "p-2",
        botToken: "xoxb-manual",
        signingSecret: "sec-manual",
        updatedBy: "owner-2",
      });
      assert.equal(status.status, "connected");
      assert.equal(status.teamId, "T0BYO");
      assert.equal(status.appId, "A0BYO");
    }));
});
