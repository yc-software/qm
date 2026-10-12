import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import {
  createSdkManagedAgentsClient,
  managedAgentsEgressAllow,
  managedAgentsManifest,
  managedAgentsSessionState,
  ManagedAgentsSandboxGoneError,
  ManagedAgentsCommandLostError,
  type ManagedAgentsClient,
  type ManagedAgentsSession,
} from "../src/sandbox/managed-agents-client.ts";
import { tunnelUrl, openManagedAgentsTunnel, SANDBOX_AGENT_PORT } from "../src/sandbox/managed-agents-tunnel.ts";
import { startFakeManagedAgentsService, type FakeManagedAgentsService } from "./support/fake-managed-agents-service.ts";

let service: FakeManagedAgentsService;
let client: ManagedAgentsClient;
const opened: ManagedAgentsSession[] = [];

const session = async (name: string): Promise<ManagedAgentsSession> => {
  const created = await client.create({ name });
  opened.push(created);
  return created;
};

before(async () => {
  service = await startFakeManagedAgentsService();
  client = createSdkManagedAgentsClient({
    apiToken: service.token,
    apiBaseUrl: service.apiBaseUrl,
    template: "base",
  });
});

after(async () => {
  await Promise.all(opened.map((s) => s.kill().catch(() => undefined)));
  await service?.close();
});

test("the port-forward url targets sandbox-agent over wss", () => {
  assert.equal(
    tunnelUrl("https://api.digitalocean.com", "sess-1", SANDBOX_AGENT_PORT),
    "wss://api.digitalocean.com/v2/agents/sessions/sess-1/port-forward/8443",
  );
  assert.equal(
    tunnelUrl("http://127.0.0.1:9000/edge", "sess-2", SANDBOX_AGENT_PORT),
    "ws://127.0.0.1:9000/edge/v2/agents/sessions/sess-2/port-forward/8443",
  );
  assert.throws(() => tunnelUrl("ftp://example.com", "s", 8443), /must be http/);
});

test("the manifest asks for a bare sandbox and pre-allows bash so Managed Agents never gates a command", () => {
  const yaml = managedAgentsManifest({ name: "qm-personal-tester", template: "base" });
  assert.match(yaml, /^name: "qm-personal-tester"$/m);
  assert.match(yaml, /^agent: "none"$/m);
  assert.match(yaml, /^template: "base"$/m);
  assert.match(yaml, /tool: bash/);
  assert.match(yaml, /action: allow/);
  assert.doesNotMatch(yaml, /persistent_workspace/, "Managed Agents deprecated the key and warns when it is sent");
});

test("the manifest omits the template so Managed Agents lands a bare session on its own base", () => {
  const yaml = managedAgentsManifest({ name: "n", template: "" });
  assert.match(yaml, /^agent: "none"$/m);
  assert.doesNotMatch(yaml, /^template:/m);
});

test("the manifest carries size, idle timeout and the egress allowlist only when configured", () => {
  const bare = managedAgentsManifest({ name: "n", template: "base" });
  assert.doesNotMatch(bare, /size:|idle_timeout:|egress:/);
  const full = managedAgentsManifest({
    name: "n",
    template: "base",
    sizeSlug: "mv-2vcpu-4gb",
    idleTimeoutSec: 600,
    egressAllow: ["proxy.example.com"],
  });
  assert.match(full, /^size: "mv-2vcpu-4gb"$/m);
  assert.match(full, /^idle_timeout: "600s"$/m);
  assert.match(full, /^ {2}- "proxy\.example\.com"$/m);
});

test("the vendored proto is the client subset and carries nothing provider-internal", () => {
  const proto = readFileSync(join(process.cwd(), "src/sandbox/managed-agents-sandbox-agent.proto"), "utf8");
  assert.match(proto, /service SandboxAgentService/);
  for (const rpc of ["Exec", "Upload", "Download"]) assert.match(proto, new RegExp(`rpc ${rpc}\\(`));
  for (const unused of ["Shell", "ImportFromURL", "ExportToURL", "Health", "StartChildProcess", "ProxyPort"])
    assert.doesNotMatch(proto, new RegExp(`rpc ${unused}\\(`), `${unused} is unused and should not be vendored`);
  for (const internal of [/do\/doge/, /dorpc/, /sandboxsvc/, /sandbox-service/, /microvm\.v1/, /MSANDBOX/, /169\.254/])
    assert.doesNotMatch(proto, internal, `${internal.source} is provider-internal`);
});

