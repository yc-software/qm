import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AsyncResource } from "node:async_hooks";
import bolt from "@slack/bolt";
import type { Receiver, ReceiverEvent, App as BoltApp } from "@slack/bolt";
import { createDeferredEnvelopeAck, describeEnvelope, envelopeStageFor, isGatedEnvelope } from "./deferred-ack.ts";
import type { EnvelopeStaging } from "./envelope-staging.ts";
import { errMessage } from "../util/errors.ts";
import { PayloadTooLargeError, readBody } from "../../plugins/chassis/src/http.ts";

const { isValidSlackRequest } = bolt;

export const SLACK_EVENTS_PATH = "/slack/events";
const MAX_BODY_BYTES = 5_000_000;

export interface HttpEventsReceiverOptions {
  signingSecret: string;
  port: number;
  host?: string;
  path?: string;
  capMs?: number;
  staging?: EnvelopeStaging;
  externalListener?: boolean;
}

export type HttpEventsReceiver = Receiver & {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
};

function respond(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  let payload = "";
  if (typeof body === "string") payload = body;
  else if (body !== undefined) payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

export function createHttpEventsReceiver(
  opts: HttpEventsReceiverOptions & { externalListener: true },
): HttpEventsReceiver;
export function createHttpEventsReceiver(
  opts: HttpEventsReceiverOptions & { externalListener?: false },
): HttpEventsReceiver & { server: Server };
export function createHttpEventsReceiver(opts: HttpEventsReceiverOptions): HttpEventsReceiver & { server?: Server } {
  const path = opts.path ?? SLACK_EVENTS_PATH;
  let app: BoltApp | undefined;
  let running = false;
  const pending = new Set<Promise<void>>();
  const handle = AsyncResource.bind((req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const work = receive(req, res);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  });
  const server = opts.externalListener
    ? undefined
    : createServer((req, res) => {
        void handle(req, res);
      });

  async function receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || url !== path) return respond(res, 404, { error: "not_found" });
    if (!running || !app) return respond(res, 503, { error: "not_ready" });
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const large = error instanceof PayloadTooLargeError;
      return respond(res, large ? 413 : 400, { error: large ? "body_too_large" : "invalid_body" });
    }
    const signature = header(req, "x-slack-signature");
    const timestamp = Number(header(req, "x-slack-request-timestamp"));
    if (
      !signature ||
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) > 5 * 60 ||
      !isValidSlackRequest({
        signingSecret: opts.signingSecret,
        body: raw,
        headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
      })
    ) {
      return respond(res, 401, { error: "invalid_signature" });
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON object");
      body = parsed as Record<string, unknown>;
    } catch {
      return respond(res, 400, { error: "invalid_json" });
    }
    if (!running) return respond(res, 503, { error: "not_ready" });
    if (body.type === "url_verification") return respond(res, 200, { challenge: body.challenge });

    const label = describeEnvelope(body);
    const { ack, gate } = createDeferredEnvelopeAck(async (response?: unknown) => respond(res, 200, response ?? {}), {
      gated: isGatedEnvelope(body),
      ...(opts.capMs !== undefined ? { capMs: opts.capMs } : {}),
      label,
      onWithhold: () => respond(res, 503, { error: "not_persisted" }),
      ...envelopeStageFor(opts.staging, body),
    });
    const retryNum = Number(header(req, "x-slack-retry-num"));
    const event: ReceiverEvent = {
      body,
      ack,
      ...(Number.isFinite(retryNum) ? { retryNum } : {}),
      ...(header(req, "x-slack-retry-reason") ? { retryReason: header(req, "x-slack-retry-reason") } : {}),
      customProperties: { ackGate: gate },
    };
    try {
      await app.processEvent(event);
      gate.persisted();
    } catch (err) {
      gate.failed(errMessage(err));
    }
  }

  return {
    ...(server ? { server } : {}),
    handle,
    init(a: BoltApp) {
      app = a;
    },
    start: async () => {
      if (!app) throw new Error("HTTP events receiver must be initialized before starting");
      if (running) return;
      if (!server) {
        running = true;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
          server.removeListener("error", reject);
          running = true;
          console.log(
            `[slack-plugin] http events receiver listening on ${opts.host ?? "127.0.0.1"}:${opts.port}${path}`,
          );
          resolve();
        });
      });
    },
    stop: async () => {
      running = false;
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      while (pending.size) await Promise.allSettled(pending);
    },
  } as HttpEventsReceiver & { server?: Server };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
