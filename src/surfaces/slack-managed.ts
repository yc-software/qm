import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SlackInstallationStore } from "./slack-installation.ts";
import {
  createDeferredEnvelopeAck,
  describeEnvelope,
  envelopeStageFor,
  isGatedEnvelope,
} from "../slack/deferred-ack.ts";
import { slackTeamOf, type SlackAccountRuntime } from "../slack/index.ts";
import { sendJson } from "../api/http.ts";
import { isBearerSecret } from "../auth/source-auth.ts";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import type { SlackTeamTenant } from "../slack/slack-tables.ts";
import { currentTenant, withTenant } from "../tenants/context.ts";
import { swallow, swallowAs } from "../util/errors.ts";

const INSTALL_STATE_AUD = "slack-install";
const INSTALL_STATE_TTL_MS = 60 * 60_000;
const TEAM_ID = /^T[A-Z0-9]+$/;

type ManagedRequest =
  | { kind: "install"; input: Record<string, unknown>; nonce: string; exp: number }
  | { kind: "uninstall"; input: Record<string, unknown> }
  | { kind: "event"; input: Record<string, unknown>; body: Record<string, unknown> };

type Admission = { tenant: string; request: ManagedRequest } | { status: number; error: string };

export interface ManagedSlackRuntimes {
  current(): SlackAccountRuntime[];
  accounts(): Promise<SlackAccountRuntime[]>;
  refresh(): Promise<void>;
}

