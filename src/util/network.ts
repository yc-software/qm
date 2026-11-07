import { lookup as dnsLookup } from "node:dns";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

type Subnet = readonly [network: string, prefix: number];

function blockList(ipv4: readonly Subnet[], ipv6: readonly Subnet[]): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of ipv4) {
    list.addSubnet(network, prefix, "ipv4");
    list.addSubnet(`64:ff9b::${network}`, 96 + prefix, "ipv6");
  }
  for (const [network, prefix] of ipv6) list.addSubnet(network, prefix, "ipv6");
  return list;
}

const PRIVATE_NETWORKS = blockList(
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ],
  [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["fc00::", 7],
    ["fec0::", 10],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
  ],
);

const NEVER_ALLOWED = blockList(
  [
    ["0.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["100.100.100.100", 32],
    ["100.100.100.200", 32],
  ],
  [
    ["::", 128],
    ["::1", 128],
    ["fe80::", 10],
    ["fd00:ec2::254", 128],
    ["fd20:ce::254", 128],
    ["fd00:c1::a9fe:a9fe", 128],
  ],
);

const NEVER_ALLOWED_HOSTS = ["localhost", "metadata.google.internal", "metadata.goog"];

function normalizedIp(raw: string): string | null {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/%.*$/, "");
  return isIP(value) ? value : null;
}

function inList(list: BlockList, raw: string): boolean {
  const value = normalizedIp(raw);
  return value !== null && list.check(value, isIP(value) === 4 ? "ipv4" : "ipv6");
}

export function isPrivateNetworkIp(raw: string): boolean {
  return inList(PRIVATE_NETWORKS, raw);
}

export function isNeverAllowedIp(raw: string): boolean {
  return inList(NEVER_ALLOWED, raw);
}

export function isNeverAllowedHost(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  const host = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (normalizedIp(host)) return isNeverAllowedIp(host);
  return NEVER_ALLOWED_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
}

export function parsePrivateNetworkOrigins(raw: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const [index, entry] of (raw ?? "").split(",").entries()) {
    const value = entry.trim();
    if (!value) continue;
    const at = `PRIVATE_NETWORK_ALLOWED_ORIGINS entry ${index + 1}`;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        `${at} is not a valid URL (value not shown); list origins such as http://gbrain:8787, separated by commas`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(
        `${at} is not an http:// or https:// origin (value not shown); list origins such as http://gbrain:8787`,
      );
    if (url.username || url.password)
      throw new Error(`${at} (${url.origin}) carries credentials; remove them, since the list holds origins only`);
    if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
    if (url.href !== `${url.origin}/`)
      throw new Error(`${at} (${url.origin}) has a path, query or fragment; list the origin alone, as ${url.origin}`);
    if (isNeverAllowedHost(url.hostname))
      throw new Error(
        `${at} (${url.origin}) is a loopback, link-local or cloud metadata address, which can never be allowed; remove it, and list the service's own name or address instead`,
      );
    origins.add(url.origin);
  }
  return origins;
}

export class PrivateNetworkAddressError extends Error {}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toResponse(res: IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 502;
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers))
    for (const item of [value ?? []].flat()) headers.append(name, item);
  const nullBody = NULL_BODY_STATUSES.has(status) || method === "HEAD";
  if (nullBody) res.resume();
  const body = nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
  return new Response(body, { status, statusText: res.statusMessage ?? "", headers });
}

export type AddressFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function refusingLookup(refused: (ip: string) => boolean, refusal: string): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, "");
      const first = addresses[0];
      if (!first || addresses.some((a) => refused(a.address)))
        return callback(new PrivateNetworkAddressError(`${hostname} resolves to ${refusal}`), "");
      if (options.all) return callback(null, addresses);
      callback(null, first.address, first.family);
    });
  };
}

export function addressGuardedFetch(
  refused: (ip: string) => boolean,
  { timeoutMs = 300_000, refusal = "a private network address" }: { timeoutMs?: number; refusal?: string } = {},
): AddressFetch {
  const lookup = refusingLookup(refused, refusal);
  const agents = {
    "http:": new HttpAgent({ keepAlive: true, lookup }),
    "https:": new HttpsAgent({ keepAlive: true, lookup }),
  };
  return (input, init = {}) => guardedRequest(new URL(input), init, { agents, refused, refusal, timeoutMs });
}

export function createPublicFetch(origins: ReadonlySet<string>, listedRefused = isNeverAllowedIp): AddressFetch {
  const strict = addressGuardedFetch(isPrivateNetworkIp, {
    refusal:
      "a private network address; a deployment operator can allow this exact origin with PRIVATE_NETWORK_ALLOWED_ORIGINS",
  });
  const listed = addressGuardedFetch(listedRefused, {
    refusal:
      "a loopback, link-local or cloud metadata address, which PRIVATE_NETWORK_ALLOWED_ORIGINS never allows; point it at the service's own address",
  });
  return (input, init) => (origins.has(new URL(input).origin) ? listed : strict)(input, init);
}

let configuredPublicFetch = createPublicFetch(new Set());

export function configurePublicFetch(privateNetworkAllowedOrigins: ReadonlySet<string>): void {
  configuredPublicFetch = createPublicFetch(privateNetworkAllowedOrigins);
}

export const publicFetch: AddressFetch = (input, init) => configuredPublicFetch(input, init);

async function guardedRequest(
  url: URL,
  init: RequestInit,
  guard: {
    agents: { "http:": HttpAgent; "https:": HttpsAgent };
    refused: (ip: string) => boolean;
    refusal: string;
    timeoutMs: number;
  },
): Promise<Response> {
  const { agents, refused, refusal, timeoutMs } = guard;
  const agent = url.protocol === "https:" || url.protocol === "http:" ? agents[url.protocol] : undefined;
  if (!agent) throw new TypeError(`unsupported URL protocol ${url.protocol}`);
  const literal = normalizedIp(url.hostname);
  if (literal && refused(literal)) throw new PrivateNetworkAddressError(`${url.hostname} is ${refusal}`);
  const prepared = new Request(url, { method: init.method ?? "GET", headers: init.headers, body: init.body ?? null });
  const method = prepared.method;
  const headers = prepared.headers;
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("user-agent")) headers.set("user-agent", "node");
  const body = prepared.body ? Buffer.from(await prepared.arrayBuffer()) : undefined;
  if (body) headers.set("content-length", String(body.length));
  init.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method,
        agent,
        timeout: timeoutMs,
        headers: Object.fromEntries(headers),
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        if (init.redirect === "error" && res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy();
          return reject(new TypeError(`redirect from ${url.origin} refused`));
        }
        try {
          resolve(toResponse(res, method));
        } catch (error) {
          res.destroy();
          reject(error);
        }
      },
    );
    req.on("timeout", () => req.destroy(new Error(`request to ${url.origin} timed out`)));
    req.on("error", reject);
    req.end(body);
  });
}
