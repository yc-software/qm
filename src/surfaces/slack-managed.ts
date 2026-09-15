import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App as BoltApp, Receiver } from "@slack/bolt";
import type { SlackInstallationStore } from "./slack-installation.ts";
import type { EnvelopeStaging } from "../slack/envelope-staging.ts";
import {
  createDeferredEnvelopeAck,
  describeEnvelope,
  envelopeStageFor,
  isGatedEnvelope,
} from "../slack/deferred-ack.ts";
import { sendJson } from "../api/http.ts";

export function createManagedSlack(opts: {
  serviceUrl: string;
  token: string;
  appId: string;
  store: SlackInstallationStore;
  fetchImpl?: typeof fetch;
  reconcile?: () => Promise<void>;
}) {
  const serviceUrl = new URL(opts.serviceUrl);
  if (serviceUrl.protocol !== "https:" || serviceUrl.username || serviceUrl.password || !opts.token || !opts.appId) {
    throw new Error("Managed Slack requires an HTTPS service URL, credential, and app ID");
  }
  let active: { app: BoltApp; installId: string; staging?: EnvelopeStaging } | undefined;
  const authenticated = (req: IncomingMessage): boolean => {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${opts.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  return {
    async start(): Promise<{ url: string }> {
      const response = await (opts.fetchImpl ?? fetch)(new URL("/install/start", serviceUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Slack installation service is unavailable");
      const data = (await response.json()) as { url?: unknown };
      if (typeof data.url !== "string" || new URL(data.url).origin !== serviceUrl.origin) {
        throw new Error("Slack installation service returned an invalid URL");
      }
      return { url: data.url };
    },
    receiver(installId: string, staging?: EnvelopeStaging): Receiver {
      let instance: typeof active;
      return {
        init(app) {
          instance = { app, installId, staging };
        },
        async start() {
          active = instance;
        },
        async stop() {
          if (active === instance) active = undefined;
        },
      } as Receiver;
    },
    async handle(req: IncomingMessage, res: ServerResponse, value: unknown): Promise<void> {
      if (!authenticated(req)) return sendJson(res, 401, { error: "unauthorized" });
      if (!value || typeof value !== "object" || Array.isArray(value))
        return sendJson(res, 400, { error: "invalid_body" });
      const input = value as Record<string, unknown>;
      if (typeof input.installId !== "string" || !input.installId || input.installId.length > 200) {
        return sendJson(res, 400, { error: "invalid_installation" });
      }
      const stored = await opts.store.get();
      if ((req.url ?? "").split("?")[0] === "/v1/slack/managed/installation") {
        if (req.method === "DELETE") {
          await opts.store.disableManaged(input.installId);
          void opts.reconcile?.().catch(() => undefined);
          return sendJson(res, 200, { ok: true });
        }
        if (
          typeof input.installedAt !== "number" ||
          !Number.isSafeInteger(input.installedAt) ||
          input.installedAt <= 0 ||
          input.appId !== opts.appId ||
          typeof input.teamId !== "string" ||
          !/^T[A-Z0-9]+$/.test(input.teamId) ||
          typeof input.botToken !== "string" ||
          !input.botToken.startsWith("xoxb-") ||
          (input.teamName !== undefined && typeof input.teamName !== "string")
        ) {
          return sendJson(res, 400, { error: "invalid_installation" });
        }
        const accepted = await opts.store.setManaged({
          botToken: input.botToken,
          appId: opts.appId,
          installId: input.installId,
          installedAt: input.installedAt,
          teamId: input.teamId,
          ...(typeof input.teamName === "string" ? { teamName: input.teamName } : {}),
        });
        if (!accepted) return sendJson(res, 409, { error: "installation_conflict" });
        void opts.reconcile?.().catch(() => undefined);
        const ready = active?.installId === input.installId;
        return sendJson(res, ready ? 200 : 202, { ok: true, ready });
      }
      if (!stored || stored.installId !== input.installId || stored.appId !== opts.appId) {
        return sendJson(res, 409, { error: "installation_mismatch" });
      }
      const body = input.body as Record<string, unknown> | undefined;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        body.api_app_id !== opts.appId ||
        (body.team_id ?? (body.team as { id?: unknown } | undefined)?.id) !== stored.teamId
      ) {
        return sendJson(res, 400, { error: "workspace_mismatch" });
      }
      const runtime = active;
      if (!runtime || runtime.installId !== input.installId) return sendJson(res, 503, { error: "slack_not_ready" });
      await new Promise<void>((resolve) => {
        const respond = (status: number, payload: unknown) => {
          sendJson(res, status, payload);
          resolve();
        };
        const { ack, gate } = createDeferredEnvelopeAck(async (payload) => respond(200, payload ?? {}), {
          gated: isGatedEnvelope(body),
          label: describeEnvelope(body),
          onWithhold: () => respond(503, { error: "not_persisted" }),
          ...envelopeStageFor(runtime.staging, body),
        });
        void runtime.app
          .processEvent({
            body,
            ack,
            ...(typeof input.retryNum === "number" ? { retryNum: input.retryNum } : {}),
            ...(typeof input.retryReason === "string" ? { retryReason: input.retryReason } : {}),
            customProperties: { ackGate: gate },
          })
          .then(
            () => gate.persisted(),
            () => gate.failed("delivery failed"),
          );
      });
    },
  };
}

export type ManagedSlack = ReturnType<typeof createManagedSlack>;