test("creating a session posts a yaml manifest and waits for ready", async () => {
  const s = await session("qm-create");
  assert.ok(s.sessionId);
  assert.equal(service.sessions().length, 1);
  assert.match(service.manifests()[0] ?? "", /template: "base"/);
  assert.equal(service.sessions()[0]?.template, "base");
});

test("a command runs in the guest over the port-forward tunnel", async () => {
  const s = await session("qm-exec");
  const result = await s.runCommand("echo hello-from-guest; echo oops >&2; exit 3");
  assert.equal(result.exitCode, 3);
  assert.match(result.stdout, /hello-from-guest/);
  assert.match(result.stderr, /oops/);
  assert.ok(service.tunnelCount() > 0, "exec must travel through the tunnel, not the REST exec endpoint");
});

test("a port-forward the edge refuses reads as gone, carrying the rejection, not as a half-run command", async () => {
  const s = await session("qm-no-tunnel");
  service.rejectPortForward("team is not entitled to port-forward");
  const err = await s.runCommand("echo never-runs").then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ManagedAgentsSandboxGoneError, `expected a retryable gone error, got ${String(err)}`);
  assert.match(err.message, /403/);
  assert.match(err.message, /not entitled to port-forward/);
  assert.doesNotMatch(err.message, /may have partially executed/);
  service.rejectPortForward(null);
});

test("a transient lifecycle failure while waiting for readiness is polled through, not surfaced", async () => {
  const created = await session("qm-transient-ready");
  service.failNextLifecycleCalls(2, 403);
  const reconnected = await client.connect(created.sessionId);
  opened.push(reconnected);
  assert.equal(reconnected.sessionId, created.sessionId);
});

test("a lifecycle failure that never clears is surfaced instead of polled to the deadline", async () => {
  const created = await session("qm-stuck-ready");
  service.failNextLifecycleCalls(50, 403);
  const err = await client.connect(created.sessionId).then(
    () => null,
    (e: unknown) => e,
  );
  service.failNextLifecycleCalls(0, 403);
  assert.ok(err instanceof Error, "expected the persistent failure to surface");
  assert.match(err.message, /403/);
  assert.doesNotMatch(err.message, /did not become ready/);
});

test("command env and working directory reach the guest", async () => {
  const s = await session("qm-env");
  const result = await s.runCommand("echo VAR=$MY_VAR", { env: { MY_VAR: "set-by-qm" } });
  assert.match(result.stdout, /VAR=set-by-qm/);
});

test("files round trip through the guest upload and download streams", async () => {
  const s = await session("qm-files");
  const body = Buffer.from("managed agents file payload");
  await s.writeFileBytes("/home/user/notes/a.txt", new Uint8Array(body));
  const read = await s.readFileBytes("/home/user/notes/a.txt");
  assert.ok(read);
  assert.equal(Buffer.from(read).toString("utf8"), "managed agents file payload");
});

test("a missing file reads as null rather than an error", async () => {
  const s = await session("qm-missing");
  assert.equal(await s.readFileBytes("/home/user/nope.txt"), null);
});

test("resuming a paused session does not wait out a fixed poll interval", async () => {
  const created = await session("qm-resume-latency");
  service.setStatus("qm-resume-latency", "SESSION_STATUS_PAUSED");
  const started = Date.now();
  const back = await client.connect(created.sessionId);
  opened.push(back);
  assert.equal(back.sessionId, created.sessionId);
  assert.ok(Date.now() - started < 1_000, `resume took ${Date.now() - started}ms`);
});

