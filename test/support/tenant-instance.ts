import "./auto-fake-sprites.ts";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import { createServer } from "../../src/api/server.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import type { SessionShareStore } from "../../src/sessions/session-share.ts";
import { boundTenant } from "../../src/tenants/context.ts";
import { useOwnerDatabase } from "../../src/tenants/owner-pool.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "./build-app.ts";
import { hostRequest } from "./host-request.ts";
import { nonOwnerLogin } from "./non-owner.ts";
import { testConfig } from "./test-config.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";

export const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy tests";
const SECRET = "tenant-rows-core-signing-secret".repeat(2);
export const HOOK_SECRET = "hook-secret";

export interface Instance {
  built: ReturnType<typeof buildApp>;
  base: string;
  server: Server;
  owner: pg.Pool;
  shareReads: { token: string; tenant: string | undefined }[];
}

export async function startTenantInstance(
  tenants: string[],
  appSignIn: { deployAppsSessionSecret?: string; deployAppsLoginUrl?: string } = {},
): Promise<Instance> {
  const databaseUrl = testMigratedDatabaseUrl();
  const owner = new pg.Pool({ connectionString: databaseUrl });
  for (const tenant of tenants) await owner.query("INSERT INTO tenants(id) VALUES ($1)", [tenant]);
  useOwnerDatabase(databaseUrl);
  const built = buildApp(
    testConfig({ databaseUrl: await nonOwnerLogin(databaseUrl), dataDir: mkdtempSync(join(tmpdir(), "tenant-rows-")) }),
  );
  const shareReads: Instance["shareReads"] = [];
  const sessionShares: SessionShareStore = {
    ...built.sessionShares,
    get: async (token: string) => {
      shareReads.push({ token, tenant: boundTenant() });
      return built.sessionShares.get(token);
    },
  };
  const server = createServer(built.app, {
    signingSecret: SECRET,
    replayDedupe: createPostgresReplayDedupe(databaseUrl),
    tenancy: built.tenancy,
    webhookReceiver: built.webhookReceiver,
    oauthFlows: built.oauthFlows,
    connectorTokens: built.connectorTokens,
    oauthStateSecret: SECRET,
    sessionShares,
    deployAppsDomain: "apps.example.test",
    deployGateSecret: SECRET,
    ...appSignIn,
  });
  server.listen(0);
  return { built, server, owner, shareReads, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function stopTenantInstance(instance: Instance | undefined): Promise<void> {
  if (!instance) return;
  instance.server.closeAllConnections();
  await new Promise<void>((resolve) => instance.server.close(() => resolve()));
  await instance.owner.end();
}

export function deliver(instance: Instance, host: string, id: string, secret = HOOK_SECRET) {
  const body = JSON.stringify({ action: "opened" });
  return hostRequest(`${instance.base}/v1/webhooks/incoming/${id}`, host, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      "x-github-delivery": randomUUID(),
      "x-github-event": "issues",
    },
    body,
  });
}

export function signed(instance: Instance, host: string, method: string, path: string, body = "", tenant?: string) {
  return hostRequest(`${instance.base}${path}`, host, {
    method,
    headers: signedRequestHeaders(SECRET, method, path, body, {
      "content-type": "application/json",
      ...(tenant ? { "x-qm-tenant": tenant } : {}),
    }),
    body,
  });
}
