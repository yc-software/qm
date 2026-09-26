import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { SCRIPT_RUNNER } from "../../src/sandbox/sprites-sandbox.ts";
import { workloadCheck } from "./workload-provider.ts";
import type { WorkloadFixture } from "./workload.ts";

export interface SpritesFixtureProfile {
  schemaVersion: 1;
  fixtureId: string;
  campaignId: string;
  host: string;
  port: number;
  tokenEnv: string;
  namePrefix: string;
  image: string;
  maxSprites: number;
  maxExecs: number;
  maxBytes: number;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  chunkBytes: number;
  delays: { controlMs: number; filesMs: number; execMs: number; chunkMs: number };
  scripts: Array<{ name: string; sha256: string }>;
}

const uuid = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function spritesScriptSha256(script: string): string {
  return sha256(
    script
      .replace(uuid, "00000000-0000-0000-0000-000000000000")
      .replace(
        /export (AGENT_API_TOKEN|AGENT_CREDENTIAL_TOKEN|AGENT_OAUTH_CONSENT_TOKEN)=('\\''|')[A-Za-z0-9_.-]+\2/g,
        "export $1='<ephemeral-token>'",
      )
      .replace(
        /export QM_PERF_MATERIALIZATION_TOKEN=('\\''|')qm-perf-synthetic-[a-f0-9]{64}\1/g,
        "export QM_PERF_MATERIALIZATION_TOKEN='<synthetic-secret>'",
      )
      .replace(/\.agent-turn\/[a-f0-9]{24}\/[a-z0-9]{8,10}-[a-f0-9]{24}(?=['/\s]|$)/g, ".agent-turn/<session>/<turn>")
      .replace(/\.agent-turn\/[a-f0-9]{24}(?=['/\s]|$)/g, ".agent-turn/<session>")
      .replace(/\.extract-[a-f0-9]{32}\.tar/g, ".extract-<nonce>.tar"),
  );
}

export function spritesFixturePath(value: unknown): string {
  workloadCheck(typeof value === "string" && value.length <= 512, "Invalid guest path");
  workloadCheck(
    value.startsWith("/home/sprite/") &&
      posix.normalize(value) === value &&
      !value.includes("\0") &&
      !value.includes("\\"),
    "Guest path must stay inside the fixture home",
  );
  return value;
}

function validate(profile: SpritesFixtureProfile, fixture: WorkloadFixture, env: NodeJS.ProcessEnv): string {
  workloadCheck(profile.schemaVersion === 1 && fixture.schemaVersion === 1, "Unsupported Sprites fixture schema");
  workloadCheck(
    profile.fixtureId === fixture.fixtureId && /^qm_perf_\w+$/.test(fixture.databaseName),
    "Sprites fixture identity mismatch",
  );
  workloadCheck(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profile.campaignId),
    "Fresh campaign UUID required",
  );
  workloadCheck(/^qm-perf-[a-z0-9-]{8,40}$/.test(profile.namePrefix), "Synthetic sprite namespace required");
  workloadCheck(/^sha256:[a-f0-9]{64}$/.test(profile.image), "Immutable existing guest image ID required");
  workloadCheck(
    ["127.0.0.1", "::1", "localhost"].includes(profile.host) || env.QM_PERFORMANCE_BIND_HOST === profile.host,
    "Remote bind requires exact explicit host",
  );
  workloadCheck(Number.isSafeInteger(profile.port) && profile.port >= 0 && profile.port <= 65535, "Invalid port");
  const bounds = {
    maxSprites: [1, 16],
    maxExecs: [1, 16],
    maxBytes: [1024, 64 * 1024 * 1024],
    timeoutMs: [100, 120000],
    memoryMb: [128, 4096],
    chunkBytes: [1, 1024 * 1024],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = profile[key as keyof typeof bounds];
    workloadCheck(Number.isSafeInteger(value) && value >= min! && value <= max!, `Invalid ${key}`);
  }
  workloadCheck(profile.cpus >= 0.1 && profile.cpus <= 4 && Number.isFinite(profile.cpus), "Invalid guest CPU bound");
  for (const value of Object.values(profile.delays))
    workloadCheck(Number.isSafeInteger(value) && value >= 0 && value <= 10000, "Invalid injected delay");
  workloadCheck(
    profile.scripts.length > 0 &&
      new Set(profile.scripts.map((script) => script.sha256)).size === profile.scripts.length,
    "Distinct reviewed script hashes required",
  );
  for (const script of profile.scripts)
    workloadCheck(
      /^[a-zA-Z0-9_-]+$/.test(script.name) && /^[a-f0-9]{64}$/.test(script.sha256),
      "Invalid script admission",
    );
  const token = env[profile.tokenEnv];
  workloadCheck(
    typeof token === "string" && token.startsWith("qm-perf-") && token.length >= 32,
    "Explicitly synthetic Sprites token required",
  );
  return token;
}

interface Guest {
  name: string;
  container: string;
  id: string;
  requested: boolean;
  policy: unknown;
  resources: unknown;
  checkpoints: Array<{ id: string; create_time: string; comment: string }>;
}

export async function createSpritesFixture(
  profile: SpritesFixtureProfile,
  fixture: WorkloadFixture,
  record: (event: Record<string, unknown>) => void,
  env = process.env,
) {
  const token = validate(profile, fixture, env);
  const guests = new Map<string, Guest>();
  const pending = new Set<Promise<unknown>>();
  const sockets = new Set<WebSocket>();
  let execs = 0,
    stopped = false;
  let receiptError: unknown;
  const totals = { requests: 0, rejected: 0, execs: 0, peakExecs: 0, created: 0, deleted: 0 };
  const sourceProfileSha256 = sha256(JSON.stringify(profile));
  const emit = (event: Record<string, unknown>) => {
    try {
      record({
        at: Date.now(),
        fixtureId: fixture.fixtureId,
        campaignId: profile.campaignId,
        qualified: false,
        ...event,
      });
    } catch (error) {
      receiptError ??= error;
      stopped = true;
    }
  };
  const tracked = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  async function docker(args: string[], input?: Buffer, limit = profile.maxBytes) {
    return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const child = spawn("docker", args, { timeout: profile.timeoutMs, killSignal: "SIGKILL" });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let size = 0,
        exceeded = false;
      for (const [stream, chunks] of [
        [child.stdout, stdout],
        [child.stderr, stderr],
      ] as const)
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            exceeded = true;
            child.kill("SIGKILL");
          } else chunks.push(chunk);
        });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (exceeded || signal) reject(new Error("Bounded guest operation interrupted"));
        else resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  async function inspect(guest: Guest) {
    const result = await docker(["inspect", guest.container]);
    workloadCheck(result.code === 0, "Owned guest missing");
    const value = JSON.parse(result.stdout.toString())[0];
    workloadCheck(
      guest.requested &&
        (!guest.id || value.Id === guest.id) &&
        value.Config.Labels["qm.performance.campaign"] === profile.campaignId &&
        value.Config.Labels["qm.performance.fixture"] === fixture.fixtureId,
      "Guest ownership mismatch",
    );
    workloadCheck(
      value.Image === profile.image && value.HostConfig.NetworkMode === "none" && value.Mounts.length === 0,
      "Guest isolation mismatch",
    );
    guest.id = value.Id;
    return value;
  }
  async function remove(guest: Guest) {
    if (!guest.requested) {
      guests.delete(guest.name);
      return;
    }
    await inspect(guest);
    const result = await docker(["rm", "-f", guest.container]);
    workloadCheck(result.code === 0, "Owned guest removal failed");
    workloadCheck((await docker(["inspect", guest.container])).code !== 0, "Owned guest still exists");
    guests.delete(guest.name);
    totals.deleted++;
    emit({ type: "guest-removed", name: guest.name, containerId: guest.id });
  }
  const image = await docker(["image", "inspect", profile.image]);
  workloadCheck(
    image.code === 0 && JSON.parse(image.stdout.toString())[0]?.Id === profile.image,
    "Pinned guest image unavailable",
  );
  const authorized = (request: IncomingMessage) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  function query(url: URL, allowed: string[], repeated: string[] = []) {
    for (const key of url.searchParams.keys())
      workloadCheck(
        allowed.includes(key) && (repeated.includes(key) || url.searchParams.getAll(key).length === 1),
        "Unexpected query parameter",
      );
  }
  function name(value: string) {
    workloadCheck(
      value.startsWith(`${profile.namePrefix}-`) && /^[a-z0-9-]+$/.test(value) && value.length <= 128,
      "Sprite outside campaign namespace",
    );
    return value;
  }
  async function body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      workloadCheck(size <= profile.maxBytes, "Request body limit exceeded");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function guestCommand(guest: Guest, args: string[], input?: Buffer) {
    await inspect(guest);
    return docker(["exec", "-i", guest.container, ...args], input);
  }
  const server = createServer((request, response) => {
    void tracked(
      (async () => {
        const start = performance.now();
        let inputBytes = 0,
          outputBytes = 0,
          status = 500,
          operation = "unknown";
        const respond = (code: number, bytes: Buffer, contentType: string) =>
          new Promise<void>((resolve) => {
            if (response.destroyed) {
              resolve();
              return;
            }
            response.once("finish", resolve);
            response.once("close", resolve);
            response.once("error", resolve);
            response.writeHead(code, { "content-type": contentType, "content-length": bytes.length });
            outputBytes = bytes.length;
            response.end(bytes);
          });
        try {
          totals.requests++;
          workloadCheck(!stopped && authorized(request), "Unauthorized fixture request");
          workloadCheck(request.url?.startsWith("/") && !request.url.startsWith("//"), "Invalid request target");
          const url = new URL(request.url!, "http://fixture.invalid");
          const method = request.method;
          const raw = await body(request);
          inputBytes = raw.length;
          let result: unknown,
            bytes: Buffer | undefined,
            contentType = "application/json";
          if (url.pathname === "/__qm_performance" && method === "GET") {
            query(url, []);
            workloadCheck(raw.length === 0, "Unexpected identity body");
            operation = "identity";
            result = {
              fixtureId: fixture.fixtureId,
              populationSha256: fixture.profileSha256,
              campaignId: profile.campaignId,
              profileSha256: sourceProfileSha256,
              image: profile.image,
              qualified: false,
              totals,
              guests: [...guests.values()].map((guest) => ({ name: guest.name, containerId: guest.id })),
            };
          } else if (url.pathname === "/v1/sprites" && method === "POST") {
            query(url, []);
            operation = "create";
            const input = JSON.parse(raw.toString());
            workloadCheck(
              input &&
                typeof input === "object" &&
                Object.keys(input).every((key) => ["name", "wait_for_capacity"].includes(key)),
              "Unsupported sprite create fields",
            );
            const spriteName = name(input.name);
            workloadCheck(
              !guests.has(spriteName) && guests.size < profile.maxSprites,
              "Sprite limit or duplicate create",
            );
            const container = `qm-perf-sprite-${profile.campaignId}-${sha256(spriteName).slice(0, 8)}`;
            const guest: Guest = {
              name: spriteName,
              container,
              id: "",
              requested: false,
              policy: { rules: [] },
              resources: {},
              checkpoints: [],
            };
            guests.set(spriteName, guest);
            workloadCheck((await docker(["inspect", container])).code !== 0, "Refusing an existing container");
            guest.requested = true;
            emit({ type: "guest-create-intent", name: spriteName, container });
            const created = await docker([
              "run",
              "-d",
              "--name",
              container,
              "--label",
              `qm.performance.campaign=${profile.campaignId}`,
              "--label",
              `qm.performance.fixture=${fixture.fixtureId}`,
              "--network",
              "none",
              "--memory",
              `${profile.memoryMb}m`,
              "--cpus",
              String(profile.cpus),
              "--pids-limit",
              "128",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--env",
              "HOME=/home/sprite",
              "--workdir",
              "/home/sprite",
              "--entrypoint",
              "sh",
              profile.image,
              "-c",
              "mkdir -p /home/sprite/workspace; exec sleep infinity",
            ]);
            workloadCheck(created.code === 0, "Owned guest create failed");
            guest.id = created.stdout.toString().trim();
            const checked = await inspect(guest);
            workloadCheck(checked.State.Running, "Guest did not start");
            totals.created++;
            emit({
              type: "guest-created",
              name: spriteName,
              containerId: guest.id,
              image: checked.Image,
              network: checked.HostConfig.NetworkMode,
              mounts: checked.Mounts.length,
            });
            result = { name: spriteName, status: "running" };
          } else {
            const route = /^\/v1\/sprites\/([a-z0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
            workloadCheck(route, "Unsupported route");
            const spriteName = name(route[1]!);
            const sub = route[2] ?? "";
            const guest = guests.get(spriteName);
            operation = sub || method?.toLowerCase() || "unknown";
            if (!guest) {
              status = 404;
              result = { error: "not_found", code: "ENOENT" };
            } else if (!guest.id) {
              status = 503;
              result = { error: "creation_not_completed" };
            } else if (!sub && method === "GET") {
              query(url, []);
              result = { name: spriteName, status: "warm" };
            } else if (!sub && method === "DELETE") {
              query(url, []);
              await remove(guest);
              status = 204;
            } else if (["policy/network", "policy/resources"].includes(sub) && ["GET", "POST"].includes(method ?? "")) {
              query(url, []);
              const key = sub === "policy/network" ? "policy" : "resources";
              if (method === "POST") {
                guest[key] = JSON.parse(raw.toString());
                status = 204;
              } else result = guest[key];
            } else if (sub === "fs/write" && method === "PUT") {
              query(url, ["path", "workingDir", "mkdirParents", "mode"]);
              workloadCheck(
                url.searchParams.get("workingDir") === "/" &&
                  url.searchParams.get("mkdirParents") === "true" &&
                  [null, "0644", "0600"].includes(url.searchParams.get("mode")),
                "Unsupported file write options",
              );
              const path = spritesFixturePath(url.searchParams.get("path"));
              const prep = await guestCommand(guest, ["mkdir", "-p", posix.dirname(path)]);
              workloadCheck(prep.code === 0, "Guest file directory failed");
              const mode = url.searchParams.get("mode");
              const script = mode ? 'umask 077; touch -- "$1" && chmod "$2" "$1" && cat > "$1"' : 'cat > "$1"';
              const written = await guestCommand(
                guest,
                ["sh", "-c", script, "fixture-write", path, ...(mode ? [mode] : [])],
                raw,
              );
              workloadCheck(written.code === 0, "Guest file write failed");
              result = { path, size: raw.length };
            } else if (sub === "fs/read" && method === "GET") {
              query(url, ["path", "workingDir"]);
              workloadCheck(url.searchParams.get("workingDir") === "/", "Unsupported working directory");
              const path = spritesFixturePath(url.searchParams.get("path"));
              const read = await guestCommand(guest, ["cat", "--", path]);
              if (read.code !== 0) {
                status = 404;
                result = { code: "ENOENT" };
              } else {
                bytes = read.stdout;
                contentType = "application/octet-stream";
              }
            } else if (sub === "fs/rename" && method === "POST") {
              query(url, []);
              const input = JSON.parse(raw.toString());
              workloadCheck(
                input &&
                  typeof input === "object" &&
                  Object.keys(input).every((key) => ["source", "dest", "workingDir"].includes(key)) &&
                  input.workingDir === "/",
                "Unsupported rename body",
              );
              const source = spritesFixturePath(input.source),
                dest = spritesFixturePath(input.dest);
              const moved = await guestCommand(guest, ["mv", "--", source, dest]);
              workloadCheck(moved.code === 0, "Guest rename failed");
              result = { source, dest };
            } else if (sub === "checkpoint" && method === "POST") {
              query(url, []);
              workloadCheck(JSON.parse(raw.toString()).comment === "qm turn end", "Unsupported checkpoint request");
              const checkpoint = {
                id: `fixture-${guest.checkpoints.length + 1}`,
                create_time: new Date().toISOString(),
                comment: "protocol receipt only; no restore proof",
              };
              guest.checkpoints.push(checkpoint);
              contentType = "application/x-ndjson";
              bytes = Buffer.from(`${JSON.stringify({ type: "complete", data: checkpoint.id })}\n`);
            } else if (sub === "checkpoints" && method === "GET") {
              query(url, []);
              result = guest.checkpoints;
            } else throw new Error("Unsupported fixture operation");
          }
          await sleep(operation.startsWith("fs/") ? profile.delays.filesMs : profile.delays.controlMs);
          if (status === 500) status = 200;
          bytes ??= status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(result));
          await respond(status, bytes, contentType);
        } catch {
          totals.rejected++;
          status = 403;
          const bytes = Buffer.from('{"error":"fixture_request_rejected"}');
          if (!response.headersSent) await respond(status, bytes, "application/json");
        } finally {
          emit({
            type: "http",
            operation,
            status,
            inputBytes,
            outputBytes,
            completed: response.writableFinished,
            elapsedMs: performance.now() - start,
          });
        }
      })(),
    );
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: profile.maxBytes, perMessageDeflate: false });
  server.requestTimeout = profile.timeoutMs;
  server.headersTimeout = profile.timeoutMs;
  server.maxConnections = Math.max(16, profile.maxExecs * 4);
  server.on("upgrade", (request, socket, head) => {
    try {
      workloadCheck(!stopped && authorized(request), "Unauthorized fixture websocket");
      const url = new URL(request.url!, "http://fixture.invalid");
      query(url, ["cmd", "path", "stdin"], ["cmd"]);
      workloadCheck(
        JSON.stringify(url.searchParams.getAll("cmd")) === JSON.stringify(["sh", "-c", SCRIPT_RUNNER]) &&
          url.searchParams.get("path") === "sh" &&
          url.searchParams.get("stdin") === "true",
        "Unexpected exec command",
      );
      const match = /^\/v1\/sprites\/([a-z0-9-]+)\/exec$/.exec(url.pathname);
      const guest = match && guests.get(name(match[1]!));
      workloadCheck(guest?.id, "Unknown fixture guest");
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.add(ws);
        const deadline = setTimeout(() => ws.terminate(), profile.timeoutMs);
        const chunks: Buffer[] = [];
        let size = 0,
          ended = false;
        ws.once("close", () => {
          clearTimeout(deadline);
          sockets.delete(ws);
          if (!ended) emit({ type: "exec-input-incomplete", name: guest.name, inputBytes: size });
        });
        ws.on("error", () => {});
        ws.on("message", (raw, binary) => {
          if (stopped) {
            ws.terminate();
            return;
          }
          const frame = Buffer.from(raw as Buffer);
          if (!binary || ended || ![0, 4].includes(frame[0]!) || (frame[0] === 4 && frame.length !== 1)) {
            totals.rejected++;
            ws.close(1008, "Invalid fixture frame");
            return;
          }
          if (frame[0] === 0) {
            size += frame.length - 1;
            if (size > profile.maxBytes) {
              totals.rejected++;
              emit({ type: "exec-frame-rejected", name: guest.name, inputBytes: size });
              ws.close(1009, "Fixture limit");
            } else chunks.push(frame.subarray(1));
            return;
          }
          ended = true;
          void tracked(
            (async () => {
              const start = performance.now();
              let outputBytes = 0,
                pass = false,
                counted = false;
              const input = Buffer.concat(chunks),
                digest = spritesScriptSha256(input.toString());
              const shape = profile.scripts.find((script) => script.sha256 === digest);
              try {
                workloadCheck(
                  shape && execs < profile.maxExecs && ws.readyState === 1,
                  "Unreviewed or excess fixture command",
                );
                execs++;
                counted = true;
                totals.execs++;
                totals.peakExecs = Math.max(totals.peakExecs, execs);
                await sleep(profile.delays.execMs);
                workloadCheck(ws.readyState === 1, "Exec client disconnected");
                const result = await guestCommand(guest, ["sh", "-c", SCRIPT_RUNNER], input);
                for (const [id, data] of [
                  [1, result.stdout],
                  [2, result.stderr],
                ] as const)
                  for (let offset = 0; offset < data.length; offset += profile.chunkBytes) {
                    workloadCheck(ws.readyState === 1, "Exec client disconnected");
                    const frame = Buffer.concat([
                      Buffer.from([id]),
                      data.subarray(offset, offset + profile.chunkBytes),
                    ]);
                    await new Promise<void>((resolve, reject) =>
                      ws.send(frame, (error) => (error ? reject(error) : resolve())),
                    );
                    outputBytes += frame.length;
                    if (profile.delays.chunkMs) await sleep(profile.delays.chunkMs);
                  }
                workloadCheck(ws.readyState === 1 && result.code >= 0 && result.code <= 255, "Invalid guest exit");
                await new Promise<void>((resolve, reject) =>
                  ws.send(Buffer.from([3, result.code]), (error) => (error ? reject(error) : resolve())),
                );
                outputBytes += 2;
                pass = true;
                ws.close();
              } catch {
                totals.rejected++;
                emit({ type: "exec-input-limit", name: guest.name, inputBytes: size });
                ws.close(1011, "Fixture exec rejected");
                if (counted && guests.get(guest.name) === guest) await remove(guest);
              } finally {
                if (counted) execs--;
                emit({
                  type: "exec",
                  name: guest.name,
                  scriptSha256: digest,
                  shape: shape?.name ?? null,
                  inputBytes: input.length,
                  outputBytes,
                  pass,
                  elapsedMs: performance.now() - start,
                  injectedDelayMs: profile.delays.execMs,
                });
              }
            })(),
          );
        });
      });
    } catch {
      totals.rejected++;
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      emit({ type: "upgrade-rejected" });
    }
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopped = true;
      await Promise.all(
        [...sockets].map(
          (ws) =>
            new Promise<void>((resolve) => {
              ws.once("close", resolve);
              ws.terminate();
            }),
        ),
      );
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      const settled = await Promise.allSettled([...pending]);
      const cleanupErrors: unknown[] = [];
      for (const guest of guests.values()) {
        try {
          await remove(guest);
        } catch (error) {
          emit({ type: "cleanup-unresolved", name: guest.name, container: guest.container });
          cleanupErrors.push(error);
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (cleanupErrors.length || receiptError)
        throw new AggregateError(
          [...cleanupErrors, ...(receiptError ? [receiptError] : [])],
          "Fixture cleanup or receipt failure",
        );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      emit({ type: "closed", totals, remainingGuests: guests.size });
      if (receiptError) throw new Error("Fixture receipt failure", { cause: receiptError });
    })());
  return { server, close, totals, profileSha256: sourceProfileSha256 };
}

async function main() {
  const { values } = parseArgs({
    options: { profile: { type: "string" }, fixture: { type: "string" }, out: { type: "string" } },
  });
  workloadCheck(values.profile && values.fixture && values.out, "--profile, --fixture and --out required");
  const profile = JSON.parse(readFileSync(values.profile, "utf8")) as SpritesFixtureProfile;
  const fixture = JSON.parse(readFileSync(values.fixture, "utf8")) as WorkloadFixture;
  const fd = openSync(values.out, "wx", 0o600);
  const responder = await createSpritesFixture(profile, fixture, (event) =>
    writeSync(fd, `${JSON.stringify(event)}\n`),
  );
  responder.server.listen(profile.port, profile.host);
  await once(responder.server, "listening");
  console.log(
    JSON.stringify({ listening: responder.server.address(), profileSha256: responder.profileSha256, qualified: false }),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void responder.close().then(
      () => closeSync(fd),
      () => {
        closeSync(fd);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main();
