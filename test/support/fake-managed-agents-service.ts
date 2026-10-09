import { createServer as createHttpServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import * as loader from "@grpc/proto-loader";
import * as grpc from "@grpc/grpc-js";

const PROTO_PATH = fileURLToPath(new URL("../../src/sandbox/managed-agents-sandbox-agent.proto", import.meta.url));

interface SessionRow {
  session_id: string;
  sandbox_id: string;
  name: string;
  status: string;
  template: string;
  created_at: string;
}

export interface FakeManagedAgentsService {
  apiBaseUrl: string;
  token: string;
  sessions(): SessionRow[];
  manifests(): string[];
  execScripts(): string[];
  home(): string;
  checkpoints(sessionId: string): Array<{ checkpoint_id: string; label: string; status: string }>;
  setStatus(name: string, status: string): void;
  rejectPortForward(body: string | null): void;
  failNextLifecycleCalls(count: number, status: number): void;
  tunnelCount(): number;
  pingCount(): number;
  close(): Promise<void>;
}

function loadService(): grpc.ServiceDefinition {
  const definition = loader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    do: {
      teams: {
        hosted_agents: { runtime: { sandbox_agent: { v1: { SandboxAgentService: grpc.ServiceClientConstructor } } } };
      };
    };
  };
  return pkg.do.teams.hosted_agents.runtime.sandbox_agent.v1.SandboxAgentService.service;
}

