import { SocketModeClient } from "@slack/socket-mode";
import type { Receiver, ReceiverEvent, App as BoltApp } from "@slack/bolt";
import { errMessage } from "../util/errors.ts";
import { parseLogLevel } from "./payloads.ts";
import type { EnvelopeStaging } from "./envelope-staging.ts";

const ACK_CAP_MS = 2_500;

export interface AckGate {
  persisted(): void;
  failed(reason?: string): void;
}

export interface DeferredAck {
  ack: (response?: unknown) => Promise<void>;
  gate: AckGate;
}

export interface EnvelopeStage {
  stage(): Promise<boolean>;
  accepted(): void;
}

export function createDeferredEnvelopeAck(
  sendAck: (response?: unknown) => Promise<void>,
  opts: { gated: boolean; capMs?: number; label?: string; onWithhold?: () => void; staging?: EnvelopeStage },
): DeferredAck {
  const capMs = opts.capMs ?? ACK_CAP_MS;
  const label = opts.label ?? "event";
  let done = false;
  let response: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedAt: number | undefined;
  let capFired = false;
  let stageAttempted = false;
  let handlerFailed = false;
  const finish = (send: boolean, note?: string): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (note) console.error(`[slack-plugin] ${note}`);
    if (send) {
      void sendAck(response).catch((err: unknown) =>
        console.error("%s", `[slack-plugin] envelope ack failed for ${label}:`, errMessage(err)),
      );
    } else {
      opts.onWithhold?.();
    }
  };

  const noteLate = (what: string): void => {
    if (!capFired || armedAt === undefined) return;
    const elapsed = Math.round(performance.now() - armedAt);
    console.error(
      `[slack-plugin] ${what} for ${label} landed ${elapsed}ms after receipt (${elapsed - capMs}ms past the ${capMs}ms ack cap)`,
    );
  };
  return {
    async ack(res?: unknown) {
      if (res !== undefined) response = res;
      if (!opts.gated) return finish(true);
      if (!timer && !done) {
        armedAt = performance.now();
        timer = setTimeout(() => {
          capFired = true;
          if (done) return;
          if (!opts.staging) {
            finish(true, `ack cap hit for ${label} after ${capMs}ms — acking before durable acceptance was confirmed`);
            return;
          }
          stageAttempted = true;
          void opts.staging.stage().then((ok) => {
            if (done) return;
            if (ok)
              finish(true, `ack cap hit for ${label} after ${capMs}ms — envelope staged for replay before acking`);
            else finish(false, `ack cap hit for ${label} after ${capMs}ms and staging did not land — withholding ack`);
          });
        }, capMs);
      }
    },
    gate: {
      persisted: () => {
        noteLate("durable acceptance");
        if (stageAttempted && !handlerFailed) opts.staging?.accepted();
        finish(true);
      },
      failed: (reason?: string) => {
        handlerFailed = true;
        noteLate(`handler failure (${reason ?? "handler failed"})`);
        if (done && stageAttempted)
          console.error(
            `[slack-plugin] ${label} failed after its ack; the staged envelope stays for replay: ${reason ?? "handler failed"}`,
          );
        finish(false, `withholding ack for ${label} (Slack will redeliver): ${reason ?? "handler failed"}`);
      },
    },
  };
}

export function envelopeStageFor(
  staging: EnvelopeStaging | undefined,
  body: Record<string, unknown>,
): { staging?: EnvelopeStage } {
  const key = staging?.keyFor(body);
  if (!staging || !key) return {};
  return { staging: { stage: () => staging.stage(key, body), accepted: () => staging.accepted(key) } };
}

export function isGatedEnvelope(body: Record<string, unknown>): boolean {
  const event = body.event as { type?: string } | undefined;
  return body.type === "event_callback" && (event?.type === "message" || event?.type === "app_mention");
}

export function describeEnvelope(body: Record<string, unknown>): string {
  const event = body.event as { type?: string; channel?: string; ts?: string } | undefined;
  return event
    ? `${event.type ?? "event"} ch=${event.channel ?? "?"} ts=${event.ts ?? "?"}`
    : String(body.type ?? "envelope");
}

export interface DeferredAckReceiverOptions {
  appToken: string;
  logLevel?: string;
  capMs?: number;
  slackApiUrl?: string;
  staging?: EnvelopeStaging;
}

export function createDeferredAckReceiver(opts: DeferredAckReceiverOptions): Receiver {
  const client = new SocketModeClient({
    appToken: opts.appToken,
    logLevel: parseLogLevel(opts.logLevel),
    ...(opts.slackApiUrl ? { clientOptions: { slackApiUrl: opts.slackApiUrl } } : {}),
  });
  let app: BoltApp | undefined;

  client.on(
    "slack_event",
    async (args: {
      ack: (response?: unknown) => Promise<void>;
      body: Record<string, unknown>;
      retry_num?: number;
      retry_reason?: string;
    }) => {
      const { ack, gate } = createDeferredEnvelopeAck(args.ack, {
        gated: isGatedEnvelope(args.body),
        ...(opts.capMs !== undefined ? { capMs: opts.capMs } : {}),
        label: describeEnvelope(args.body),
        ...envelopeStageFor(opts.staging, args.body),
      });
      const event: ReceiverEvent = {
        body: args.body,
        ack,
        ...(args.retry_num !== undefined ? { retryNum: args.retry_num } : {}),
        ...(args.retry_reason !== undefined ? { retryReason: args.retry_reason } : {}),
        customProperties: { ackGate: gate },
      };
      try {
        await app?.processEvent(event);
        gate.persisted();
      } catch (err) {
        gate.failed(errMessage(err));
      }
    },
  );

  return {
    client,
    init(a: BoltApp) {
      app = a;
    },
    start: () => client.start() as Promise<unknown>,
    stop: () => client.disconnect() as Promise<unknown>,
  } as Receiver & { client: SocketModeClient };
}
