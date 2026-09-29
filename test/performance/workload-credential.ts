import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../src/auth/portal-identity.ts";
import { CREDENTIAL_BROKER_AUD, mintCapabilityToken } from "../../src/auth/capability-token.ts";
import { orgId } from "../../src/config.ts";
import { encodeRef, serviceCredRef } from "../../src/acl/resource-ref.ts";
import { runWorkload, validateWorkload, type WorkloadFixture, type WorkloadProfile } from "./workload.ts";
import { workloadCheck } from "./workload-provider.ts";
import { BROKER_IDENTITY_PATH, BROKER_METRICS_PATH, BROKER_PATH } from "./workload-credential-responder.ts";

type Bound = { min: number; max: number };
export interface CredentialWorkloadProfile {
  workload: WorkloadProfile;
  databaseUrlEnv: string;
  sourceSecretEnv: string;
  capabilitySecretEnv: string;
  portalIdentitySecretEnv: string;
  syntheticSecretEnv: string;
  controlTokenEnv: string;
  orgScopeId: string;
  principalId: string;
  responderOrigin: string;
  responderProfileSha256: string;
  guardCase: { sessionId: string; principalId: string; expectedVisibleText: string };
  successRatePerSecond: number;
  denialRatePerSecond: number;
  persistenceTimeoutMs: number;
  bounds: { successfulRate: Bound; deniedRate: Bound };
}

type Emit = (record: Record<string, unknown>) => void;
export interface BrokerCounts {
  usageOk: number;
  usageDenied: number;
  usageOther: number;
  auditOk: number;
  auditDenied: number;
  auditOther: number;
}

export function brokerCountsMatch(counts: BrokerCounts, successful: number, denied: number): boolean {
  return (
    counts.usageOk === successful &&
    counts.usageDenied === denied &&
    counts.auditOk === successful &&
    counts.auditDenied === denied &&
    counts.usageOther === 0 &&
    counts.auditOther === 0
  );
}

export function brokerReceiptsMatch(counts: Record<string, unknown>, successful: number): boolean {
  return (
    counts.arrivals === successful &&
    counts.unexpected === 0 &&
    counts.accepted === successful &&
    counts.uniqueSequences === successful
  );
}

function generatedWorkload(profile: CredentialWorkloadProfile, runId: string, slug: string): WorkloadProfile {
  return {
    ...profile.workload,
    streams: [],
    requests: [
      {
        name: "broker-success",
        ratePerSecond: profile.successRatePerSecond,
        expectedStatuses: [200],
        prefix: BROKER_PATH,
      },
      {
        name: "broker-path-denied",
        ratePerSecond: profile.denialRatePerSecond,
        expectedStatuses: [403],
        prefix: "/__qm_perf/denied/",
      },
    ].map(({ prefix, ...lane }) => ({
      ...lane,
      method: "POST",
      path: "/v1/credentials/broker",
      body: { credential: slug, method: "GET", url: `${profile.responderOrigin}${prefix}${runId}/{{sequence}}` },
    })),
  };
}