test("a session paused mid-command fails fast instead of stalling until the command timeout", async () => {
  const watchful = createSdkManagedAgentsClient({
    apiToken: service.token,
    apiBaseUrl: service.apiBaseUrl,
    stallProbeMs: 50,
  });
  const s = await watchful.create({ name: "qm-paused-midcommand" });
  opened.push(s);
  const started = Date.now();
  const running = s.runCommand("sleep 30", { timeoutMs: 120_000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  service.setStatus("qm-paused-midcommand", "SESSION_STATUS_PAUSED");
  const err = await running.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof ManagedAgentsCommandLostError, `expected a command-lost error, got ${String(err)}`);
  assert.ok(Date.now() - started < 10_000, `expected a fast failure, took ${Date.now() - started}ms`);
});

test("the tunnel heartbeats so an edge idle timeout cannot kill a long silent command", async () => {
  const created = await session("qm-heartbeat");
  const before = service.pingCount();
  const tunnel = await openManagedAgentsTunnel({
    apiBaseUrl: service.apiBaseUrl,
    sessionId: created.sessionId,
    remotePort: SANDBOX_AGENT_PORT,
    getToken: async () => service.token,
    pingIntervalMs: 20,
  });
  try {
    const probe = connect(tunnel.localPort, "127.0.0.1");
    await once(probe, "connect");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(service.pingCount() > before, `expected heartbeat pings, saw ${service.pingCount() - before}`);
    probe.destroy();
  } finally {
    await tunnel.close();
  }
});

test("a large file survives the chunked upload path", async () => {
  const s = await session("qm-large");
  const body = Buffer.alloc(900 * 1024, "x");
  await s.writeFileBytes("/home/user/big.bin", new Uint8Array(body));
  const read = await s.readFileBytes("/home/user/big.bin");
  assert.equal(read?.length, body.length);
});

test("list resolves a session by name and skips destroyed rows", async () => {
  const s = await session("qm-list");
  const found = await client.list("qm-list");
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, s.sessionId);
  await s.kill();
  assert.deepEqual(await client.list("qm-list"), []);
});

test("create checkpoint posts to the session checkpoint route and returns the ready id", async () => {
  const s = await session("qm-checkpoint");
  const captured = await s.createCheckpoint("qm teardown");
  assert.match(captured.checkpointId, /^cp_/);
  assert.equal(captured.status, "READY");
  assert.ok(captured.createdAtMs);
  const stored = service.checkpoints(s.sessionId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.checkpoint_id, captured.checkpointId);
  assert.equal(stored[0]?.label, "qm teardown");
  assert.equal(stored[0]?.status, "READY");
  await s.deleteCheckpoint(captured.checkpointId);
  assert.equal(service.checkpoints(s.sessionId).length, 0);
});

test("rollback rewinds the same session onto a new sandbox without resuming it first", async () => {
  const s = await session("qm-rollback");
  const captured = await s.createCheckpoint("qm teardown");
  const previousSandbox = s.sandboxId;
  await s.pause();
  assert.equal((await client.info(s.sessionId)).state, "paused");
  const restored = await client.rollback(s.sessionId, captured.checkpointId);
  assert.equal(restored.sessionId, s.sessionId);
  assert.notEqual(restored.sandboxId, previousSandbox);
  assert.equal(restored.state, "ready");
  assert.equal((await client.info(s.sessionId)).sandboxId, restored.sandboxId);
  assert.equal(service.checkpoints(s.sessionId).length, 1);
  await assert.rejects(() => client.rollback(s.sessionId, "missing"), /404|no such checkpoint/);
});

test("connect resumes a paused session before handing it back", async () => {
  const s = await session("qm-paused");
  await s.pause();
  assert.equal((await client.info(s.sessionId)).state, "paused");
  const again = await client.connect(s.sessionId);
  assert.equal((await client.info(again.sessionId)).state, "ready");
  const result = await again.runCommand("echo awake");
  assert.match(result.stdout, /awake/);
});

test("a destroyed session reports a terminal state, and reconnecting to it fails fast", async () => {
  const s = await session("qm-gone");
  await client.kill(s.sessionId);
  assert.equal((await client.info(s.sessionId)).state, "destroyed");
  await assert.rejects(() => client.connect(s.sessionId), ManagedAgentsSandboxGoneError);
});

test("a session the control plane has never heard of reads as gone", async () => {
  await assert.rejects(() => client.info("11111111-2222-3333-4444-555555555555"), ManagedAgentsSandboxGoneError);
});

test("a bad token is refused by the control plane", async () => {
  const wrong = createSdkManagedAgentsClient({ apiToken: "nope", apiBaseUrl: service.apiBaseUrl, template: "base" });
  await assert.rejects(() => wrong.create({ name: "qm-unauth" }), /401|bad token/);
});

test("session status wire values map onto backend states", () => {
  assert.equal(managedAgentsSessionState("SESSION_STATUS_READY"), "ready");
  assert.equal(managedAgentsSessionState("SESSION_STATUS_PAUSED"), "paused");
  assert.equal(managedAgentsSessionState("nonsense"), "unspecified");
});

test("the egress allowlist carries just the proxy host", () => {
  assert.deepEqual(managedAgentsEgressAllow("https://egress.example.com:443/path"), ["egress.example.com"]);
});
