import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { errMessage, swallowAs } from "../util/errors.ts";
import { json, readBody } from "../../plugins/chassis/src/http.ts";
import { sleep } from "./lib.ts";

const CANARY_PREFIX = "qm-canary:";

interface DevIntrospectionState {
  startedAt: number;
  connectedAs: string;
  botUserId: string;
  teamId: string;
  numConnections: number | null;
  helloHost: string | null;
  lastHelloAt: number | null;
  lastEventAt: number | null;
  lastEventAtRaw: number | null;
  lastActivityAt: number | null;
  lastCanary: { ok: boolean; rttMs?: number; reason?: string; at: number } | null;
}

export interface DevIntrospection {
  state: DevIntrospectionState;
  markEvent(): void;
  ready(info: { connectedAs: string; botUserId: string; teamId: string }): void;
  canary(channel: string, timeoutMs?: number): Promise<{ ok: boolean; rttMs?: number; reason?: string; nonce: string }>;
  port(): number | null;
  close(): Promise<void>;
}

export interface DevIntrospectionOptions {
  enabled?: boolean;
  port?: number;
  host?: string;
  now?: () => number;
}

export function installDevIntrospection(app: any, opts: DevIntrospectionOptions = {}): DevIntrospection | null {
  if (!opts.enabled) return null;
  const now = opts.now ?? Date.now;
  const state: DevIntrospectionState = {
    startedAt: now(),
    connectedAs: "",
    botUserId: "",
    teamId: "",
    numConnections: null,
    helloHost: null,
    lastHelloAt: null,
    lastEventAt: null,
    lastEventAtRaw: null,
    lastActivityAt: null,
    lastCanary: null,
  };
  const canaryWaiters = new Map<string, { postedAt: number; resolve: (rttMs: number) => void }>();

  attachRawFrameTap(app, state, canaryWaiters, now);

  const canary = async (
    channel: string,
    timeoutMs = 15_000,
  ): Promise<{ ok: boolean; rttMs?: number; reason?: string; nonce: string }> => {
    const nonce = randomUUID();
    if (!channel) return { ok: false, reason: "no canary channel configured", nonce };
    const arrival = new Promise<number>((resolve) => canaryWaiters.set(nonce, { postedAt: now(), resolve }));
    let postedTs: string | undefined;
    try {
      const posted = (await app.client.chat.postMessage({ channel, text: `${CANARY_PREFIX}${nonce}` })) as {
        ts?: string;
      };
      postedTs = posted.ts ?? "";
    } catch (err) {
      canaryWaiters.delete(nonce);
      const result = { ok: false, reason: `post failed: ${errMessage(err)}`, nonce };
      state.lastCanary = { ok: false, reason: result.reason, at: now() };
      return result;
    }
    const rttMs = await Promise.race([arrival, sleep(timeoutMs).then(() => null)]);
    canaryWaiters.delete(nonce);
    if (postedTs) {
      await app.client.chat
        .delete({ channel, ts: postedTs })
        .catch(swallowAs("dev-introspection: canary message delete", undefined));
    }
    if (rttMs === null) {
      state.lastCanary = { ok: false, reason: "posted-not-received", at: now() };
      return { ok: false, reason: "posted-not-received", nonce };
    }
    state.lastCanary = { ok: true, rttMs, at: now() };
    return { ok: true, rttMs, nonce };
  };

  const server = startServer(state, canary, opts);

  return {
    state,
    markEvent: () => {
      state.lastEventAt = now();
    },
    ready: (info) => {
      state.connectedAs = info.connectedAs;
      state.botUserId = info.botUserId;
      state.teamId = info.teamId;
    },
    canary,
    port: () => {
      const addr = server?.address();
      return addr && typeof addr === "object" ? addr.port : null;
    },
    close: async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
}

function attachRawFrameTap(
  app: any,
  state: DevIntrospectionState,
  canaryWaiters: Map<string, { postedAt: number; resolve: (rttMs: number) => void }>,
  now: () => number,
): void {
  try {
    const smc = app?.receiver?.client;
    if (!smc?.on) {
      console.warn("[slack-plugin] dev-introspection: no socket-mode client reachable — numConnections unavailable");
      return;
    }
    smc.on("ws_message", (raw: unknown) => {
      let frame: any;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame?.type === "hello") {
        state.numConnections = typeof frame.num_connections === "number" ? frame.num_connections : null;
        state.helloHost = typeof frame.debug_info?.host === "string" ? frame.debug_info.host : null;
        state.lastHelloAt = now();
        return;
      }
      state.lastEventAtRaw = now();
      const text = frame?.type === "events_api" ? frame.payload?.event?.text : undefined;
      const isCanary = typeof text === "string" && text.includes(CANARY_PREFIX);
      if (!isCanary) state.lastActivityAt = now();
      if (frame?.type !== "events_api" || !isCanary) return;
      const nonce = text.slice(text.indexOf(CANARY_PREFIX) + CANARY_PREFIX.length).trim();
      const waiter = canaryWaiters.get(nonce);
      if (!waiter) return;
      canaryWaiters.delete(nonce);
      waiter.resolve(now() - waiter.postedAt);
    });
  } catch (err) {
    console.warn(`[slack-plugin] dev-introspection: raw-frame tap failed (${errMessage(err)}) — degrading`);
  }
}

function startServer(
  state: DevIntrospectionState,
  canary: (
    channel: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; rttMs?: number; reason?: string; nonce: string }>,
  opts: DevIntrospectionOptions,
): Server | null {
  const port = opts.port ?? 0;
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void handleRequest(req, res, state, canary).catch((err) => {
      json(res, 500, { ok: false, reason: errMessage(err) });
    });
  });
  server.on("error", (err) => {
    console.warn(`[slack-plugin] dev-introspection server error: ${errMessage(err)}`);
  });
  server.listen(port, host, () => {
    const addr = server.address();
    const bound = addr && typeof addr === "object" ? addr.port : port;
    console.log(`[slack-plugin] dev-introspection on http://${host}:${bound}`);
  });
  server.unref();
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: DevIntrospectionState,
  canary: (
    channel: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; rttMs?: number; reason?: string; nonce: string }>,
): Promise<void> {
  if (req.method === "GET" && req.url === "/healthz") {
    json(res, 200, { ok: state.connectedAs !== "", pid: process.pid, ...state });
    return;
  }
  if (req.method === "POST" && req.url === "/canary") {
    const body = await readJsonBody(req);
    const result = await canary(String(body.channel ?? ""), numberOr(body.timeoutMs, 15_000));
    json(res, result.ok ? 200 : 502, result);
    return;
  }
  json(res, 404, { ok: false, reason: "not found" });
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req, 64 * 1024);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
