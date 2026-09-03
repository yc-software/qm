import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

let job: Record<string, unknown> = {
  id: "outage-job-1",
  requestedBy: "U-admin",
  currentVersion: "0.1.9",
  targetVersion: "0.2.0",
  state: "queued",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const core = createServer(async (req: IncomingMessage, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/whoami")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: true, role: "org_admin", scopeId: "org:acme" }));
  }
  if (req.method === "GET" && req.url === "/v1/admin/updates/latest") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ job }));
  }
  if (req.method === "PATCH" && req.url === "/v1/admin/updates/outage-job-1") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    job = { ...job, ...(JSON.parse(Buffer.concat(chunks).toString("utf8")) as object), updatedAt: Date.now() };
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ job }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  return void res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  if (String(input) === "https://registry.npmjs.org/@yc-software%2fqm") {
    return Promise.resolve(new Response("unavailable", { status: 503 }));
  }
  if (String(input).includes("/runs?")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          workflow_runs: [
            {
              display_title: "QM update to 0.2.0 [outage-job-1]",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/acme/qm-deployment/actions/runs/101",
            },
          ],
        }),
        { status: 200 },
      ),
    );
  }
  return originalFetch(input, init);
}) as typeof fetch;

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-update-outage-test-secret";
process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";
process.env.QM_VERSION = "0.1.9";
process.env.QM_UPDATE_GITHUB_REPOSITORY = "acme/qm-deployment";
process.env.QM_UPDATE_GITHUB_TOKEN = "github-test-token";
process.env.QM_UPDATE_GITHUB_API_URL = "https://github.test";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  core.close();
  globalThis.fetch = originalFetch;
});

test("durable workflow state reconciles while the npm registry is unavailable", async () => {
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    updateAvailable: boolean;
    latestVersion: string;
    updater: { job: { state: string; runUrl?: string } };
  };
  assert.equal(body.updateAvailable, false);
  assert.equal(body.latestVersion, "0.2.0");
  assert.equal(body.updater.job.state, "succeeded");
  assert.equal(body.updater.job.runUrl, "https://github.com/acme/qm-deployment/actions/runs/101");
});
