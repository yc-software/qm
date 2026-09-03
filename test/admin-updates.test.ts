import "./support/auto-fake-sprites.ts";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("admin update jobs are serialized, durable through the store, and audited", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-updates-")) }));
  assert.ok(built.updateJobs);
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    updateJobs: built.updateJobs,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { "x-admin-actor": "admin-alice@default-org", ...init.headers } });
  try {
    const createdResponse = await request("/v1/admin/updates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentVersion: "0.1.9", targetVersion: "0.2.0" }),
    });
    assert.equal(createdResponse.status, 202);
    const created = (await createdResponse.json()) as { job: { id: string; state: string } };
    assert.equal(created.job.state, "dispatching");

    const duplicate = await request("/v1/admin/updates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentVersion: "0.1.9", targetVersion: "0.2.0" }),
    });
    assert.equal(duplicate.status, 409);

    const queued = await request(`/v1/admin/updates/${created.job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "queued", detail: "Waiting for runner" }),
    });
    assert.equal(queued.status, 200);
    assert.equal(((await queued.json()) as { job: { state: string } }).job.state, "queued");

    const latest = (await (await request("/v1/admin/updates/latest")).json()) as { job: { id: string } };
    assert.equal(latest.job.id, created.job.id);
    const stateAudits = async () =>
      (await built.auditLog.events()).filter((event) => event.action === "qm.update.state");
    const actions = (await built.auditLog.events()).map((event) => event.action);
    assert.ok(actions.includes("qm.update.request"));
    assert.equal((await stateAudits()).length, 1);
    assert.equal((await stateAudits())[0]!.principalId, "admin-alice", "the transition is attributed to the caller");

    const sameState = await request(`/v1/admin/updates/${created.job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "queued", detail: "Still waiting" }),
    });
    assert.equal(sameState.status, 200);
    assert.equal((await stateAudits()).length, 1, "a same-state PATCH adds no audit row");

    const badRunUrl = await request(`/v1/admin/updates/${created.job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "running", runUrl: "https://evil.example/x" }),
    });
    assert.equal(badRunUrl.status, 400);

    const missing = await request("/v1/admin/updates/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "running" }),
    });
    assert.equal(missing.status, 404);

    const succeeded = await request(`/v1/admin/updates/${created.job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "succeeded", runUrl: "https://github.com/acme/deploy/actions/runs/1" }),
    });
    assert.equal(succeeded.status, 200);
    const reopened = await request(`/v1/admin/updates/${created.job.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "running" }),
    });
    assert.equal(reopened.status, 409);
    assert.equal(((await reopened.json()) as { error: string }).error, "invalid_transition");

    const downgrade = await request("/v1/admin/updates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentVersion: "0.2.0", targetVersion: "0.1.9" }),
    });
    assert.equal(downgrade.status, 400);
    const prerelease = await request("/v1/admin/updates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentVersion: "0.1.9", targetVersion: "0.2.0-beta.1" }),
    });
    assert.equal(prerelease.status, 400);
    const nonAdmin = await fetch(`${base}/v1/admin/updates`, {
      method: "POST",
      headers: { "x-admin-actor": "U1@default-org", "content-type": "application/json" },
      body: JSON.stringify({ currentVersion: "0.1.9", targetVersion: "0.2.0" }),
    });
    assert.equal(nonAdmin.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("update routes refuse to run without the durable job store", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-updates-")) }));
  const server = createInsecureTestServer(built.app, { admin: built.admin, auditLog: built.auditLog });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/admin/updates/latest`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, "durable_store_required");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});
