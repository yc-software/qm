import { lookup as dnsLookup } from "node:dns";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

const PRIVATE_NETWORKS = new BlockList();

for (const [network, prefix] of [
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
] as const) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv4");
  PRIVATE_NETWORKS.addSubnet(`64:ff9b::${network}`, 96 + prefix, "ipv6");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv6");

function normalizedIp(raw: string): string | null {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/%.*$/, "");
  return isIP(value) ? value : null;
}

export function isPrivateNetworkIp(raw: string): boolean {
  const value = normalizedIp(raw);
  if (!value) return false;
  return PRIVATE_NETWORKS.check(value, isIP(value) === 4 ? "ipv4" : "ipv6");
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

function refusingLookup(refused: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, "");
      const first = addresses[0];
      if (!first || addresses.some((a) => refused(a.address)))
        return callback(new PrivateNetworkAddressError(`${hostname} resolves to a private network address`), "");
      if (options.all) return callback(null, addresses);
      callback(null, first.address, first.family);
    });
  };
}

export function addressGuardedFetch(
  refused: (ip: string) => boolean,
  { timeoutMs = 300_000 }: { timeoutMs?: number } = {},
): AddressFetch {
  const lookup = refusingLookup(refused);
  const agents = {
    "http:": new HttpAgent({ keepAlive: true, lookup }),
    "https:": new HttpsAgent({ keepAlive: true, lookup }),
  };
  return (input, init = {}) => guardedRequest(new URL(input), init, { agents, refused, timeoutMs });
}

export const publicFetch = addressGuardedFetch(isPrivateNetworkIp);

async function guardedRequest(
  url: URL,
  init: RequestInit,
  guard: { agents: { "http:": HttpAgent; "https:": HttpsAgent }; refused: (ip: string) => boolean; timeoutMs: number },
): Promise<Response> {
  const { agents, refused, timeoutMs } = guard;
  const agent = url.protocol === "https:" || url.protocol === "http:" ? agents[url.protocol] : undefined;
  if (!agent) throw new TypeError(`unsupported URL protocol ${url.protocol}`);
  const literal = normalizedIp(url.hostname);
  if (literal && refused(literal)) throw new PrivateNetworkAddressError(`${url.hostname} is a private network address`);
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
