import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { EGRESS_PROXY_AUD, verifyCapabilityToken, type CapabilityClaims } from "./auth/capability-token.ts";
import { egressDecision, hostMatches, isHostDenied, type EgressVerdict } from "./resolution/egress-policy.ts";
import { createEgressAuditSink, type EgressAuditRecord, type EgressAuditSink } from "./admin/egress-audit-sink.ts";
import { createPostgresEgressAuditSink } from "./admin/postgres-egress-audit-sink.ts";
import { signedRequestHeaders } from "./auth/source-auth-sign.ts";
import { createSweeper } from "./util/sweeper.ts";
import { errMessage } from "./util/errors.ts";
import { numEnv } from "./config.ts";
import type { EgressPolicy, ScopeId } from "./types.ts";
import { isPrivateNetworkIp } from "./util/network.ts";

const OPEN: EgressPolicy = { allowedHosts: [], deniedHosts: [] };

const DENY_ALL: EgressPolicy = { allowedHosts: ["deny.invalid"], deniedHosts: [] };

const METADATA_HOSTS = ["metadata.google.internal", "metadata.goog"];

const BLOCKED = new BlockList();
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED.addSubnet("fe80::", 10, "ipv6");
BLOCKED.addAddress("fd00:ec2::254", "ipv6");
BLOCKED.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED.addAddress("::1", "ipv6");
BLOCKED.addAddress("::", "ipv6");

export function isBlockedDestinationIp(ip: string): boolean {
  const s = ip
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/%.*$/, "");
  const fam = isIP(s);
  if (!fam) return false;
  return BLOCKED.check(s, fam === 4 ? "ipv4" : "ipv6");
}

function isAlwaysBlockedHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
  if (isIP(h)) return isBlockedDestinationIp(h);
  return METADATA_HOSTS.some((m) => h === m || h.endsWith(`.${m}`));
}

export function tokenFromRequest(req: IncomingMessage): string | null {
  const raw = req.headers["proxy-authorization"] as string | undefined;
  if (!raw) return null;
  const [scheme, value] = raw.split(/\s+/, 2);
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() === "bearer") return value;
  if (scheme.toLowerCase() === "basic") {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon >= 0 ? decoded.slice(colon + 1) : decoded;
  }
  return null;
}

export function hostFromAuthority(authority: string): string | null {
  const a = authority.trim();
  if (!a) return null;
  const m = /^\[(.+)\](?::\d+)?$/.exec(a);
  if (m) return m[1]!;
  const i = a.lastIndexOf(":");
  if (i > 0 && !a.slice(i + 1).includes(":") && /^\d+$/.test(a.slice(i + 1))) return a.slice(0, i);
  return a;
}

export type EgressAuditRecorder = Pick<EgressAuditSink, "record">;

export interface EgressAuthzDeps {
  capabilitySecret?: string;
  audit: EgressAuditRecorder;
  tokenless?: "open" | "deny";
  now?: () => number;
  lookup?: (host: string) => Promise<string[]>;
}

function defaultLookup(host: string): Promise<string[]> {
  if (isIP(host)) return Promise.resolve([host]);
  return dnsLookup(host, { all: true, verbatim: true }).then((rs) => rs.map((r) => r.address));
}

async function claimsFor(token: string | null, deps: EgressAuthzDeps): Promise<CapabilityClaims | null> {
  const claims =
    token && deps.capabilitySecret ? await verifyCapabilityToken(token, deps.capabilitySecret, deps.now?.()) : null;
  return claims && claims.aud === EGRESS_PROXY_AUD ? claims : null;
}

async function decide(
  host: string,
  policy: EgressPolicy | undefined,
  lookup: (h: string) => Promise<string[]>,
): Promise<{ allow: boolean; verdict: EgressVerdict; address?: string }> {
  if (isAlwaysBlockedHost(host)) return { allow: false, verdict: "denied" };
  const byName = egressDecision(host, policy);
  if (!byName.allow) return byName;
  let ips: string[];
  try {
    ips = await lookup(host);
  } catch {
    return { allow: false, verdict: "denied" };
  }
  if (!ips.length) return { allow: false, verdict: "denied" };
  const privateAllowed = policy?.privateNetworkAllowedHosts?.some((rule) => hostMatches(host, rule)) === true;
  if (
    ips.some(
      (ip) =>
        isBlockedDestinationIp(ip) ||
        isHostDenied(ip, policy?.deniedHosts) ||
        (policy?.denyPrivateNetworks === true && !privateAllowed && isPrivateNetworkIp(ip)),
    )
  ) {
    return { allow: false, verdict: "denied" };
  }
  return { allow: true, verdict: "ok", address: ips[0] };
}

