import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { TransformStream } from "node:stream/web";
import { Agent, buildConnector, fetch } from "undici";

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

const NEVER_ALLOWED = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["100.100.100.100", 32],
  ["100.100.100.200", 32],
] as const) {
  NEVER_ALLOWED.addSubnet(network, prefix, "ipv4");
  NEVER_ALLOWED.addSubnet(`64:ff9b::${network}`, 96 + prefix, "ipv6");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fe80::", 10],
  ["fd00:ec2::254", 128],
  ["fd00:ec2::23", 128],
  ["fd20:ce::254", 128],
  ["fd00:c1::a9fe:a9fe", 128],
  ["fd00:a9fe:a9fe::1", 128],
  ["fd00:42::42", 128],
  ["fd7a:115c:a1e0::53", 128],
] as const)
  NEVER_ALLOWED.addSubnet(network, prefix, "ipv6");

const NEVER_ALLOWED_HOSTS = ["localhost", "metadata.google.internal", "metadata.goog"];

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

export function isNeverAllowedIp(raw: string): boolean {
  const value = normalizedIp(raw);
  if (!value) return false;
  return NEVER_ALLOWED.check(value, isIP(value) === 4 ? "ipv4" : "ipv6");
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
  const connect = buildConnector({ lookup: refusingLookup(refused, refusal) });
  const dispatcher = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: (options, callback) => {
      const literal = normalizedIp(options.hostname);
      if (literal && refused(literal))
        return callback(new PrivateNetworkAddressError(`${options.hostname} is ${refusal}`), null);
      connect(options, callback);
    },
  });
  return async (input, init = {}) => {
    const request = new Request(input, init);
    return fetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      body: request.body ? await request.arrayBuffer() : null,
      signal: init.signal,
      redirect: init.redirect ?? "manual",
      dispatcher,
    }).then(
      (response) =>
        new Response((response.body?.pipeThrough(new TransformStream()) ?? null) as ReadableStream<Uint8Array> | null, {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
        }),
      (error: unknown) => {
        throw error instanceof TypeError && error.cause instanceof PrivateNetworkAddressError ? error.cause : error;
      },
    );
  };
}

export function createPublicFetch(origins: ReadonlySet<string>, listedRefused = isNeverAllowedIp): AddressFetch {
  const following = addressGuardedFetch(isPrivateNetworkIp);
  const strict = addressGuardedFetch(isPrivateNetworkIp, {
    refusal:
      "a private network address; a deployment operator can allow this exact origin with PRIVATE_NETWORK_ALLOWED_ORIGINS",
  });
  const listed = addressGuardedFetch(listedRefused, {
    refusal:
      "a loopback, link-local or cloud metadata address, which PRIVATE_NETWORK_ALLOWED_ORIGINS never allows; point it at the service's own address",
  });
  return (input, init) => {
    if (init?.redirect === "follow") return following(input, init);
    return (origins.has(new URL(input).origin) ? listed : strict)(input, init);
  };
}

let configuredPublicFetch = createPublicFetch(new Set());

export function configurePublicFetch(
  privateNetworkAllowedOrigins: ReadonlySet<string>,
  listedRefused?: (ip: string) => boolean,
): void {
  configuredPublicFetch = createPublicFetch(privateNetworkAllowedOrigins, listedRefused);
}

export const publicFetch: AddressFetch = (input, init) => configuredPublicFetch(input, init);
