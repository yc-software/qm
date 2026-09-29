import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { connect as connectTls } from "node:tls";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { EGRESS_PROXY_AUD, mintCapabilityToken } from "../../src/auth/capability-token.ts";
import { orgId } from "../../src/config.ts";
import type { WorkloadFixture } from "./workload.ts";
import { workloadCheck } from "./workload-provider.ts";
import { brokerReceiptsMatch, verifyBrokerResponse } from "./workload-credential.ts";
import { BROKER_IDENTITY_PATH, BROKER_METRICS_PATH, BROKER_PATH } from "./workload-credential-responder.ts";

export interface EgressProofProfile {
  schemaVersion: 1;
  isolated: true;
  fixtureId: string;
  profileSha256: string;
  campaignId: string;
  coreOrigin: string;
  proxyOrigin: string;
  responderControlOrigin: string;
  responderProfileSha256: string;
  targetHost: string;
  deniedHost: string;
  targetPort: number;
  orgScopeId: string;
  principalId: string;
  guardCase: { sessionId: string; principalId: string; expectedVisibleText: string };
  databaseUrlEnv: string;
  sourceSecretEnv: string;
  capabilitySecretEnv: string;
  syntheticSecretEnv: string;
  controlTokenEnv: string;
  timeoutMs: number;
  persistenceTimeoutMs: number;
}

export interface EgressDeploymentProof {
  fixtureId: string;
  profileSha256: string;
  campaignId: string;
  observedAt: number;
  running: true;
  proxyImageId: string;
  authzSourceSha256: string;
  envoyConfigSha256: string;
  proxyContainerId: string;
  responderContainerId: string;
  networkId: string;
}

export function validateEgressProof(profile: EgressProofProfile, fixture: WorkloadFixture, env = process.env): void {
  workloadCheck(profile.schemaVersion === 1 && profile.isolated === true, "Isolated egress proof required");
  workloadCheck(
    profile.fixtureId === fixture.fixtureId &&
      profile.profileSha256 === fixture.profileSha256 &&
      /^qm_perf_\w+$/.test(fixture.databaseName),
    "Egress fixture binding mismatch",
  );
  workloadCheck(
    /^[0-9a-f-]{36}$/.test(profile.campaignId) &&
      profile.targetHost === `qm-perf-egress-${profile.campaignId}.test` &&
      profile.deniedHost === `qm-perf-egress-denied-${profile.campaignId}.invalid`,
    "Unique synthetic egress hostnames required",
  );
  for (const [origin, protocol, binding] of [
    [profile.coreOrigin, "http:", "QM_PERFORMANCE_ALLOWED_ORIGIN"],
    [profile.proxyOrigin, "http:", "QM_PERFORMANCE_EGRESS_PROXY_ORIGIN"],
    [profile.responderControlOrigin, "https:", "QM_PERFORMANCE_EGRESS_CONTROL_ORIGIN"],
  ]) {
    const url = new URL(origin!);
    workloadCheck(url.origin === origin && url.protocol === protocol, "Unexpected fixture origin protocol or path");
    workloadCheck(
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || env[binding!] === origin,
      "Remote egress proof origin requires explicit binding",
    );
  }
  workloadCheck(
    profile.orgScopeId === `org:${orgId()}` &&
      profile.principalId.endsWith("@example.invalid") &&
      profile.guardCase.principalId === profile.principalId &&
      profile.guardCase.sessionId &&
      profile.guardCase.expectedVisibleText,
    "Synthetic fixture actor and owned guard required",
  );
  for (const name of [
    profile.databaseUrlEnv,
    profile.sourceSecretEnv,
    profile.capabilitySecretEnv,
    profile.syntheticSecretEnv,
    profile.controlTokenEnv,
  ])
    workloadCheck(typeof name === "string" && env[name], "Missing egress proof environment binding");
  workloadCheck(
    new URL(env[profile.databaseUrlEnv]!).pathname.slice(1) === fixture.databaseName,
    "Egress observer database mismatch",
  );
  workloadCheck(
    /^qm-perf-synthetic-[a-zA-Z0-9_-]{32,}$/.test(env[profile.syntheticSecretEnv]!) &&
      env[profile.controlTokenEnv]!.length >= 32 &&
      env[profile.controlTokenEnv] !== env[profile.syntheticSecretEnv],
    "Distinct synthetic responder secrets required",
  );
  workloadCheck(env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "TLS verification must remain enabled");
  workloadCheck(/^[a-f0-9]{64}$/.test(profile.responderProfileSha256), "Responder profile hash required");
  workloadCheck(
    Number.isInteger(profile.targetPort) && profile.targetPort > 0 && profile.targetPort < 65536,
    "Invalid fixture target port",
  );
  for (const key of ["timeoutMs", "persistenceTimeoutMs"] as const)
    workloadCheck(
      Number.isInteger(profile[key]) && profile[key] > 0 && profile[key] <= 60_000,
      "Bounded deadline required",
    );
}