export async function startFakeManagedAgentsService(): Promise<FakeManagedAgentsService> {
  const token = "dop_v1_test-token";
  const root = mkdtempSync(join(tmpdir(), "fake-managed-agents-guest-"));
  const rows = new Map<string, SessionRow>();
  const checkpoints = new Map<string, Array<{ checkpoint_id: string; label: string; status: string }>>();
  const manifests: string[] = [];
  const execScripts: string[] = [];
  let tunnels = 0;
  let pings = 0;
  let lifecycleFailures = 0;
  let lifecycleFailureStatus = 403;

  const guest = new grpc.Server();
  guest.addService(loadService(), {
    Exec: (call: grpc.ServerDuplexStream<Record<string, unknown>, unknown>) => {
      call.on("data", (frame: { start?: { argv?: string[]; workdir?: string; env?: Record<string, string> } }) => {
        if (!frame.start) return;
        const argv = frame.start.argv ?? [];
        const script = argv[argv.length - 1] ?? "";
        execScripts.push(script);
        try {
          const cwd = (frame.start.workdir || root).replace(/^\/home\/user/, root);
          mkdirSync(cwd, { recursive: true });
          const child = spawn("sh", ["-c", script.replace(/\/home\/user/g, root)], {
            cwd,
            env: { ...process.env, ...frame.start.env, HOME: root },
          });
          child.stdout.on("data", (chunk: Buffer) => call.write({ stdout: chunk }));
          child.stderr.on("data", (chunk: Buffer) => call.write({ stderr: chunk }));
          child.on("close", (code: number | null) => {
            call.write({ exit: { exit_code: code ?? -1, duration_ms: 1, hitl_rejected: false } });
            call.end();
          });
          child.on("error", (e: Error) => {
            call.write({ stderr: Buffer.from(e.message) });
            call.write({ exit: { exit_code: 127, duration_ms: 0, hitl_rejected: false } });
            call.end();
          });
        } catch (e) {
          call.write({ stderr: Buffer.from(e instanceof Error ? e.message : String(e)) });
          call.write({ exit: { exit_code: 127, duration_ms: 0, hitl_rejected: false } });
          call.end();
        }
      });
    },
    Upload: (call: grpc.ServerReadableStream<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      let path = "";
      const chunks: Buffer[] = [];
      call.on("data", (frame: { header?: { path?: string }; chunk?: Buffer }) => {
        if (frame.header?.path) path = frame.header.path;
        if (frame.chunk?.length) chunks.push(frame.chunk);
      });
      call.on("end", () => {
        const hostPath = path.replace(/^\/home\/user/, root);
        mkdirSync(dirname(hostPath), { recursive: true });
        const body = Buffer.concat(chunks);
        writeFileSync(hostPath, body);
        cb(null, { path, bytes_written: String(body.length) });
      });
    },
    Download: (call: grpc.ServerWritableStream<{ path?: string }, unknown>) => {
      const hostPath = (call.request.path ?? "").replace(/^\/home\/user/, root);
      let body: Buffer;
      try {
        body = readFileSync(hostPath);
      } catch {
        call.emit("error", {
          code: grpc.status.INTERNAL,
          details: `envd download: download status 404: {"code":404,"message":"path '${call.request.path ?? ""}' does not exist"}`,
        });
        return;
      }
      call.write({ header: { size_bytes: String(body.length), is_archive: false } });
      call.write({ chunk: body });
      call.write({ end: { sha256: "" } });
      call.end();
    },
  });

  const guestPort = await new Promise<number>((resolve, reject) => {
    guest.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) =>
      err ? reject(err) : resolve(port),
    );
  });

  const byName = (name: string): SessionRow | undefined =>
    [...rows.values()].find((r) => r.name === name && r.status !== "SESSION_STATUS_DESTROYED");

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const http: HttpServer = createHttpServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: { code: "unauthorized", message: "bad token" } });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[3] ?? "";
    const action = parts[4] ?? "";

    if (req.method === "POST" && url.pathname === "/v2/agents/sessions") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        manifests.push(body);
        const name = /^name:\s*"?([^"\n]+)"?/m.exec(body)?.[1] ?? "unnamed";
        const row: SessionRow = {
          session_id: randomUUID(),
          sandbox_id: `sbx-${rows.size + 1}`,
          name,
          status: "SESSION_STATUS_READY",
          template: /^template:\s*"?([^"\n]+)"?/m.exec(body)?.[1] ?? "",
          created_at: new Date().toISOString(),
        };
        rows.set(row.session_id, row);
        json(res, 201, { session: row });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v2/agents/sessions") {
      const name = url.searchParams.get("name");
      const all = [...rows.values()].filter((r) => !name || r.name === name);
      json(res, 200, { sessions: all, next_page_token: "" });
      return;
    }
    if (lifecycleFailures > 0) {
      lifecycleFailures -= 1;
      json(res, lifecycleFailureStatus, { error: { code: "forbidden", message: "transient" } });
      return;
    }
    if (req.method === "GET" && parts.length === 4) {
      const row = rows.get(id);
      if (!row) {
        json(res, 404, { error: { code: "not_found", message: "no such session" } });
        return;
      }
      json(res, 200, { session: row });
      return;
    }
    if (req.method === "DELETE" && parts.length === 4) {
      const row = rows.get(id);
      if (row) row.status = "SESSION_STATUS_DESTROYED";
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST" && action === "checkpoints" && parts.length === 5) {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", () => {
        const row = rows.get(id);
        if (!row || row.status === "SESSION_STATUS_DESTROYED") {
          json(res, 404, { error: { code: "not_found", message: "no such session" } });
          return;
        }
        let label = "";
        try {
          label = (JSON.parse(body) as { label?: string }).label ?? "";
        } catch {
          label = "";
        }
        const checkpoint = {
          checkpoint_id: `cp_${randomUUID().slice(0, 8)}`,
          session_id: row.session_id,
          status: "READY",
          kind: "explicit",
          label,
          created_at: new Date().toISOString(),
          size_bytes: 1,
        };
        const list = checkpoints.get(row.session_id) ?? [];
        list.unshift(checkpoint);
        checkpoints.set(row.session_id, list);
        json(res, 200, { checkpoint });
      });
      return;
    }
    if (req.method === "POST" && action === "checkpoints" && parts[6] === "rollback" && parts.length === 7) {
      const row = rows.get(id);
      const checkpointId = decodeURIComponent(parts[5] ?? "");
      const list = checkpoints.get(id) ?? [];
      if (!row || row.status === "SESSION_STATUS_DESTROYED" || !list.some((c) => c.checkpoint_id === checkpointId)) {
        json(res, 404, { error: { code: "not_found", message: "no such checkpoint" } });
        return;
      }
      row.sandbox_id = `sbx-restored-${randomUUID().slice(0, 8)}`;
      row.status = "SESSION_STATUS_READY";
      json(res, 200, { session: row });
      return;
    }
    if (req.method === "DELETE" && action === "checkpoints" && parts.length === 6) {
      const checkpointId = decodeURIComponent(parts[5] ?? "");
      const list = checkpoints.get(id) ?? [];
      checkpoints.set(
        id,
        list.filter((c) => c.checkpoint_id !== checkpointId),
      );
      json(res, 200, {});
      return;
    }
    if (req.method === "POST" && (action === "pause" || action === "resume")) {
      const row = rows.get(id);
      if (!row) {
        json(res, 404, { error: { code: "not_found", message: "no such session" } });
        return;
      }
      row.status = action === "pause" ? "SESSION_STATUS_PAUSED" : "SESSION_STATUS_READY";
      res.writeHead(204).end();
      return;
    }
    json(res, 404, { error: { code: "not_found", message: url.pathname } });
  });

  const wss = new WebSocketServer({ noServer: true });
  let portForwardRejection: string | null = null;
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/v2\/agents\/sessions\/([^/]+)\/port-forward\/(\d+)$/.exec(url.pathname);
    if (req.headers.authorization !== `Bearer ${token}` || !match) {
      socket.destroy();
      return;
    }
    if (portForwardRejection !== null) {
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Length: ${Buffer.byteLength(portForwardRejection)}\r\nConnection: close\r\n\r\n${portForwardRejection}`,
      );
      return;
    }
    const row = rows.get(match[1] ?? "");
    if (!row || row.status === "SESSION_STATUS_DESTROYED") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      tunnels += 1;
      ws.on("ping", () => {
        pings += 1;
      });
      const upstream: Socket = connect(guestPort, "127.0.0.1");
      ws.on("message", (data: Buffer) => upstream.write(data));
      upstream.on("data", (chunk: Buffer) => ws.send(chunk));
      const shutdown = (): void => {
        upstream.destroy();
        if (ws.readyState === ws.OPEN) ws.close();
      };
      ws.on("close", shutdown);
      ws.on("error", shutdown);
      upstream.on("close", shutdown);
      upstream.on("error", shutdown);
    });
  });

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("fake managed agents service failed to bind");

  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}`,
    token,
    sessions: () => [...rows.values()],
    manifests: () => [...manifests],
    execScripts: () => [...execScripts],
    home: () => root,
    checkpoints: (sessionId) => [...(checkpoints.get(sessionId) ?? [])],
    setStatus: (name, status) => {
      const row = byName(name);
      if (row) row.status = status;
    },
    rejectPortForward: (body) => {
      portForwardRejection = body;
    },
    failNextLifecycleCalls: (count, status) => {
      lifecycleFailures = count;
      lifecycleFailureStatus = status;
    },
    tunnelCount: () => tunnels,
    pingCount: () => pings,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      guest.forceShutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
