import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

let job: Record<string, unknown> | null = null;
const core = createServer(async (req: IncomingMessage, res) => {
  if (req.method === "GET" && (req.url ?? "").startsWith("/v1/admin/whoami")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ isAdmin: true, role: "org_admin", scopeId: "org:acme" }));
  }
  if (req.method === "GET" && req.url === "/v1/admin/updates/latest") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ job }));
  }
  if (req.method === "POST" && req.url === "/v1/admin/updates") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      currentVersion: string;
      targetVersion: string;
    };
    job = {
      id: "update-job-1",
      requestedBy: "U-admin",
      ...body,
      state: "dispatching",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    res.writeHead(202, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ job }));
  }
  if (req.method === "PATCH" && req.url === "/v1/admin/updates/update-job-1") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    job = { ...job, ...(JSON.parse(Buffer.concat(chunks).toString("utf8")) as object), updatedAt: Date.now() };
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ job }));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const originalFetch = globalThis.fetch;
let dispatched: Record<string, unknown> | null = null;
let dispatchMode: "success" | "rejected" | "accepted_timeout" | "unknown_timeout" = "success";
let runById: { status: number; body: unknown } = { status: 404, body: { message: "Not Found" } };
const fetched: string[] = [];
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  fetched.push(String(input));
  if (String(input) === "https://registry.npmjs.org/@yc-software%2fqm") {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          "dist-tags": { latest: "0.2.0" },
          time: { "0.1.9": "2026-01-01T00:00:00.000Z", "0.2.0": "2026-02-01T00:00:00.000Z" },
          versions: { "0.1.9": {}, "0.2.0": {} },
        }),
        { status: 200 },
      ),
    );
  }
  if (String(input).endsWith("/dispatches")) {
    dispatched = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (dispatchMode === "rejected") {
      return Promise.resolve(new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    }
    if (dispatchMode !== "success") return Promise.reject(new Error("dispatch timed out"));
    return Promise.resolve(
      new Response(JSON.stringify({ html_url: "https://github.com/acme/qm-deployment/actions/runs/99" }), {
        status: 200,
      }),
    );
  }
  if (/\/actions\/runs\/\d+$/.test(String(input))) {
    return Promise.resolve(new Response(JSON.stringify(runById.body), { status: runById.status }));
  }
  if (String(input).includes("/runs?")) {
    if (dispatchMode === "accepted_timeout") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                display_title: "QM update to 0.2.0 [update-job-1]",
                status: "in_progress",
                conclusion: null,
                html_url: "https://github.com/acme/qm-deployment/actions/runs/100",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }));
  }
  return originalFetch(input, init);
}) as typeof fetch;
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-update-route-test-secret";
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

test("the authenticated update endpoint reports a newer release", async () => {
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    currentVersion: "0.1.9",
    latestVersion: "0.2.0",
    newestVersion: "0.2.0",
    updateAvailable: true,
    updateCommand: "npm exec qm -- update --yes --version 0.2.0",
    releaseUrl: "https://github.com/yc-software/qm/releases/tag/v0.2.0",
    releasedAt: "2026-02-01T00:00:00.000Z",
    updater: {
      available: true,
      actionsUrl: "https://github.com/acme/qm-deployment/actions/workflows/qm-update.yml",
    },
  });
});

test("the browser endpoint freezes and dispatches the reviewed version", async () => {
  const response = await originalFetch(`${base}/api/update`, {
    method: "POST",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.0" }),
  });
  assert.equal(response.status, 202);
  const body = (await response.json()) as { job: { state: string; targetVersion: string; runUrl?: string } };
  assert.equal(body.job.state, "queued");
  assert.equal(body.job.targetVersion, "0.2.0");
  assert.equal(body.job.runUrl, "https://github.com/acme/qm-deployment/actions/runs/99");
  assert.deepEqual(dispatched, {
    ref: "main",
    inputs: { version: "0.2.0", request_id: "update-job-1", requested_by: "U-admin" },
  });
});