export function connectThroughEgress(input: {
  proxyOrigin: string;
  host: string;
  port: number;
  capability: string;
  path: string;
  secret: string;
  timeoutMs: number;
  ca?: Buffer;
}): Promise<{ connectStatus: number; upstreamStatus?: number; body?: string; elapsedMs: number }> {
  return new Promise((resolveResult, reject) => {
    const started = performance.now();
    let tunnel: Socket | undefined;
    let agent: Agent | undefined;
    let settled = false;
    const finish = (error?: Error, result?: { connectStatus: number; upstreamStatus?: number; body?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      agent?.destroy();
      tunnel?.destroy();
      if (error) reject(error);
      else resolveResult({ ...result!, elapsedMs: performance.now() - started });
    };
    const timer = setTimeout(() => finish(new Error("Native egress CONNECT deadline exceeded")), input.timeoutMs);
    const authority = `${input.host}:${input.port}`;
    const request = httpRequest(input.proxyOrigin, {
      method: "CONNECT",
      path: authority,
      headers: { host: authority, "proxy-authorization": `Bearer ${input.capability}` },
      agent: false,
    });
    request.on("error", (error) => finish(error));
    request.on("response", (response) => {
      response.resume();
      finish(undefined, { connectStatus: response.statusCode ?? 0 });
    });
    request.on("connect", (response, socket, head) => {
      tunnel = socket;
      if (response.statusCode !== 200) return finish(undefined, { connectStatus: response.statusCode ?? 0 });
      if (head.length) socket.unshift(head);
      agent = new Agent({ keepAlive: false });
      agent.createConnection = () =>
        connectTls({ socket, servername: input.host, rejectUnauthorized: true, ...(input.ca ? { ca: input.ca } : {}) });
      const upstream = httpsRequest(
        {
          hostname: input.host,
          port: input.port,
          path: input.path,
          method: "GET",
          headers: { authorization: `Bearer ${input.secret}`, connection: "close" },
          agent,
        },
        (result) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          result.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 5_000_000) {
              result.destroy();
              finish(new Error("Fixture HTTPS response exceeds its bounded proof size"));
            } else chunks.push(chunk);
          });
          result.on("error", (error) => finish(error));
          result.on("end", () =>
            finish(undefined, {
              connectStatus: 200,
              upstreamStatus: result.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      upstream.on("error", (error) => finish(error));
      upstream.end();
    });
    request.end();
  });
}

export async function egressEventCounts(
  client: Pick<Client, "query">,
  targetHost: string,
  deniedHost: string,
  principalId: string,
) {
  return (
    await client.query(
      "SELECT count(*) FILTER(WHERE host=$1 AND source='proxy' AND principal_id=$4 AND scope_label=$5 AND allowed AND verdict='ok')::int AS allowed,count(*) FILTER(WHERE host=$2 AND source='proxy' AND principal_id=$4 AND scope_label=$5 AND NOT allowed AND verdict='not_allowlisted')::int AS denied,count(*)::int AS total FROM egress_events WHERE host=ANY($3)",
      [targetHost, deniedHost, [targetHost, deniedHost], principalId, `personal:${principalId}`],
    )
  ).rows[0] as { allowed: number; denied: number; total: number };
}

export async function runEgressProof(
  profile: EgressProofProfile,
  fixture: WorkloadFixture,
  deployment: EgressDeploymentProof,
  emit: (record: Record<string, unknown>) => void,
  env = process.env,
) {
  validateEgressProof(profile, fixture, env);
  workloadCheck(
    deployment.fixtureId === fixture.fixtureId &&
      deployment.profileSha256 === fixture.profileSha256 &&
      deployment.campaignId === profile.campaignId &&
      deployment.running === true &&
      deployment.observedAt <= Date.now() &&
      Date.now() - deployment.observedAt <= 300_000 &&
      /^sha256:[a-f0-9]{64}$/.test(deployment.proxyImageId) &&
      /^[a-f0-9]{64}$/.test(deployment.authzSourceSha256) &&
      /^[a-f0-9]{64}$/.test(deployment.envoyConfigSha256) &&
      [deployment.proxyContainerId, deployment.responderContainerId, deployment.networkId].every((id) =>
        /^[a-f0-9]{64}$/.test(id),
      ),
    "Fresh isolated proxy deployment attestation required",
  );
  const runId = randomUUID();
  const profileHash = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  const event = (record: Record<string, unknown>) =>
    emit({
      ...record,
      at: Date.now(),
      runId,
      fixtureId: fixture.fixtureId,
      profileSha256: fixture.profileSha256,
      egressProfileSha256: profileHash,
      qualified: false,
    });
  const client = new Client({
    connectionString: env[profile.databaseUrlEnv],
    application_name: "qm-performance-egress-observer",
    options: "-c default_transaction_read_only=on -c statement_timeout=5000",
  });
  const scope = `personal:${profile.principalId}`;
  const counts = () => egressEventCounts(client, profile.targetHost, profile.deniedHost, profile.principalId);
  const control = async (path: string) => {
    const response = await fetch(new URL(path, profile.responderControlOrigin), {
      headers: { "x-qm-perf-control": env[profile.controlTokenEnv]! },
      signal: AbortSignal.timeout(profile.timeoutMs),
      redirect: "error",
    });
    workloadCheck(response.status === 200, "HTTPS fixture control unavailable");
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    await client.connect();
    const marker = (
      await client.query(
        "SELECT current_database() AS database,fixture_id,profile_sha256,status FROM qm_performance_fixture",
      )
    ).rows;
    workloadCheck(
      marker.length === 1 &&
        marker[0].database === fixture.databaseName &&
        marker[0].fixture_id === fixture.fixtureId &&
        marker[0].profile_sha256 === fixture.profileSha256 &&
        marker[0].status === "ready",
      "Egress fixture marker mismatch",
    );
    const path = `/v1/sessions/${encodeURIComponent(profile.guardCase.sessionId)}?viewer=${encodeURIComponent(profile.principalId)}&tailTurns=1`;
    const guard = await fetch(new URL(path, profile.coreOrigin), {
      headers: signedRequestHeaders(env[profile.sourceSecretEnv], "GET", path, ""),
      signal: AbortSignal.timeout(profile.timeoutMs),
      redirect: "error",
    });
    workloadCheck(
      guard.status === 200 && (await guard.text()).includes(profile.guardCase.expectedVisibleText),
      "Core fixture guard mismatch",
    );
    const identity = await control(BROKER_IDENTITY_PATH);
    workloadCheck(
      identity.fixtureId === fixture.fixtureId &&
        identity.profileSha256 === fixture.profileSha256 &&
        identity.responderProfileSha256 === profile.responderProfileSha256 &&
        Number.isSafeInteger(identity.payloadBytes),
      "Egress responder identity mismatch",
    );
    const before = await counts();
    workloadCheck(before.total === 0, "Egress campaign hostnames already have events; prepare a fresh campaign");
    event({ type: "egress-bootstrap", before, deployment, responder: identity });
    const capability = await mintCapabilityToken(
      {
        actorId: profile.principalId,
        scopeId: scope,
        aud: EGRESS_PROXY_AUD,
        exp: Date.now() + 2 * profile.timeoutMs + profile.persistenceTimeoutMs + 30_000,
        egress: {
          allowedHosts: [profile.targetHost],
          deniedHosts: [],
          denyPrivateNetworks: true,
          privateNetworkAllowedHosts: [profile.targetHost],
        },
      },
      env[profile.capabilitySecretEnv]!,
    );
    for (const denied of [false, true]) {
      const response = await connectThroughEgress({
        proxyOrigin: profile.proxyOrigin,
        host: denied ? profile.deniedHost : profile.targetHost,
        port: profile.targetPort,
        capability,
        path: `${BROKER_PATH}${runId}/0`,
        secret: env[profile.syntheticSecretEnv]!,
        timeoutMs: profile.timeoutMs,
      });
      event({
        type: "egress-native-response",
        class: denied ? "denial" : "success",
        connectStatus: response.connectStatus,
        upstreamStatus: response.upstreamStatus,
        elapsedMs: response.elapsedMs,
        responseBytes: Buffer.byteLength(response.body ?? ""),
      });
      if (denied)
        workloadCheck(
          response.connectStatus === 403 && response.body === undefined,
          "Expected native egress policy denial",
        );
      else {
        workloadCheck(
          response.connectStatus === 200 && !response.body?.includes(env[profile.syntheticSecretEnv]!),
          "CONNECT failed or response exposed its synthetic credential",
        );
        verifyBrokerResponse(
          200,
          { status: response.upstreamStatus, body: response.body },
          {
            denied: false,
            fixtureId: fixture.fixtureId,
            profileSha256: fixture.profileSha256,
            runId,
            sequence: 0,
            payloadBytes: identity.payloadBytes as number,
          },
        );
      }
    }
    const deadline = Date.now() + profile.persistenceTimeoutMs;
    let persisted = await counts();
    while (persisted.total < 2 && Date.now() < deadline) {
      await sleep(100);
      persisted = await counts();
    }
    event({ type: "egress-relay-settle", persisted, observationMs: 12_100 });
    await sleep(12_100);
    persisted = await counts();
    const responder = await control(`${BROKER_METRICS_PATH}${runId}`);
    const pass =
      persisted.allowed === 1 && persisted.denied === 1 && persisted.total === 2 && brokerReceiptsMatch(responder, 1);
    event({
      type: "egress-proof",
      pass,
      persisted,
      responder,
      limitations: [
        "Fixed one-allow/one-deny functionality proof; no production rate or latency qualification",
        "Native Envoy/authz/relay cost is exercised; remote sandbox forced-network and provisioning boundaries are not",
        "The deployment attestation is supplied by the reviewed fixture launcher; source hashes alone do not establish production resource parity",
      ],
    });
    return { pass, runId, persisted, responder, qualified: false };
  } catch (error) {
    event({
      type: "egress-error",
      error:
        error instanceof Error
          ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database URL redacted]")
          : "Unknown error",
    });
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      profile: { type: "string" },
      fixture: { type: "string" },
      deployment: { type: "string" },
      output: { type: "string" },
    },
  });
  workloadCheck(
    values.profile && values.fixture && values.deployment && values.output,
    "--profile, --fixture, --deployment and --output required",
  );
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const fd = openSync(values.output, "wx", 0o600);
  runEgressProof(read(values.profile), read(values.fixture), read(values.deployment), (record) =>
    writeSync(fd, JSON.stringify(record) + "\n"),
  )
    .then((result) => {
      console.log(JSON.stringify(result));
      if (!result.pass) process.exitCode = 1;
    })
    .catch(() => {
      console.error("Native egress proof failed; inspect its nonsecret evidence");
      process.exitCode = 1;
    })
    .finally(() => closeSync(fd));
}
