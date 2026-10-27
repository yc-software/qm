import { SocketModeClient } from "@slack/socket-mode";
import type { Receiver, App as BoltApp } from "@slack/bolt";
import { errMessage } from "../util/errors.ts";
import { tenant, withTenant } from "../tenant.ts";
import { parseLogLevel } from "./payloads.ts";
import type { EnvelopeStaging } from "./envelope-staging.ts";

export interface AckGate {
  persisted(): void;
  failed(reason?: string): void;
}

interface EnvelopeStage {
  stage(): Promise<boolean>;
  accepted(): void;
}

export function createDeferredEnvelopeAck(
  sendAck: (response?: unknown) => Promise<void>,
  opts: { gated: boolean; capMs?: number; label?: string; onWithhold?: () => void; staging?: EnvelopeStage },
): { ack: (response?: unknown) => Promise<void>; gate: AckGate } {
  const capMs = opts.capMs ?? 2_500;
  const label = opts.label ?? "event";
  const capHit = `ack cap hit for ${label} after ${capMs}ms`;
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
    if (!send) return opts.onWithhold?.();
    void sendAck(response).catch((err: unknown) =>
      console.error("%s", `[slack-plugin] envelope ack failed for ${label}:`, errMessage(err)),
    );
  };
  const noteLate = (what: string): void => {
    if (!capFired || armedAt === undefined) return;
    const elapsed = Math.round(performance.now() - armedAt);
    console.error(
      `[slack-plugin] ${what} for ${label} landed ${elapsed}ms after receipt (${elapsed - capMs}ms past the ${capMs}ms ack cap)`,
    );
  };
  const capExpired = (): void => {
    capFired = true;
    if (done) return;
    if (!opts.staging) return finish(true, `${capHit} — acking before durable acceptance was confirmed`);
    stageAttempted = true;
    void opts.staging.stage().then((ok) => {
      if (ok) finish(true, `${capHit} — envelope staged for replay before acking`);
      else finish(false, `${capHit} and staging did not land — withholding ack`);
    });
  };
  return {
    async ack(res?: unknown) {
      if (res !== undefined) response = res;
      if (!opts.gated) return finish(true);
      if (timer || done) return;
      armedAt = performance.now();
      timer = setTimeout(capExpired, capMs);
    },
    gate: {
      persisted: () => {
        noteLate("durable acceptance");
        if (stageAttempted && !handlerFailed) opts.staging?.accepted();
        finish(true);
      },
      failed: (reason = "handler failed") => {
        handlerFailed = true;
        noteLate(`handler failure (${reason})`);
        if (done && stageAttempted)
          console.error(
            `[slack-plugin] ${label} failed after its ack; the staged envelope stays for replay: ${reason}`,
          );
        finish(false, `withholding ack for ${label} (Slack will redeliver): ${reason}`);
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
  return (
    body.type === "event_callback" &&
    (event?.type === "message" || event?.type === "app_mention" || event?.type === "member_left_channel")
  );
}

export function describeEnvelope(body: Record<string, unknown>): string {
  const event = body.event as { type?: string; channel?: string; ts?: string } | undefined;
  return event
    ? `${event.type ?? "event"} ch=${event.channel ?? "?"} ts=${event.ts ?? "?"}`
    : String(body.type ?? "envelope");
}

export async function processEnvelope(
  app: BoltApp | undefined,
  body: Record<string, unknown>,
  sendAck: (response?: unknown) => Promise<void>,
  opts: {
    capMs?: number | undefined;
    staging?: EnvelopeStaging | undefined;
    onWithhold?: () => void;
    retryNum?: number | undefined;
    retryReason?: string | undefined;
  },
): Promise<void> {
  const { ack, gate } = createDeferredEnvelopeAck(sendAck, {
    gated: isGatedEnvelope(body),
    capMs: opts.capMs,
    label: describeEnvelope(body),
    onWithhold: opts.onWithhold,
    ...envelopeStageFor(opts.staging, body),
  });
  try {
    await app?.processEvent({
      body,
      ack,
      ...(opts.retryNum !== undefined ? { retryNum: opts.retryNum } : {}),
      ...(opts.retryReason !== undefined ? { retryReason: opts.retryReason } : {}),
      customProperties: { ackGate: gate },
    });
    gate.persisted();
  } catch (err) {
    gate.failed(errMessage(err));
  }
}

export function createDeferredAckReceiver(opts: {
  appToken: string;
  logLevel?: string | undefined;
  capMs?: number | undefined;
  slackApiUrl?: string | undefined;
  staging?: EnvelopeStaging | undefined;
}): Receiver {
  const client = new SocketModeClient({
    appToken: opts.appToken,
    logLevel: parseLogLevel(opts.logLevel),
    clientOptions: {
      attachOriginalToWebAPIRequestError: false,
      ...(opts.slackApiUrl ? { slackApiUrl: opts.slackApiUrl } : {}),
    },
  });
  let app: BoltApp | undefined;
  const owner = tenant();
  client.on(
    "slack_event",
    (args: {
      ack: (response?: unknown) => Promise<void>;
      body: Record<string, unknown>;
      retry_num?: number;
      retry_reason?: string;
    }) =>
      withTenant(owner, () =>
        processEnvelope(app, args.body, args.ack, {
          capMs: opts.capMs,
          staging: opts.staging,
          retryNum: args.retry_num,
          retryReason: args.retry_reason,
        }),
      ),
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