export function createManagedSlack(opts: {
  serviceUrl: string;
  token: string;
  stateSecret: string;
  appId?: string;
  store: SlackInstallationStore;
  teamTenant: SlackTeamTenant;
  runtimes: ManagedSlackRuntimes;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const serviceUrl = new URL(opts.serviceUrl);
  if (serviceUrl.protocol !== "https:" || serviceUrl.username || serviceUrl.password || !isBearerSecret(opts.token)) {
    throw new Error("Managed Slack requires an HTTPS service URL and credential");
  }
  if (!opts.stateSecret) throw new Error("Managed Slack requires a signing secret for installation state");
  const now = opts.now ?? Date.now;
  const authenticated = (req: IncomingMessage): boolean => {
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${opts.token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const refresh = (): void => {
    void opts.runtimes.refresh().catch(swallowAs("slack-managed: refresh installation", undefined));
  };
  const installState = (): Promise<string> =>
    mintSignedPayload(
      { aud: INSTALL_STATE_AUD, tenantId: currentTenant(), nonce: randomUUID(), exp: now() + INSTALL_STATE_TTL_MS },
      opts.stateSecret,
    );
  const verifyState = async (state: unknown): Promise<{ tenant: string; nonce: string; exp: number } | null> => {
    if (typeof state !== "string" || !state || state.length > 4096) return null;
    const claims = (await verifySignedPayload(state, opts.stateSecret)) as Record<string, unknown> | null;
    if (!claims || claims.aud !== INSTALL_STATE_AUD || typeof claims.nonce !== "string") return null;
    if (typeof claims.exp !== "number" || claims.exp <= now() || typeof claims.tenantId !== "string") return null;
    return { tenant: claims.tenantId, nonce: claims.nonce, exp: claims.exp };
  };

  async function admitInstall(input: Record<string, unknown>): Promise<Admission> {
    if (
      typeof input.installedAt !== "number" ||
      !Number.isSafeInteger(input.installedAt) ||
      input.installedAt <= 0 ||
      typeof input.appId !== "string" ||
      !/^A[A-Z0-9]+$/.test(input.appId) ||
      (!!opts.appId && input.appId !== opts.appId) ||
      typeof input.teamId !== "string" ||
      !TEAM_ID.test(input.teamId) ||
      typeof input.botToken !== "string" ||
      !input.botToken.startsWith("xoxb-") ||
      (input.teamName !== undefined && typeof input.teamName !== "string")
    ) {
      return { status: 400, error: "invalid_installation" };
    }
    const state = await verifyState(input.state);
    if (!state) return { status: 403, error: "invalid_state" };
    const owner = await opts.teamTenant(input.teamId);
    if (owner && owner !== state.tenant) return { status: 409, error: "workspace_conflict" };
    return { tenant: state.tenant, request: { kind: "install", input, nonce: state.nonce, exp: state.exp } };
  }

  async function install(
    res: ServerResponse,
    input: Record<string, unknown>,
    nonce: string,
    exp: number,
  ): Promise<void> {
    const installId = input.installId as string;
    if (!(await opts.store.consumeInstallState(nonce, exp))) return sendJson(res, 403, { error: "invalid_state" });
    const accepted = await opts.store.setManaged({
      botToken: input.botToken as string,
      appId: input.appId as string,
      installId,
      installedAt: input.installedAt as number,
      teamId: input.teamId as string,
      ...(typeof input.teamName === "string" ? { teamName: input.teamName } : {}),
    });
    if (!accepted) return sendJson(res, 409, { error: "installation_conflict" });
    refresh();
    const ready = opts.runtimes.current().some((account) => account.installationId === installId);
    return sendJson(res, ready ? 200 : 202, { ok: true, ready });
  }

  async function admitTeam(team: unknown, request: ManagedRequest): Promise<Admission> {
    const tenant = typeof team === "string" && TEAM_ID.test(team) ? await opts.teamTenant(team) : null;
    return tenant ? { tenant, request } : { status: 403, error: "unknown_team" };
  }

  async function uninstall(res: ServerResponse, input: Record<string, unknown>): Promise<void> {
    await opts.store.disableManaged(input.installId as string);
    refresh();
    sendJson(res, 200, { ok: true });
  }

  async function deliver(res: ServerResponse, input: Record<string, unknown>, body: Record<string, unknown>) {
    const stored = await opts.store.get();
    if (!stored || stored.installId !== input.installId || (!!opts.appId && stored.appId !== opts.appId)) {
      return sendJson(res, 409, { error: "installation_mismatch" });
    }
    if (
      body.api_app_id !== stored.appId ||
      (body.team_id ?? (body.team as { id?: unknown } | undefined)?.id) !== stored.teamId
    ) {
      return sendJson(res, 400, { error: "workspace_mismatch" });
    }
    const runtime = (await opts.runtimes.accounts()).find((account) => account.installationId === input.installId);
    if (!runtime) return sendJson(res, 503, { error: "slack_not_ready" });
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
      void runtime
        .receive({
          body,
          ack,
          ...(typeof input.retryNum === "number" ? { retryNum: input.retryNum } : {}),
          ...(typeof input.retryReason === "string" ? { retryReason: input.retryReason } : {}),
          customProperties: { ackGate: gate },
        })
        .then(
          () => gate.persisted(),
          (e: unknown) => {
            swallow("slack-managed: process event", e);
            gate.failed("delivery failed");
          },
        );
    });
  }

  return {
    authenticated,
    teamTenant: opts.teamTenant,
    async setupStatus(): Promise<{ companyOwned: boolean; appReady: boolean; connected: boolean } | undefined> {
      const response = await (opts.fetchImpl ?? fetch)(new URL("/install/status", serviceUrl), {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error("Slack setup status is unavailable");
      const data = (await response.json()) as Record<string, unknown>;
      if ([data.companyOwned, data.appReady, data.connected].some((v) => typeof v !== "boolean"))
        throw new Error("Invalid Slack setup status");
      return {
        companyOwned: data.companyOwned as boolean,
        appReady: data.appReady as boolean,
        connected: data.connected as boolean,
      };
    },
    async start(step: "setup" | "install" = "install"): Promise<{ url: string }> {
      if (!(await opts.store.enableManaged()))
        throw new Error("Disconnect your own Slack app before installing the managed app");
      const response = await (opts.fetchImpl ?? fetch)(new URL("/install/start", serviceUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({ step, state: await installState() }),
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
    async admit(req: IncomingMessage, value: unknown): Promise<Admission> {
      if (!authenticated(req)) return { status: 401, error: "unauthorized" };
      if (!value || typeof value !== "object" || Array.isArray(value)) return { status: 400, error: "invalid_body" };
      const input = value as Record<string, unknown>;
      if (typeof input.installId !== "string" || !input.installId || input.installId.length > 200) {
        return { status: 400, error: "invalid_installation" };
      }
      if ((req.url ?? "").split("?")[0] !== "/v1/slack/managed/installation") {
        const body = input.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "invalid_body" };
        const event = body as Record<string, unknown>;
        return admitTeam(slackTeamOf(event), { kind: "event", input, body: event });
      }
      if (req.method !== "DELETE") return admitInstall(input);
      if (typeof input.teamId !== "string" || !TEAM_ID.test(input.teamId))
        return { status: 400, error: "invalid_installation" };
      return admitTeam(input.teamId, { kind: "uninstall", input });
    },
    async handle(res: ServerResponse, request: ManagedRequest): Promise<void> {
      if (request.kind === "event") return deliver(res, request.input, request.body);
      if (request.kind === "uninstall") return uninstall(res, request.input);
      return install(res, request.input, request.nonce, request.exp);
    },
  };
}

export type ManagedSlack = ReturnType<typeof createManagedSlack>;

export async function serveManagedSlack(
  managed: ManagedSlack,
  req: IncomingMessage,
  res: ServerResponse,
  value: unknown,
): Promise<void> {
  const admitted = await managed.admit(req, value);
  if ("error" in admitted) return sendJson(res, admitted.status, { error: admitted.error });
  await withTenant(admitted.tenant, () => managed.handle(res, admitted.request));
}
