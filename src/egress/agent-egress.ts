import { LRUCache } from "lru-cache";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { EGRESS_PROXY_AUD, mintCapabilityToken } from "../auth/capability-token.ts";
import { forceThroughProxyEnv } from "../sandbox/sandbox-env.ts";
import type { ScopeId } from "../types.ts";

/**
 * Core-originated requests made on the agent's behalf (credential broker upstream calls, MCP tool
 * calls, …) leave through the same egress proxy sandboxes use, so the proxy audits them alongside
 * sandbox traffic. Each request carries a short-lived capability token naming the principal and
 * scope that caused it and allowing only the host being contacted; the proxy still applies its own
 * blocks (metadata endpoints, loopback, private networks).
 */

export const AGENT_EGRESS_TOKEN_TTL_MS = 10 * 60_000;
/** Stop reusing a dispatcher well before its token expires. */
const DISPATCHER_REUSE_MS = AGENT_EGRESS_TOKEN_TTL_MS - 2 * 60_000;
const DISPATCHER_CACHE_MAX = 256;

export interface AgentEgressContext {
  actorId: string;
  scopeId: ScopeId;
}

export type AgentFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface AgentEgress {
  readonly proxyUrl: string;
  /** Dispatcher that tunnels to `host` through the egress proxy, attributed to `ctx`. */
  dispatcher(ctx: AgentEgressContext, host: string): Promise<Dispatcher>;
  /** `fetch` for one request, routed through the proxy and attributed to `ctx`. */
  fetch(url: string | URL, init: RequestInit | undefined, ctx: AgentEgressContext): Promise<Response>;
  /** A `fetch`-shaped function bound to `ctx`, for libraries that accept a custom fetch. */
  fetchFor(ctx: AgentEgressContext): AgentFetch;
  /** HTTPS_PROXY-style environment for a subprocess that may contact `hosts`, attributed to `ctx`. */
  proxyEnv(ctx: AgentEgressContext, hosts: string[], base?: Record<string, string>): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export interface AgentEgressOptions {
  proxyUrl: string;
  capabilitySecret: string;
  capabilityTokenCompression?: boolean;
  now?: () => number;
  /** Test seam: build the dispatcher for a proxy URL and Proxy-Authorization value. */
  createDispatcher?: (proxyUrl: string, token: string) => Dispatcher;
}

function hostOf(url: string | URL): string {
  const h = (typeof url === "string" ? new URL(url) : url).hostname;
  if (!h) throw new Error("agent egress: request URL has no host");
  return h.replace(/^\[(.*)\]$/, "$1");
}

export function createAgentEgress(opts: AgentEgressOptions): AgentEgress {
  const now = opts.now ?? (() => Date.now());
  new URL(opts.proxyUrl); // validate early
  // proxyTunnel: CONNECT for plain-http targets too; the egress proxy only speaks CONNECT.
  const createDispatcher =
    opts.createDispatcher ??
    ((uri: string, token: string) => new ProxyAgent({ uri, token: `Bearer ${token}`, proxyTunnel: true }));
  const dispatchers = new LRUCache<string, Dispatcher>({
    max: DISPATCHER_CACHE_MAX,
    ttl: DISPATCHER_REUSE_MS,
    dispose: (d) => void d.close().catch(() => {}),
  });
  const pending = new Map<string, Promise<Dispatcher>>();

  async function mint(ctx: AgentEgressContext, hosts: string[]): Promise<string> {
    return mintCapabilityToken(
      {
        actorId: ctx.actorId,
        scopeId: ctx.scopeId,
        aud: EGRESS_PROXY_AUD,
        egress: { allowedHosts: hosts.map((h) => h.toLowerCase()), denyPrivateNetworks: true },
        exp: now() + AGENT_EGRESS_TOKEN_TTL_MS,
      },
      opts.capabilitySecret,
      opts.capabilityTokenCompression ?? false,
    );
  }

  async function dispatcher(ctx: AgentEgressContext, host: string): Promise<Dispatcher> {
    const key = `${ctx.scopeId}\0${ctx.actorId}\0${host.toLowerCase()}`;
    const cached = dispatchers.get(key);
    if (cached) return cached;
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const build = (async () => {
      const d = createDispatcher(opts.proxyUrl, await mint(ctx, [host]));
      dispatchers.set(key, d);
      return d;
    })().finally(() => pending.delete(key));
    pending.set(key, build);
    return build;
  }

  async function fetchVia(
    url: string | URL,
    init: RequestInit | undefined,
    ctx: AgentEgressContext,
  ): Promise<Response> {
    const d = await dispatcher(ctx, hostOf(url));
    // undici's own fetch pairs with undici's ProxyAgent; Node's bundled fetch is a different undici build.
    const u = typeof url === "string" ? url : url.href;
    return (await undiciFetch(u, {
      ...(init as unknown as Parameters<typeof undiciFetch>[1]),
      dispatcher: d,
    })) as unknown as Response;
  }

  return {
    proxyUrl: opts.proxyUrl,
    dispatcher,
    fetch: fetchVia,
    fetchFor: (ctx) => (url, init) => fetchVia(url, init, ctx),
    proxyEnv: async (ctx, hosts, base = {}) => forceThroughProxyEnv(opts.proxyUrl, await mint(ctx, hosts), base),
    async close() {
      const all = [...dispatchers.values()];
      dispatchers.clear();
      await Promise.all(all.map((d) => d.close().catch(() => {})));
    },
  };
}