export function buildEgressAuthzServer(deps: EgressAuthzDeps): Server {
  const lookup = deps.lookup ?? defaultLookup;
  async function checkStatus(
    req: IncomingMessage,
    authority: string,
  ): Promise<{ status: 200 | 403; upstream?: string }> {
    const host = hostFromAuthority(authority);
    if (!host) return { status: 403 };
    const portText = authority.match(/:(\d+)$/)?.[1];
    const scheme = req.headers["x-egress-scheme"];
    let port = scheme === "http" ? 80 : 443;
    if (portText) port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return { status: 403 };
    const token = tokenFromRequest(req);
    const claims = await claimsFor(token, deps);
    let policy: EgressPolicy | undefined = DENY_ALL;
    if (claims) policy = claims.egress;
    else if (!token && deps.tokenless === "open") policy = OPEN;
    const d = await decide(host, policy, lookup);
    try {
      deps.audit.record({
        source: "proxy",
        host,
        allowed: d.allow,
        verdict: d.verdict,
        scopeLabel: (claims?.scopeId ?? "unknown") as ScopeId,
        principalId: claims?.actorId ?? "unknown",
      });
    } catch (error) {
      void error;
    }
    if (!d.allow || !d.address) return { status: 403 };
    return { status: 200, upstream: isIP(d.address) === 6 ? `[${d.address}]:${port}` : `${d.address}:${port}` };
  }
  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const authority = (req.headers["x-egress-authority"] as string | undefined) ?? req.headers.host ?? "";
      const result = await checkStatus(req, authority);
      res
        .writeHead(result.status, result.upstream ? { "x-egress-upstream-address": result.upstream } : undefined)
        .end();
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end();
    }
  }
  return createServer((req, res) => void onRequest(req, res));
}

const RELAY_FLUSH_MS = 2_000;
const RELAY_MAX_BATCH = 500;
const RELAY_MAX_BUFFER = 5_000;
const RELAY_PATH = "/v1/egress-audit";

export function createRelayAuditSink(
  coreApiUrl: string,
  signingSecret: string,
  fetchImpl: typeof fetch = fetch,
): EgressAuditRecorder & { flush(): Promise<void>; start(): void; stop(): void } {
  const url = coreApiUrl.replace(/\/$/, "") + RELAY_PATH;
  const pathWithQuery = new URL(url).pathname;
  const buffer: Array<Omit<EgressAuditRecord, "ts" | "source">> = [];
  let flushing = false;
  let dropped = 0;
  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    try {
      const batch = buffer.slice(0, RELAY_MAX_BATCH);
      const body = JSON.stringify({ records: batch });
      const res = await fetchImpl(url, {
        method: "POST",
        headers: signedRequestHeaders(signingSecret, "POST", pathWithQuery, body, {
          "content-type": "application/json",
        }),
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`core responded ${res.status}`);
      buffer.splice(0, batch.length);
      if (dropped > 0) {
        console.warn(`[egress-authz] audit relay recovered; ${dropped} records were dropped while the buffer was full`);
        dropped = 0;
      }
    } catch (e) {
      console.warn(`[egress-authz] audit relay to ${url} failed (${buffer.length} buffered): ${errMessage(e)}`);
    } finally {
      flushing = false;
    }
  }
  const sweeper = createSweeper(flush, RELAY_FLUSH_MS, { label: "egress-audit-relay" });
  return {
    record(r) {
      if (buffer.length >= RELAY_MAX_BUFFER) {
        dropped++;
        return;
      }
      const { source: _source, ...rest } = r;
      buffer.push(rest);
    },
    flush,
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
  };
}

function main(): void {
  const port = numEnv(process.env.AUTHZ_PORT) ?? 48081;
  const capabilitySecret = process.env.CAPABILITY_SECRET;
  const databaseUrl = process.env.DATABASE_URL;
  const coreApiUrl = process.env.CORE_API_URL;
  const relaySecret = process.env.CORE_SIGNING_SECRET;
  if (!capabilitySecret) console.warn("[egress-authz] CAPABILITY_SECRET unset — signed traffic will be denied");
  if (coreApiUrl && !relaySecret)
    console.warn("[egress-authz] CORE_API_URL set without CORE_SIGNING_SECRET — audit relay disabled");
  const relay = coreApiUrl && relaySecret ? createRelayAuditSink(coreApiUrl, relaySecret) : null;
  relay?.start();
  const audit: EgressAuditRecorder =
    relay ?? (databaseUrl ? createPostgresEgressAuditSink(databaseUrl) : createEgressAuditSink());

  const tokenless = process.env.EGRESS_TOKENLESS === "open" ? ("open" as const) : ("deny" as const);
  const server = buildEgressAuthzServer({ ...(capabilitySecret ? { capabilitySecret } : {}), audit, tokenless });
  server.listen(port, "127.0.0.1", () => console.log(`[egress-authz] listening on 127.0.0.1:${port}`));
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () =>
      server.close(() => void (relay ? relay.flush() : Promise.resolve()).finally(() => process.exit(0))),
    );
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
