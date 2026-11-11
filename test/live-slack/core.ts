import { setTimeout as delay } from "node:timers/promises";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { mintCapabilityToken } from "../../src/auth/capability-token.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../src/auth/portal-identity.ts";
import type { Item } from "../../src/sessions/items.ts";

const ADMIN_PRINCIPAL = process.env.LIVE_E2E_ADMIN_PRINCIPAL || "admin-alice";

export interface AmbientPolicy {
  orders: string;
  bots?: Record<string, unknown>;
  ambientEnabled: boolean | null;
}

export interface SessionSummary {
  id: string;
  type?: string;
  turns?: number;
  [k: string]: unknown;
}

export class CoreClient {
  private readonly baseUrl: string;
  private readonly signingSecret: string;
  readonly orgScope: string;
  private readonly requestSignal?: AbortSignal;

  constructor(baseUrl: string, signingSecret: string, orgScope = "org:acme", requestSignal?: AbortSignal) {
    this.baseUrl = baseUrl;
    this.signingSecret = signingSecret;
    this.orgScope = orgScope;
    this.requestSignal = requestSignal;
  }

  withSignal(signal: AbortSignal): CoreClient {
    return new CoreClient(this.baseUrl, this.signingSecret, this.orgScope, signal);
  }

  private async request(method: string, pathWithQuery: string, body?: unknown): Promise<any> {
    const orgId = this.orgScope.split(":")[1] ?? "acme";
    const portalSecret = process.env.PORTAL_IDENTITY_SECRET || this.signingSecret;
    const identity = await mintPortalIdentity({ p: ADMIN_PRINCIPAL, exp: Date.now() + 60_000 }, portalSecret);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const salted = `${pathWithQuery}${pathWithQuery.includes("?") ? "&" : "?"}_nonce=${crypto.randomUUID()}`;
    const headers = signedRequestHeaders(this.signingSecret, method, salted, raw, {
      "content-type": "application/json",
      "x-admin-actor": `${ADMIN_PRINCIPAL}@${orgId}`,
      [PORTAL_IDENTITY_HEADER]: identity,
    });
    const deadline = AbortSignal.timeout(120_000);
    const signal = this.requestSignal ? AbortSignal.any([deadline, this.requestSignal]) : deadline;
    const res = await fetch(`${this.baseUrl}${salted}`, { method, headers, signal, ...(raw ? { body: raw } : {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw Object.assign(new Error(`core ${method} ${pathWithQuery}: ${res.status} ${JSON.stringify(data)}`), {
        status: res.status,
      });
    return data;
  }

  async waitForChannelMembership(channelId: string, slackId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = this.requestSignal ? AbortSignal.any([deadline, this.requestSignal]) : deadline;
    const core = this.withSignal(signal);
    try {
      while (true) {
        signal.throwIfAborted();
        const { matches } = await core.request("GET", `/v1/directory/resolve?q=${encodeURIComponent(slackId)}`);
        if (!Array.isArray(matches)) throw new Error("invalid directory resolution response");
        if (matches.length) {
          if (
            matches.length !== 1 ||
            typeof matches[0]?.principalId !== "string" ||
            (matches[0].slackId !== slackId && matches[0].principalId !== slackId)
          )
            throw new Error(`directory did not resolve the exact QA Slack identity ${slackId}`);
          const { member } = await core.request(
            "GET",
            `/v1/directory/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(matches[0].principalId)}`,
          );
          if (member === true) return;
          if (member !== false) throw new Error("invalid directory membership response");
        }
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted)
        throw new Error(`directory membership readiness timed out or was aborted for ${slackId} in ${channelId}`, {
          cause: error,
        });
      throw error;
    }
  }

  setAmbientPolicy(channelId: string, policy: AmbientPolicy): Promise<unknown> {
    return this.request("PUT", `/v1/admin/scopes/${encodeURIComponent(`channel:${channelId}`)}/ambient-policy`, policy);
  }

  async ambientPolicy(channelId: string): Promise<AmbientPolicy | undefined> {
    const config = (await this.request("GET", `/v1/admin/scopes/${encodeURIComponent(`channel:${channelId}`)}`)) as {
      ambientPolicy?: AmbientPolicy;
    };
    const p = config.ambientPolicy;
    return p && { orders: p.orders, bots: p.bots, ambientEnabled: p.ambientEnabled };
  }

  listSandboxes(scopeId: string): Promise<{
    providers: Array<{ name: string; actions: string[] }>;
    sandboxes: Array<{ id: string; name: string; backend: string; state: string }>;
  }> {
    return this.request("GET", `/v1/admin/sandboxes/${encodeURIComponent(scopeId)}`);
  }

  manageSandbox(scopeId: string, body: Record<string, unknown>): Promise<{ id: string; backend: string }> {
    return this.request("POST", `/v1/admin/sandboxes/${encodeURIComponent(scopeId)}`, body);
  }

  listSessions(category: "conversation" | "all" = "conversation"): Promise<{ sessions: SessionSummary[] }> {
    return this.request(
      "GET",
      `/v1/admin/sessions?scope=${encodeURIComponent(this.orgScope)}&limit=200&category=${category}`,
    );
  }

  getSession(
    id: string,
  ): Promise<{ session: { threadRef?: string; scopeId?: string; parentSessionId?: string | null }; items: Item[] }> {
    return this.request(
      "GET",
      `/v1/admin/sessions/${encodeURIComponent(id)}?scope=${encodeURIComponent(this.orgScope)}`,
    );
  }

  getSessionLlm(id: string): Promise<{ session: unknown; requests: unknown[] }> {
    return this.request(
      "GET",
      `/v1/admin/sessions/${encodeURIComponent(id)}/llm?scope=${encodeURIComponent(this.orgScope)}`,
    );
  }

  listCrons(): Promise<{
    crons: Array<{
      id: string;
      ownerScopeId: string;
      message?: string;
      action?: string;
      owner?: string;
      createdBy?: string;
    }>;
  }> {
    return this.request("GET", `/v1/admin/crons?scope=${encodeURIComponent(this.orgScope)}`);
  }

  listErrors(): Promise<{
    errors: Array<{ ts: number; category: string; code: string; message: string; sessionId?: string }>;
  }> {
    return this.request("GET", `/v1/admin/errors?scope=${encodeURIComponent(this.orgScope)}`);
  }

  resolveDirectory(q: string): Promise<{ members: Array<{ principalId: string; displayName: string }> }> {
    return this.request("GET", `/v1/admin/directory?q=${encodeURIComponent(q)}`);
  }

  async deleteCron(cron: { id: string; ownerScopeId: string; owner?: string; createdBy?: string }): Promise<void> {
    const token = await mintCapabilityToken(
      {
        actorId: cron.owner ?? cron.createdBy ?? "live-e2e-driver",
        scopeId: cron.ownerScopeId as never,
        exp: Date.now() + 10 * 60_000,
      },
      this.signingSecret,
    );
    const res = await fetch(`${this.baseUrl}/v1/crons/${encodeURIComponent(cron.id)}`, {
      method: "DELETE",
      headers: { "x-agent-capability": token },
    });
    if (!res.ok) throw new Error(`core DELETE /v1/crons/${cron.id}: ${res.status}`);
  }

  async findSessionTreeByThread(channel: string, rootTs: string): Promise<{ id: string; items: Item[] } | null> {
    const wanted = `ch:${channel}:${rootTs}`;
    const { sessions } = await this.listSessions("all");
    const loaded = new Map<string, Awaited<ReturnType<CoreClient["getSession"]>>>();
    for (const s of sessions) {
      const full = await this.getSession(s.id).catch(() => null);
      if (full) loaded.set(s.id, full);
    }
    const root = [...loaded].find(([, full]) => full.session?.threadRef === wanted)?.[0];
    if (!root) return null;
    const tree = new Set([root]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, full] of loaded) {
        const parent = full.session?.parentSessionId;
        if (tree.has(id) || !parent || !tree.has(parent)) continue;
        tree.add(id);
        grew = true;
      }
    }
    return { id: root, items: [...tree].flatMap((id) => loaded.get(id)!.items) };
  }

  async findSessionByThread(channel: string, rootTs?: string): Promise<{ id: string; items: Item[] } | null> {
    const wanted = rootTs ? `ch:${channel}:${rootTs}` : `dm:${channel}`;
    const { sessions } = await this.listSessions();
    for (const s of sessions) {
      try {
        const full = await this.getSession(s.id);
        if (full.session?.threadRef === wanted) return { id: s.id, items: full.items };
      } catch {
        void 0;
      }
    }
    return null;
  }
}