export function validateCredentialWorkload(
  profile: CredentialWorkloadProfile,
  fixture: WorkloadFixture,
  env = process.env,
): void {
  workloadCheck(
    profile.workload.requests.length === 0 && profile.workload.streams.length === 0,
    "Broker lanes are generated",
  );
  validateWorkload(
    generatedWorkload(profile, "00000000-0000-0000-0000-000000000000", "qm-perf-validation"),
    fixture,
    env,
  );
  workloadCheck(profile.orgScopeId === `org:${orgId()}`, "Fixture ORG_ID does not match the broker org scope");
  workloadCheck(profile.principalId.endsWith("@example.invalid"), "Synthetic fixture principal required");
  for (const name of [
    profile.databaseUrlEnv,
    profile.sourceSecretEnv,
    profile.capabilitySecretEnv,
    profile.portalIdentitySecretEnv,
    profile.syntheticSecretEnv,
    profile.controlTokenEnv,
  ])
    workloadCheck(
      typeof name === "string" && env[name],
      "A required credential workload environment variable is missing",
    );
  const database = new URL(env[profile.databaseUrlEnv]!);
  workloadCheck(database.pathname.slice(1) === fixture.databaseName, "Broker observer database mismatch");
  workloadCheck(
    /^qm-perf-synthetic-[a-zA-Z0-9_-]{32,}$/.test(env[profile.syntheticSecretEnv]!),
    "Only synthetic broker secrets are allowed",
  );
  workloadCheck(
    env[profile.controlTokenEnv]!.length >= 32 && env[profile.controlTokenEnv] !== env[profile.syntheticSecretEnv],
    "A distinct responder control token is required",
  );
  workloadCheck(env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "TLS verification must remain enabled");
  const responder = new URL(profile.responderOrigin);
  workloadCheck(
    responder.protocol === "https:" && responder.origin === profile.responderOrigin,
    "Responder must be an HTTPS origin",
  );
  workloadCheck(
    ["localhost", "127.0.0.1", "[::1]"].includes(responder.hostname) ||
      env.QM_PERFORMANCE_BROKER_ALLOWED_ORIGIN === responder.origin,
    "Remote responder origin must be explicitly bound",
  );
  workloadCheck(/^[a-f0-9]{64}$/.test(profile.responderProfileSha256), "Responder profile hash required");
  workloadCheck(
    profile.successRatePerSecond > 0 && Number.isFinite(profile.denialRatePerSecond) && profile.denialRatePerSecond > 0,
    "Successful and denial arrival classes are required",
  );
  workloadCheck(
    Number.isSafeInteger(profile.persistenceTimeoutMs) &&
      profile.persistenceTimeoutMs > 0 &&
      profile.persistenceTimeoutMs <= 60_000,
    "Bounded persistence deadline required",
  );
  for (const key of ["successfulRate", "deniedRate"] as const) {
    const bound = profile.bounds[key];
    workloadCheck(
      bound && Number.isFinite(bound.min) && Number.isFinite(bound.max) && bound.min > 0 && bound.max >= bound.min,
      "Invalid credential rate bounds",
    );
  }
  workloadCheck(
    profile.guardCase.principalId === profile.principalId &&
      profile.guardCase.sessionId &&
      profile.guardCase.expectedVisibleText,
    "Owned fixture guard case required",
  );
}

export function verifyBrokerResponse(
  status: number,
  data: Record<string, unknown>,
  expected: {
    denied: boolean;
    fixtureId: string;
    profileSha256: string;
    runId: string;
    sequence: number;
    payloadBytes: number;
  },
): void {
  if (expected.denied) {
    workloadCheck(
      status === 403 && data.error === "path_not_allowed",
      "Broker denial did not match the native path policy",
    );
    return;
  }
  workloadCheck(
    status === 200 && data.status === 200 && data.truncated !== true && typeof data.body === "string",
    "Broker did not return a complete successful HTTPS response",
  );
  const body = JSON.parse(data.body) as Record<string, unknown>;
  workloadCheck(
    body.fixtureId === expected.fixtureId &&
      body.profileSha256 === expected.profileSha256 &&
      body.runId === expected.runId &&
      body.sequence === expected.sequence &&
      typeof body.payload === "string" &&
      Buffer.byteLength(body.payload) === expected.payloadBytes,
    "Broker response fixture/request identity mismatch",
  );
}

