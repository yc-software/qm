import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { createKeychain } from "../../src/credentials/keychain.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { brokerCredentialCall } from "../../src/api/credential-broker.ts";
import {
  brokerCountsMatch,
  brokerReceiptsMatch,
  runCredentialWorkload,
  validateCredentialWorkload,
  verifyBrokerResponse,
  type CredentialWorkloadProfile,
} from "./workload-credential.ts";
import {
  credentialResponder,
  BROKER_PATH,
  BROKER_METRICS_PATH,
  type CredentialResponderProfile,
} from "./workload-credential-responder.ts";
import type { WorkloadFixture } from "./workload.ts";
import { orgId } from "../../src/config.ts";

const fixture: WorkloadFixture = {
  schemaVersion: 1,
  fixtureId: "synthetic-broker-test",
  databaseName: "qm_perf_broker_unit",
  profileSha256: "a".repeat(64),
  qualified: false,
};

function brokerTestBinding() {
  const env = {
    DATABASE: `postgresql://synthetic@localhost/${fixture.databaseName}`,
    SOURCE: "synthetic-source",
    CAPABILITY: "synthetic-capability",
    PORTAL: "synthetic-portal",
    SECRET: `qm-perf-synthetic-${"s".repeat(40)}`,
    CONTROL: "c".repeat(40),
  };
  const profile: CredentialWorkloadProfile = {
    workload: {
      schemaVersion: 1,
      fixtureId: fixture.fixtureId,
      isolated: true,
      externalEffectsDisabled: true,
      mode: "diagnostic",
      condition: "unit",
      baseUrl: "http://127.0.0.1:8081",
      durationMs: 20_000,
      requestTimeoutMs: 1000,
      maxConcurrency: 4,
      maxStartDelayMs: 100,
      streamConnectTimeoutMs: 1000,
      requests: [],
      streams: [],
    },
    databaseUrlEnv: "DATABASE",
    sourceSecretEnv: "SOURCE",
    capabilitySecretEnv: "CAPABILITY",
    portalIdentitySecretEnv: "PORTAL",
    syntheticSecretEnv: "SECRET",
    controlTokenEnv: "CONTROL",
    orgScopeId: `org:${orgId()}`,
    principalId: "unit@example.invalid",
    responderOrigin: "https://127.0.0.1:9443",
    responderProfileSha256: "b".repeat(64),
    guardCase: { sessionId: "synthetic", principalId: "unit@example.invalid", expectedVisibleText: "tail" },
    successRatePerSecond: 1.86,
    denialRatePerSecond: 0.0059,
    persistenceTimeoutMs: 1000,
    bounds: { successfulRate: { min: 1.8, max: 2 }, deniedRate: { min: 0.04, max: 0.06 } },
  };
  return { profile, env };
}

