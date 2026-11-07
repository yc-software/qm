import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch, type RequestInit as UndiciRequestInit } from "undici";

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
  const connect = buildConnector({ lookup: refusingLookup(refused) });
  const dispatcher = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: (options, callback) => {
      const literal = normalizedIp(options.hostname);
      if (literal && refused(literal))
        return callback(new PrivateNetworkAddressError(`${options.hostname} is a private network address`), null);
      connect(options, callback);
    },
  });
  return (input, init = {}) =>
    fetch(input, { ...(init as UndiciRequestInit), redirect: init.redirect ?? "manual", dispatcher }).then(
      (response) => response as Response,
      (error: unknown) => {
        throw error instanceof TypeError && error.cause instanceof PrivateNetworkAddressError ? error.cause : error;
      },
    );
}

export const publicFetch = addressGuardedFetch(isPrivateNetworkIp);