test("a dispatched workflow that never appears releases the update lock", async () => {
  const { runUrl: _runUrl, ...withoutRun } = job ?? {};
  job = { ...withoutRun, state: "queued", createdAt: Date.now() - 11 * 60_000, updatedAt: Date.now() - 11 * 60_000 };
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { updater: { job: { state: string; detail: string } } };
  assert.deepEqual(body.updater.job, {
    ...job,
    state: "failed",
    detail: "The deployment workflow did not start",
  });
});

test("an accepted dispatch whose response times out is reconciled without unlocking a duplicate", async () => {
  job = null;
  dispatchMode = "accepted_timeout";
  const response = await originalFetch(`${base}/api/update`, {
    method: "POST",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.0" }),
  });
  dispatchMode = "success";
  assert.equal(response.status, 202);
  const body = (await response.json()) as { job: { state: string; runUrl?: string } };
  assert.equal(body.job.state, "running");
  assert.equal(body.job.runUrl, "https://github.com/acme/qm-deployment/actions/runs/100");
});

test("an unconfirmed dispatch stays locked while GitHub Actions is checked", async () => {
  job = null;
  dispatchMode = "unknown_timeout";
  const response = await originalFetch(`${base}/api/update`, {
    method: "POST",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.0" }),
  });
  dispatchMode = "success";
  assert.equal(response.status, 202);
  const body = (await response.json()) as { job: { state: string; detail?: string } };
  assert.equal(body.job.state, "dispatching");
  assert.equal(body.job.detail, "Confirming the deployment request with GitHub Actions");
});

test("a rejected dispatch fails the job with GitHub's answer", async () => {
  job = null;
  dispatchMode = "rejected";
  const response = await originalFetch(`${base}/api/update`, {
    method: "POST",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({ version: "0.2.0" }),
  });
  dispatchMode = "success";
  assert.equal(response.status, 202);
  const body = (await response.json()) as { job: { state: string; detail: string } };
  assert.equal(body.job.state, "failed");
  assert.match(body.job.detail, /GitHub returned 401/);
});

test("a job with a run URL is resolved by run id instead of the run listing", async () => {
  const runUrl = "https://github.com/acme/qm-deployment/actions/runs/99";
  job = { ...job, state: "queued", runUrl, createdAt: Date.now(), updatedAt: Date.now() };
  runById = { status: 200, body: { status: "in_progress", conclusion: null, html_url: runUrl } };
  fetched.length = 0;
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { updater: { job: { state: string; runUrl: string } } };
  assert.equal(body.updater.job.state, "running");
  assert.equal(body.updater.job.runUrl, runUrl);
  assert.ok(fetched.some((url) => url === "https://github.test/repos/acme/qm-deployment/actions/runs/99"));
  assert.ok(!fetched.some((url) => url.includes("/runs?")));
});

test("an unchanged run is not written back to core", async () => {
  const before = job?.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { updater: { job: { updatedAt: number } } };
  assert.equal(body.updater.job.updatedAt, before);
});

test("a job whose run disappeared from GitHub is failed", async () => {
  job = { ...job, state: "queued", runUrl: "https://github.com/acme/qm-deployment/actions/runs/404" };
  runById = { status: 404, body: { message: "Not Found" } };
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { updater: { job: { state: string; detail: string } } };
  assert.equal(body.updater.job.state, "failed");
  assert.equal(body.updater.job.detail, "The deployment workflow run is no longer available");
});

test("a running job that never reports a result is failed after ninety minutes", async () => {
  const { runUrl: _runUrl, ...withoutRun } = job ?? {};
  job = {
    ...withoutRun,
    state: "running",
    createdAt: Date.now() - 95 * 60_000,
    updatedAt: Date.now() - 91 * 60_000,
  };
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { updater: { job: { state: string; detail: string } } };
  assert.equal(body.updater.job.state, "failed");
  assert.equal(body.updater.job.detail, "The deployment workflow did not report a result");
});

test("a failed job for a version that is already installed is omitted", async () => {
  job = { ...job, state: "failed", targetVersion: "0.1.9", detail: "Workflow cancelled" };
  const response = await originalFetch(`${base}/api/update`, { headers: { cookie: "admin=U-admin" } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { updateAvailable: boolean; updater: { job?: unknown } };
  assert.equal(body.updateAvailable, true);
  assert.equal(body.updater.job, undefined);
});