test("broker driver requires explicit fixture, credential, TLS, and completion-rate bindings", () => {
  const { profile, env } = brokerTestBinding();
  validateCredentialWorkload(profile, fixture, env);
  assert.throws(() => validateCredentialWorkload(profile, { ...fixture, databaseName: "production" }, env));
  assert.throws(() => validateCredentialWorkload(profile, fixture, { ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
  assert.throws(() => validateCredentialWorkload(profile, fixture, { ...env, CONTROL: env.SECRET }));
  assert.throws(() =>
    validateCredentialWorkload(
      { ...profile, bounds: { ...profile.bounds, deniedRate: { min: 0, max: 0 } } },
      fixture,
      env,
    ),
  );
});

for (const delayed of ["create", "activate"] as const)
  test(`an ambiguous ${delayed} cannot later enable a credential and leaves explicit unresolved cleanup evidence`, async (t) => {
    const { profile, env } = brokerTestBinding();
    profile.workload.requestTimeoutMs = 10;
    profile.persistenceTimeoutMs = 150;
    let state: { version: number; disabled: boolean; grants: number } | undefined;
    let delayedDone: Promise<void> | undefined;
    const events: Record<string, unknown>[] = [];
    t.mock.method(Client.prototype, "connect", async () => {});
    t.mock.method(Client.prototype, "end", async () => {});
    t.mock.method(Client.prototype, "query", async (sql: string) => {
      if (sql.includes("FROM qm_performance_fixture"))
        return {
          rows: [
            {
              database: fixture.databaseName,
              fixture_id: fixture.fixtureId,
              profile_sha256: fixture.profileSha256,
              status: "ready",
            },
          ],
        };
      if (sql.includes("AS kind"))
        return { rows: state ? [{ version: state.version, kind: "broker", host: "127.0.0.1", encrypted: true }] : [] };
      if (sql.includes("AS disabled")) return { rows: state ? [state] : [] };
      throw new Error("Unexpected database query before broker activation");
    });
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/sessions/")) return new Response("tail");
      if (url.pathname === "/__qm_perf/identity")
        return Response.json({
          fixtureId: fixture.fixtureId,
          profileSha256: fixture.profileSha256,
          responderProfileSha256: profile.responderProfileSha256,
          payloadBytes: 128,
        });
      assert.equal(init?.method, "PUT");
      const body = JSON.parse(String(init?.body));
      const create = body.expectedUpdatedAt === undefined;
      const commit = () => {
        if (create) {
          if (state) return new Response(null, { status: 409 });
          state = { version: 1, disabled: body.enabled === false, grants: body.grantees.length };
        } else {
          if (!state || state.version !== body.expectedUpdatedAt) return new Response(null, { status: 409 });
          state = { version: state.version + 1, disabled: body.enabled === false, grants: body.grantees.length };
        }
        return new Response(null, { status: 200 });
      };
      if ((delayed === "create" && create) || (delayed === "activate" && body.enabled)) {
        return new Promise<Response>((resolve, reject) => {
          delayedDone = sleep(40).then(() => void resolve(commit()));
          init?.signal?.addEventListener("abort", () => reject(new Error("Simulated client timeout")), { once: true });
        });
      }
      return commit();
    });
    await assert.rejects(
      runCredentialWorkload(profile, fixture, (event) => events.push(event), env),
      /cleanup remains unresolved/,
    );
    await delayedDone;
    assert.equal(state?.disabled, true);
    assert.equal(state?.grants, 0);
    assert.ok(Number(state?.version) > 1);
    const cleanup = events.find((event) => event.type === "credential-cleanup");
    assert.equal(cleanup?.disabled, true);
    assert.equal(cleanup?.grantsRemoved, true);
    assert.equal(cleanup?.unresolved, true);
    assert.equal(cleanup?.creationAcknowledged, delayed !== "create");
    assert.equal(cleanup?.activationAttempted, delayed === "activate");
    assert.match(String(cleanup?.slug), /^qm-perf-broker-/);
  });

test("native broker decrypts its synthetic credential, verifies TLS, preserves denials, and proves responder counts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qm-perf-broker-tls-"));
  const cert = join(directory, "cert.pem"),
    key = join(directory, "key.pem"),
    config = join(directory, "openssl.cnf");
  writeFileSync(
    config,
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
    { mode: 0o600 },
  );
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-config", config],
    { stdio: "ignore" },
  );
  const env = { CERT: cert, KEY: key, SYNTHETIC: `qm-perf-synthetic-${"s".repeat(40)}`, CONTROL: "c".repeat(40) };
  const profile: CredentialResponderProfile = {
    schemaVersion: 1,
    fixtureId: fixture.fixtureId,
    profileSha256: fixture.profileSha256,
    isolated: true,
    bind: "127.0.0.1",
    port: 9443,
    certificateFileEnv: "CERT",
    privateKeyFileEnv: "KEY",
    syntheticSecretEnv: "SYNTHETIC",
    controlTokenEnv: "CONTROL",
    payloadBytes: 128,
  };
  const records: Record<string, unknown>[] = [];
  const server = credentialResponder(profile, fixture, env, (row) => records.push(row));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (
    url: string,
    headers: Record<string, string>,
    trusted = true,
  ): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = request(url, { headers, ...(trusted ? { ca: readFileSync(cert) } : {}), timeout: 2000 }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part) => (text += part));
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("TLS unit request timed out")));
      req.end();
    });
  const runId = randomUUID(),
    slug = "qm-perf-unit",
    scope = "personal:unit@example.invalid";
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("synthetic-unit-encryption"),
  });
  try {
    await assert.rejects(
      get(`${origin}${BROKER_PATH}${runId}/0`, { authorization: `Bearer ${env.SYNTHETIC}` }, false),
      /certificate|self-signed/i,
    );
    await keychain.setServiceCredential("org:fixture", {
      slug,
      name: "Synthetic unit credential",
      host: "127.0.0.1",
      secret: env.SYNTHETIC,
      allowedMethods: ["GET"],
      allowedPathPrefixes: [BROKER_PATH],
    });
    const call = (path: string) =>
      brokerCredentialCall({
        claims: {
          actorId: "unit@example.invalid",
          scopeId: scope,
          aud: "credential-broker",
          credentials: [slug],
          exp: Date.now() + 60_000,
        },
        body: { credential: slug, method: "GET", url: `${origin}${path}` },
        orgScopeId: "org:fixture",
        reader: keychain,
        fetchImpl: async (url, init) => {
          const response = await get(url, init.headers);
          return { status: response.status, contentType: "application/json", text: async () => response.text };
        },
      });
    const success = await call(`${BROKER_PATH}${runId}/0`);
    const expected = {
      denied: false,
      fixtureId: fixture.fixtureId,
      profileSha256: fixture.profileSha256,
      runId,
      sequence: 0,
      payloadBytes: 128,
    };
    verifyBrokerResponse(success.status, success.json as Record<string, unknown>, expected);
    assert.ok(!JSON.stringify(success).includes(env.SYNTHETIC));
    const denial = await call(`/__qm_perf/denied/${runId}/1`);
    verifyBrokerResponse(denial.status, denial.json as Record<string, unknown>, {
      ...expected,
      denied: true,
      sequence: 1,
    });
    const metrics = JSON.parse(
      (await get(`${origin}${BROKER_METRICS_PATH}${runId}`, { "x-qm-perf-control": env.CONTROL })).text,
    );
    assert.equal(metrics.accepted, 1);
    assert.equal(metrics.uniqueSequences, 1);
    assert.equal(brokerReceiptsMatch(metrics, 1), true);
    assert.equal(records.length, 1);
    const reachedDenial = await get(`${origin}/__qm_perf/denied/${runId}/1`, {
      authorization: `Bearer ${env.SYNTHETIC}`,
    });
    assert.equal(reachedDenial.status, 404);
    const poisonedMetrics = JSON.parse(
      (await get(`${origin}${BROKER_METRICS_PATH}${runId}`, { "x-qm-perf-control": env.CONTROL })).text,
    );
    assert.equal(poisonedMetrics.arrivals, 2);
    assert.equal(poisonedMetrics.unexpected, 1);
    assert.equal(brokerReceiptsMatch(poisonedMetrics, 1), false);
    assert.equal(records[1]?.type, "credential-responder-unexpected");
    assert.throws(() =>
      verifyBrokerResponse(success.status, success.json as Record<string, unknown>, {
        ...expected,
        runId: randomUUID(),
      }),
    );
    assert.throws(() => verifyBrokerResponse(403, { error: "not_entitled" }, { ...expected, denied: true }));
    assert.equal(
      brokerCountsMatch({ usageOk: 1, usageDenied: 1, usageOther: 0, auditOk: 1, auditDenied: 1, auditOther: 0 }, 1, 1),
      true,
    );
    assert.equal(
      brokerCountsMatch({ usageOk: 1, usageDenied: 1, usageOther: 0, auditOk: 0, auditDenied: 1, auditOther: 0 }, 1, 1),
      false,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
