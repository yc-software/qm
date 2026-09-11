import { signedRequestHeaders } from "../../src/auth/source-auth-sign.ts";
import { mintCapabilityToken } from "../../src/auth/capability-token.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../src/auth/portal-identity.ts";

const ADMIN_PRINCIPAL = process.env.LIVE_E2E_ADMIN_PRINCIPAL || "admin-alice";

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

  private async request(
    method: string,
    pathWithQuery: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<any> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const salted = `${pathWithQuery}${pathWithQuery.includes("?") ? "&" : "?"}_nonce=${crypto.randomUUID()}`;
    const headers = signedRequestHeaders(this.signingSecret, method, salted, raw, {
      "content-type": "application/json",
      ...extra,
    });
    const deadline = AbortSignal.timeout(120_000);
    const signal = this.requestSignal ? AbortSignal.any([deadline, this.requestSignal]) : deadline;
    const res = await fetch(`${this.baseUrl}${salted}`, { method, headers, signal, ...(raw ? { body: raw } : {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`core ${method} ${pathWithQuery}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  private async admin(method: string, pathWithQuery: string, body?: unknown): Promise<any> {
    const orgId = this.orgScope.split(":")[1] ?? "acme";
    const portalSecret = process.env.PORTAL_IDENTITY_SECRET || this.signingSecret;
    const identity = await mintPortalIdentity({ p: ADMIN_PRINCIPAL, exp: Date.now() + 60_000 }, portalSecret);
    return this.request(method, pathWithQuery, body, {
      "x-admin-actor": `${ADMIN_PRINCIPAL}@${orgId}`,
      [PORTAL_IDENTITY_HEADER]: identity,
    });
  }

  listSandboxes(scopeId: string): Promise<{
    providers: Array<{ name: string; actions: string[] }>;
    sandboxes: Array<{ id: string; name: string; backend: string; state: string }>;
  }> {
    return this.admin("GET", `/v1/admin/sandboxes/${encodeURIComponent(scopeId)}`);
  }

  manageSandbox(scopeId: string, body: Record<string, unknown>): Promise<{ id: string; backend: string }> {
    return this.admin("POST", `/v1/admin/sandboxes/${encodeURIComponent(scopeId)}`, body);
  }

  listSessions(): Promise<{ sessions: SessionSummary[] }> {
    return this.admin("GET", `/v1/admin/sessions?scope=${encodeURIComponent(this.orgScope)}&limit=200`);
  }

  getSession(id: string): Promise<{ session: { threadRef?: string; scopeId?: string }; entries: unknown[] }> {
    return this.admin("GET", `/v1/admin/sessions/${encodeURIComponent(id)}?scope=${encodeURIComponent(this.orgScope)}`);
  }

  getSessionLlm(id: string): Promise<{ session: unknown; requests: unknown[] }> {
    return this.admin(
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
    return this.admin("GET", `/v1/admin/crons?scope=${encodeURIComponent(this.orgScope)}`);
  }

  listErrors(): Promise<{
    errors: Array<{ ts: number; category: string; code: string; message: string; sessionId?: string }>;
  }> {
    return this.admin("GET", `/v1/admin/errors?scope=${encodeURIComponent(this.orgScope)}`);
  }

  resolveDirectory(q: string): Promise<{ members: Array<{ principalId: string; displayName: string }> }> {
    return this.admin("GET", `/v1/admin/directory?q=${encodeURIComponent(q)}`);
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

  async findSessionByThread(channel: string, rootTs?: string): Promise<{ id: string; entries: unknown[] } | null> {
    const wanted = rootTs ? `ch:${channel}:${rootTs}` : `dm:${channel}`;
    const { sessions } = await this.listSessions();
    for (const s of sessions) {
      try {
        const full = await this.getSession(s.id);
        if (full.session?.threadRef === wanted) return { id: s.id, entries: full.entries };
      } catch {
        void 0;
      }
    }
    return null;
  }
}
