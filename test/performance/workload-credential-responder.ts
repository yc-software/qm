import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { WorkloadFixture } from "./workload.ts";
import { workloadCheck } from "./workload-provider.ts";

export interface CredentialResponderProfile {
  schemaVersion: 1;
  fixtureId: string;
  profileSha256: string;
  isolated: true;
  bind: string;
  port: number;
  certificateFileEnv: string;
  privateKeyFileEnv: string;
  syntheticSecretEnv: string;
  controlTokenEnv: string;
  payloadBytes: number;
}

export const BROKER_PATH = "/__qm_perf/broker/";
export const BROKER_IDENTITY_PATH = "/__qm_perf/identity";
export const BROKER_METRICS_PATH = "/__qm_perf/metrics/";

function equalSecret(actual: string | undefined, expected: string): boolean {
  const left = Buffer.from(actual ?? "");
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateCredentialResponder(
  profile: CredentialResponderProfile,
  fixture: WorkloadFixture,
  env = process.env,
): void {
  workloadCheck(profile.schemaVersion === 1 && profile.isolated === true, "Isolated responder profile required");
  workloadCheck(
    profile.fixtureId === fixture.fixtureId && profile.profileSha256 === fixture.profileSha256,
    "Credential responder fixture identity mismatch",
  );
  workloadCheck(/^qm_perf_[a-zA-Z0-9_]+$/.test(fixture.databaseName), "Fixture database name required");
  workloadCheck(["127.0.0.1", "::1", "0.0.0.0"].includes(profile.bind), "Explicit fixture bind required");
  workloadCheck(Number.isSafeInteger(profile.port) && profile.port > 0 && profile.port < 65536, "Invalid port");
  workloadCheck(
    Number.isSafeInteger(profile.payloadBytes) && profile.payloadBytes >= 0 && profile.payloadBytes <= 4_000_000,
    "Invalid response payload size",
  );
  workloadCheck(
    /^qm-perf-synthetic-[a-zA-Z0-9_-]{32,}$/.test(env[profile.syntheticSecretEnv] ?? ""),
    "Responder requires a synthetic fixture secret",
  );
  workloadCheck(
    (env[profile.controlTokenEnv]?.length ?? 0) >= 32 &&
      env[profile.controlTokenEnv] !== env[profile.syntheticSecretEnv],
    "Distinct responder control token required",
  );
  workloadCheck(
    env[profile.certificateFileEnv] && env[profile.privateKeyFileEnv],
    "Trusted fixture TLS certificate and key paths required",
  );
  workloadCheck(env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "TLS verification must remain enabled");
}

export function credentialResponder(
  profile: CredentialResponderProfile,
  fixture: WorkloadFixture,
  env = process.env,
  emit: (record: Record<string, unknown>) => void = () => {},
): Server {
  validateCredentialResponder(profile, fixture, env);
  const profileSha256 = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
  const runs = new Map<
    string,
    { arrivals: number; unexpected: number; accepted: number; responseBytes: number; sequences: Set<number> }
  >();
  const payload = "s".repeat(profile.payloadBytes);
  return createServer(
    { cert: readFileSync(env[profile.certificateFileEnv]!), key: readFileSync(env[profile.privateKeyFileEnv]!) },
    (req, res) => {
      const send = (status: number, body: unknown) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(text);
        return Buffer.byteLength(text);
      };
      const url = new URL(req.url ?? "/", "https://fixture.invalid");
      if (url.pathname === BROKER_IDENTITY_PATH || url.pathname.startsWith(BROKER_METRICS_PATH)) {
        if (req.method !== "GET" || url.search) return void send(405, { error: "unsupported_request" });
        if (!equalSecret(req.headers["x-qm-perf-control"] as string | undefined, env[profile.controlTokenEnv]!))
          return void send(403, { error: "control_denied" });
        if (url.pathname === BROKER_IDENTITY_PATH)
          return void send(200, {
            fixtureId: fixture.fixtureId,
            profileSha256: fixture.profileSha256,
            responderProfileSha256: profileSha256,
            payloadBytes: profile.payloadBytes,
          });
        const runId = url.pathname.slice(BROKER_METRICS_PATH.length);
        const row = runs.get(runId);
        return void send(200, {
          runId,
          arrivals: row?.arrivals ?? 0,
          unexpected: row?.unexpected ?? 0,
          accepted: row?.accepted ?? 0,
          uniqueSequences: row?.sequences.size ?? 0,
          responseBytes: row?.responseBytes ?? 0,
        });
      }
      const runId = /^\/__qm_perf\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/.exec(url.pathname)?.[1];
      if (runId && !runs.has(runId) && runs.size >= 1000) return void send(503, { error: "fixture_run_limit" });
      const row = runId
        ? (runs.get(runId) ?? {
            arrivals: 0,
            unexpected: 0,
            accepted: 0,
            responseBytes: 0,
            sequences: new Set<number>(),
          })
        : undefined;
      if (row && runId) {
        row.arrivals++;
        runs.set(runId, row);
      }
      const reject = (status: number, error: string) => {
        if (row) {
          row.unexpected++;
          emit({ type: "credential-responder-unexpected", at: Date.now(), runId, httpStatus: status });
        }
        send(status, { error });
      };
      if (req.method !== "GET" || url.search) return reject(405, "unsupported_request");
      const match = /^\/__qm_perf\/broker\/([0-9a-f-]{36})\/(\d+)$/.exec(url.pathname);
      if (!match || !row || !runId) return reject(404, "unknown_fixture_path");
      if (!equalSecret(req.headers.authorization, `Bearer ${env[profile.syntheticSecretEnv]!}`))
        return reject(403, "synthetic_credential_required");
      const sequenceText = match[2];
      const sequence = Number(sequenceText);
      if (!Number.isSafeInteger(sequence)) return reject(400, "invalid_sequence");
      if (row.sequences.has(sequence)) return reject(409, "duplicate_sequence");
      const bytes = send(200, {
        fixtureId: fixture.fixtureId,
        profileSha256: fixture.profileSha256,
        runId,
        sequence,
        payload,
      });
      row.accepted++;
      row.responseBytes += bytes;
      row.sequences.add(sequence);
      emit({ type: "credential-responder-accepted", at: Date.now(), runId, sequence, bytes });
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { profile: { type: "string" }, fixture: { type: "string" } } });
  workloadCheck(values.profile && values.fixture, "--profile and --fixture are required");
  const profile = JSON.parse(readFileSync(values.profile, "utf8")) as CredentialResponderProfile;
  const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as WorkloadFixture;
  const server = credentialResponder(profile, fixture, process.env, (row) => console.log(JSON.stringify(row)));
  server.listen(profile.port, profile.bind, () =>
    console.log(
      JSON.stringify({ type: "credential-responder-ready", fixtureId: fixture.fixtureId, port: profile.port }),
    ),
  );
}
