import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(socketAppId = "A-ACME"): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "byo-route-")) }));
  const server = createInsecureTestServer(built.app, {
    oauthStateSecret: "byo-route-oauth-state-secret",
    replayDedupe: built.replayDedupe,
    connectorTokens: built.connectorTokens,
    slackInstallation: built.slackInstallation,
    slackInstallationFetch: (async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/auth.test")
            ? { ok: true, team_id: "T-ACME", team: "Acme", app_id: "A-ACME" }
            : { ok: true, url: "wss://example.invalid" },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
    slackInstallationSocketAppId: async () => socketAppId,
    resolveClient: built.resolveClient,
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const putConnector = (base: string, b: object) =>
  fetch(`${base}/v1/admin/scopes/org:default-org/connectors`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify(b),
  });

test("the slack-installation createUrl adopts the live branding label", async () => {
  const srv = start();
  try {
    const nameFrom = async (): Promise<string> => {
      const r = (await (await fetch(`${srv.base}/v1/admin/slack-installation`, { headers: ADMIN })).json()) as {
        createUrl: string;
      };
      const manifest = JSON.parse(new URL(r.createUrl).searchParams.get("manifest_json") ?? "{}") as {
        display_information?: { name?: string };
      };
      return manifest.display_information?.name ?? "";
    };
    assert.equal(await nameFrom(), "qm");
    assert.equal(
      (
        await fetch(`${srv.base}/v1/admin/scopes/org:default-org/branding`, {
          method: "PUT",
          headers: ADMIN,
          body: JSON.stringify({ selfLabel: "straylight" }),
        })
      ).status,
      200,
    );
    assert.equal(await nameFrom(), "straylight");
  } finally {
    await srv.close();
  }
});

test("admin registers a BYO client → /start uses it; the secret is never echoed", async () => {
  const srv = start();
  try {
    const redirectUri = `${srv.base}/v1/connectors/oauth/google/callback`;
    const startPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent(redirectUri)}`;

    assert.equal((await fetch(`${srv.base}${startPath}`)).status, 501);

    const putRes = await putConnector(srv.base, {
      provider: "google",
      clientId: "byo-cid",
      clientSecret: "byo-super-secret",
      redirectAllowlist: [redirectUri],
    });
    assert.equal(putRes.status, 200);

    const denied = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/connectors`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
      body: JSON.stringify({ provider: "google", clientId: "x", clientSecret: "y" }),
    });
    assert.equal(denied.status, 403);

    const startRes = await fetch(`${srv.base}${startPath}`);
    assert.equal(startRes.status, 200);
    const body = (await startRes.json()) as { authorizeUrl: string };
    assert.equal(new URL(body.authorizeUrl).searchParams.get("client_id"), "byo-cid");

    const cfg = (await (await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
      connectors: Array<{ provider: string; clientId: string; hasSecret: boolean }>;
    };
    const google = cfg.connectors.find((c) => c.provider === "google");
    assert.equal(google?.clientId, "byo-cid");
    assert.equal(google?.hasSecret, true);
    assert.doesNotMatch(JSON.stringify(cfg), /byo-super-secret/);

    const badPath = `/v1/connectors/oauth/google/start?principalId=U1&redirectUri=${encodeURIComponent("https://evil/cb")}`;
    const bad = await fetch(`${srv.base}${badPath}`);
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /redirect_not_allowed/);
  } finally {
    await srv.close();
  }
});

test("admin stores validated Slack tokens without ever returning them", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/slack-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ botToken: "xoxb-super-secret", appToken: "xapp-super-secret" }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.text();
    assert.doesNotMatch(putBody, /xoxb|xapp|super-secret/);
    assert.match(putBody, /T-ACME/);

    const status = await fetch(`${srv.base}/v1/admin/slack-installation`, { headers: ADMIN });
    assert.equal(status.status, 200);
    const statusText = await status.text();
    assert.doesNotMatch(statusText, /xoxb|xapp|super-secret/);
    const createUrl = new URL((JSON.parse(statusText) as { createUrl: string }).createUrl);
    assert.equal(createUrl.searchParams.get("new_app"), "1");
    assert.equal(JSON.parse(createUrl.searchParams.get("manifest_json")!).display_information.name, "qm");
    assert.equal((await srv.built.slackInstallation.get())?.botToken, "xoxb-super-secret");

    const del = await fetch(`${srv.base}/v1/admin/slack-installation`, { method: "DELETE", headers: ADMIN });
    assert.equal(del.status, 200);
    assert.equal(await srv.built.slackInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("admin rejects Slack bot and Socket Mode tokens from different apps", async () => {
  const srv = start("A-OTHER");
  try {
    const put = await fetch(`${srv.base}/v1/admin/slack-installation`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ botToken: "xoxb-super-secret", appToken: "xapp-super-secret" }),
    });
    assert.equal(put.status, 400);
    assert.match(await put.text(), /different Slack apps/);
    assert.equal(await srv.built.slackInstallation.get(), null);
  } finally {
    await srv.close();
  }
});

test("disabling a BYO connector grays it out in the app-grid status", async () => {
  const srv = start();
  try {
    await putConnector(srv.base, { provider: "google", clientId: "c", clientSecret: "s", enabled: true });
    const statusPath = "/v1/connectors/oauth/status?principalId=U1";
    let st = (await (await fetch(`${srv.base}${statusPath}`)).json()) as {
      providers: Record<string, { configured: boolean }>;
    };
    assert.equal(st.providers.google!.configured, true);

    await putConnector(srv.base, { provider: "google", clientId: "c", clientSecret: "s", enabled: false });
    st = (await (await fetch(`${srv.base}${statusPath}`)).json()) as {
      providers: Record<string, { configured: boolean }>;
    };
    assert.equal(st.providers.google!.configured, false);
  } finally {
    await srv.close();
  }
});

test("the catalog endpoint exposes per-provider setup guidance (no secrets)", async () => {
  const srv = start();
  try {
    const { catalog } = (await (await fetch(`${srv.base}/v1/connectors/catalog`)).json()) as {
      catalog: Array<{ provider: string; setupGuide: { url: string; steps: string[] }; consentMode: string }>;
    };
    const names = catalog.map((c) => c.provider).sort();
    assert.deepEqual(names, ["dropbox", "github", "google", "linear", "notion", "slack", "x"]);
    const google = catalog.find((c) => c.provider === "google")!;
    assert.ok(google.setupGuide.steps.length >= 3);
    assert.match(google.setupGuide.url, /^https:\/\//);
    assert.equal(catalog.find((c) => c.provider === "github")!.consentMode, "github_app");
  } finally {
    await srv.close();
  }
});