export async function runCredentialWorkload(
  profile: CredentialWorkloadProfile,
  fixture: WorkloadFixture,
  emit: Emit,
  env = process.env,
) {
  validateCredentialWorkload(profile, fixture, env);
  const runId = randomUUID();
  const slug = `qm-perf-broker-${runId}`;
  const sourceHash = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  const event: Emit = (record) =>
    emit({
      ...record,
      at: Date.now(),
      credentialRunId: runId,
      fixtureId: fixture.fixtureId,
      profileSha256: fixture.profileSha256,
      credentialProfileSha256: sourceHash,
      qualified: false,
    });
  const client = new Client({
    connectionString: env[profile.databaseUrlEnv],
    application_name: "qm-performance-broker-observer",
    options: "-c default_transaction_read_only=on -c statement_timeout=5000",
  });
  const native = async (method: string, path: string, data?: unknown, admin = false) => {
    const body = data === undefined ? "" : JSON.stringify(data);
    const headers = signedRequestHeaders(env[profile.sourceSecretEnv], method, path, body, {
      "content-type": "application/json",
    });
    if (admin)
      headers[PORTAL_IDENTITY_HEADER] = await mintPortalIdentity(
        { p: profile.principalId, exp: Date.now() + 30_000 },
        env[profile.portalIdentitySecretEnv]!,
      );
    return fetch(new URL(path, profile.workload.baseUrl), {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(profile.workload.requestTimeoutMs),
    });
  };
  const responder = async (path: string) => {
    const response = await fetch(new URL(path, profile.responderOrigin), {
      headers: { "x-qm-perf-control": env[profile.controlTokenEnv]! },
      redirect: "error",
      signal: AbortSignal.timeout(profile.workload.requestTimeoutMs),
    });
    workloadCheck(response.status === 200, "Trusted HTTPS fixture responder unavailable");
    return (await response.json()) as Record<string, unknown>;
  };
  const adminPath = `/v1/admin/scopes/${encodeURIComponent(profile.orgScopeId)}/service-credentials`;
  const credential = {
    slug,
    name: "QM performance synthetic broker",
    delivery: "broker",
    secret: env[profile.syntheticSecretEnv],
    host: new URL(profile.responderOrigin).hostname,
    injection: { header: "Authorization", scheme: "Bearer " },
    allowedMethods: ["GET"],
    allowedPathPrefixes: [BROKER_PATH],
    deployments: false,
    enabled: true,
    grantees: [`personal:${profile.principalId}`],
  };
  let credentialVersion: number | undefined;
  let createAttempted = false;
  let creationAcknowledged = false;
  let activationAttempted = false;
  let activationAcknowledged = false;
  let successful = 0;
  let denied = 0;
  let stage = "fixture-guard";
  const measuredAt = Date.now();
  const counts = async (): Promise<BrokerCounts> => {
    const usage = (
      await client.query(
        "SELECT count(*) FILTER(WHERE status='ok' AND upstream_status=200)::int AS ok,count(*) FILTER(WHERE status='denied')::int AS denied,count(*)::int AS total FROM credential_usage WHERE slug=$1 AND scope_label=$2 AND principal_id=$3",
        [slug, `personal:${profile.principalId}`, profile.principalId],
      )
    ).rows[0];
    const audit = (
      await client.query(
        "SELECT count(*) FILTER(WHERE action='credential.broker.use' AND status='ok')::int AS ok,count(*) FILTER(WHERE action='credential.broker.denied' AND status='denied' AND detail='path_not_allowed')::int AS denied,count(*)::int AS total FROM audit_log WHERE at >= $1 AND resource=$2 AND scope_label=$3 AND principal_id=$4 AND action LIKE 'credential.broker.%'",
        [measuredAt, slug, `personal:${profile.principalId}`, profile.principalId],
      )
    ).rows[0];
    return {
      usageOk: usage.ok,
      usageDenied: usage.denied,
      usageOther: usage.total - usage.ok - usage.denied,
      auditOk: audit.ok,
      auditDenied: audit.denied,
      auditOther: audit.total - audit.ok - audit.denied,
    };
  };
  const statistics = async () =>
    (
      await client.query(
        "SELECT s.relname,s.n_tup_ins::text,s.n_tup_upd::text,s.n_tup_del::text,d.stats_reset::text FROM pg_stat_user_tables s CROSS JOIN pg_stat_database d WHERE d.datname=current_database() AND s.relname=ANY($1)",
        [["credential_usage", "audit_log", "keychain_credentials", "acl_grants", "egress_events"]],
      )
    ).rows;
  const credentialState = async () =>
    (
      await client.query(
        "SELECT (json->>'updatedAt')::bigint AS version,json->'broker'->'enabled'='false'::jsonb AS disabled,(SELECT count(*)::int FROM acl_grants WHERE owner_scope_id=$1 AND path=$3) AS grants FROM keychain_credentials WHERE json->>'ownerId'=$1 AND json->>'service'=$2",
        [profile.orgScopeId, slug, encodeRef(serviceCredRef(slug))],
      )
    ).rows[0] as { version: string; disabled: boolean; grants: number } | undefined;
  try {
    await client.connect();
    const marker = await client.query(
      "SELECT current_database() AS database,fixture_id,profile_sha256,status FROM qm_performance_fixture",
    );
    workloadCheck(
      marker.rows.length === 1 &&
        marker.rows[0].database === fixture.databaseName &&
        marker.rows[0].fixture_id === fixture.fixtureId &&
        marker.rows[0].profile_sha256 === fixture.profileSha256 &&
        marker.rows[0].status === "ready",
      "Native broker fixture marker mismatch",
    );
    const guard = await native(
      "GET",
      `/v1/sessions/${encodeURIComponent(profile.guardCase.sessionId)}?viewer=${encodeURIComponent(profile.principalId)}&tailTurns=1`,
    );
    workloadCheck(
      guard.status === 200 && (await guard.text()).includes(profile.guardCase.expectedVisibleText),
      "Core fixture sentinel mismatch",
    );
    const identity = await responder(BROKER_IDENTITY_PATH);
    workloadCheck(
      identity.fixtureId === fixture.fixtureId &&
        identity.profileSha256 === fixture.profileSha256 &&
        identity.responderProfileSha256 === profile.responderProfileSha256 &&
        Number.isSafeInteger(identity.payloadBytes),
      "HTTPS responder identity mismatch",
    );
    stage = "credential-create";
    createAttempted = true;
    const create = await native("PUT", adminPath, { ...credential, enabled: false, grantees: [] }, true);
    workloadCheck(create.status === 200, "Native synthetic credential creation failed");
    creationAcknowledged = true;
    const stored = (
      await client.query(
        "SELECT (json->>'updatedAt')::bigint AS version,json->>'kind' AS kind,json->>'host' AS host,json->'broker'->>'delivery' AS delivery,length(json->>'secretEnc')>0 AS encrypted FROM keychain_credentials WHERE json->>'ownerId'=$1 AND json->>'service'=$2",
        [profile.orgScopeId, slug],
      )
    ).rows;
    workloadCheck(
      stored.length === 1 && stored[0].kind === "broker" && stored[0].host === credential.host && stored[0].encrypted,
      "Native encrypted broker credential was not persisted",
    );
    credentialVersion = Number(stored[0].version);
    const inert = await credentialState();
    workloadCheck(inert?.disabled && inert.grants === 0, "Synthetic credential creation must remain inert");
    stage = "credential-activate";
    activationAttempted = true;
    const activate = await native("PUT", adminPath, { ...credential, expectedUpdatedAt: credentialVersion }, true);
    workloadCheck(activate.status === 200, "Native synthetic credential activation failed");
    activationAcknowledged = true;
    const before = await counts();
    workloadCheck(brokerCountsMatch(before, 0, 0), "Unique broker lane already has durable events");
    event({
      type: "credential-bootstrap",
      slug,
      principalId: profile.principalId,
      orgScopeId: profile.orgScopeId,
      encrypted: true,
      responder: identity,
      before,
      globalCounters: await statistics(),
    });
    const capability = await mintCapabilityToken(
      {
        actorId: profile.principalId,
        scopeId: `personal:${profile.principalId}`,
        aud: CREDENTIAL_BROKER_AUD,
        credentials: [slug],
        exp: Date.now() + profile.workload.durationMs + profile.workload.requestTimeoutMs + 60_000,
      },
      env[profile.capabilitySecretEnv]!,
    );
    stage = "broker-requests";
    const summary = await runWorkload(generatedWorkload(profile, runId, slug), fixture, {
      env,
      emit: event,
      fetcher: async (input, init) => {
        workloadCheck(
          String(input) === new URL("/v1/credentials/broker", profile.workload.baseUrl).href,
          "Unexpected broker dispatch path",
        );
        const request = JSON.parse(String(init?.body)) as { credential: string; url: string };
        workloadCheck(
          request.credential === slug && new URL(request.url).origin === profile.responderOrigin,
          "Broker dispatch escaped its fixture binding",
        );
        const isDenied = new URL(request.url).pathname.startsWith("/__qm_perf/denied/");
        const sequence = Number(new URL(request.url).pathname.split("/").at(-1));
        const started = performance.now();
        const response = await fetch(input, {
          ...init,
          headers: { "content-type": "application/json", "x-agent-capability": capability },
          redirect: "error",
        });
        const text = await response.text();
        workloadCheck(!text.includes(env[profile.syntheticSecretEnv]!), "Broker exposed its synthetic credential");
        verifyBrokerResponse(response.status, JSON.parse(text), {
          denied: isDenied,
          fixtureId: fixture.fixtureId,
          profileSha256: fixture.profileSha256,
          runId,
          sequence,
          payloadBytes: identity.payloadBytes as number,
        });
        if (isDenied) denied++;
        else successful++;
        event({
          type: "credential-native-response",
          class: isDenied ? "denial" : "success",
          sequence,
          httpStatus: response.status,
          elapsedMs: performance.now() - started,
          responseBytes: Buffer.byteLength(text),
        });
        return new Response(null, { status: response.status });
      },
    });
    stage = "durable-proof";
    const deadline = Date.now() + profile.persistenceTimeoutMs;
    let persisted = await counts();
    while (!brokerCountsMatch(persisted, successful, denied) && Date.now() < deadline) {
      await sleep(100);
      persisted = await counts();
    }
    const remote = await responder(`${BROKER_METRICS_PATH}${runId}`);
    const seconds = (summary.finishedAt - summary.startedAt) / 1000;
    const rates = {
      successfulRate: summary.requests.find((row) => row.name === "broker-success")!.completedInWindow / seconds,
      deniedRate: summary.requests.find((row) => row.name === "broker-path-denied")!.completedInWindow / seconds,
    };
    const ratePass = Object.entries(profile.bounds).every(
      ([key, bound]) => rates[key as keyof typeof rates] >= bound.min && rates[key as keyof typeof rates] <= bound.max,
    );
    const pass =
      summary.pass &&
      successful > 0 &&
      denied > 0 &&
      brokerCountsMatch(persisted, successful, denied) &&
      brokerReceiptsMatch(remote, successful) &&
      ratePass;
    event({
      type: "credential-proof",
      pass,
      slug,
      successful,
      denied,
      persisted,
      responder: remote,
      rates,
      globalCounters: await statistics(),
      bounds: profile.bounds,
      limitations: [
        "Broker calls do not exercise sandbox keychain.materialize or egress proxy writes",
        "One synthetic credential and a fixed-size responder payload do not establish production credential/request-shape parity",
        "Global PostgreSQL counters include other workloads and can lag; exact scoped durable rows prove this lane",
        "Fixture and runtime qualification remain separate",
      ],
    });
    return { pass, runId, slug, successful, denied, persisted, rates, qualified: false };
  } catch (error) {
    event({
      type: "credential-error",
      stage,
      error:
        error instanceof Error
          ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database URL redacted]")
          : "Unknown failure",
    });
    throw error;
  } finally {
    let cleanupOk = true;
    try {
      if (createAttempted) {
        const { secret: _secret, ...metadata } = credential;
        const deadline = Date.now() + profile.persistenceTimeoutMs;
        let disabled = false;
        let grantsRemoved = false;
        while (Date.now() < deadline) {
          const current = await credentialState();
          if (current) {
            const cleanup = await native(
              "PUT",
              adminPath,
              { ...metadata, enabled: false, grantees: [], expectedUpdatedAt: Number(current.version) },
              true,
            ).catch(() => null);
            if (cleanup?.status === 200) {
              const verified = await credentialState();
              disabled = verified?.disabled === true && Number(verified.version) > Number(current.version);
              grantsRemoved = verified?.grants === 0;
              if (disabled && grantsRemoved) break;
            }
          }
          await sleep(50);
        }
        const unresolved =
          !disabled || !grantsRemoved || !creationAcknowledged || (activationAttempted && !activationAcknowledged);
        event({
          type: "credential-cleanup",
          slug,
          disabled,
          grantsRemoved,
          creationAcknowledged,
          activationAttempted,
          activationAcknowledged,
          unresolved,
          lateCreateIsInert: !creationAcknowledged,
        });
        cleanupOk = !unresolved;
      }
    } catch {
      cleanupOk = false;
      event({ type: "credential-cleanup", slug, disabled: false, grantsRemoved: false, unresolved: true });
    } finally {
      await client.end();
    }
    workloadCheck(cleanupOk, "Synthetic broker credential cleanup remains unresolved");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: { profile: { type: "string" }, fixture: { type: "string" }, output: { type: "string" } },
  });
  workloadCheck(values.profile && values.fixture && values.output, "--profile, --fixture and --output required");
  const profile = JSON.parse(readFileSync(values.profile, "utf8")) as CredentialWorkloadProfile;
  const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as WorkloadFixture;
  const fd = openSync(values.output, "wx", 0o600);
  runCredentialWorkload(profile, fixture, (record) => writeSync(fd, JSON.stringify(record) + "\n"))
    .then((summary) => {
      console.log(JSON.stringify(summary));
      if (!summary.pass) process.exitCode = 1;
    })
    .catch(() => {
      console.error("Native credential workload failed; inspect its nonsecret evidence");
      process.exitCode = 1;
    })
    .finally(() => closeSync(fd));
}
