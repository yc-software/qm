import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch } from "undici";
import type { BrokerFetch } from "./credential-broker.ts";
import { isPrivateNetworkIp } from "../util/network.ts";

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const resolveAddresses: Resolver = (hostname) => lookup(hostname, { all: true, order: "verbatim" });

export function createPublicBrokerLookup(resolve: Resolver = resolveAddresses): LookupFunction {
  return (hostname, options, callback) => {
    Promise.resolve()
      .then(() => resolve(hostname))
      .then((addresses) => {
        if (
          !addresses.length ||
          addresses.some(
            ({ address, family }) => !isIP(address) || isIP(address) !== family || isPrivateNetworkIp(address),
          )
        ) {
          throw new Error("Public broker destination is not allowed");
        }
        let family = options.family;
        if (family === "IPv4") family = 4;
        if (family === "IPv6") family = 6;
        const selected = addresses.filter((address) => !family || address.family === family);
        if (!selected.length) throw new Error("Public broker destination is not allowed");
        return selected;
      })
      .then(
        (addresses) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
        () => callback(new Error("Public broker destination is not allowed"), []),
      );
  };
}

export function createPublicBrokerFetch(resolve: Resolver = resolveAddresses): BrokerFetch {
  const lookup = createPublicBrokerLookup(resolve);
  return async (rawUrl, init) => {
    try {
      const url = new URL(rawUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        isPrivateNetworkIp(url.hostname) ||
        Object.keys(init.headers).some((header) => header.toLowerCase() === "host")
      ) {
        throw new Error("Public broker destination is not allowed");
      }

      const agent = new Agent({
        connect: { lookup, timeout: 10_000, rejectUnauthorized: true },
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
      });
      try {
        const response = await fetch(url, {
          method: init.method,
          headers: init.headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          dispatcher: agent,
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 5_000_000) {
                await reader.cancel();
                throw new Error("Public broker response is too large");
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        const text = Buffer.concat(chunks).toString("utf8");
        const contentType = response.headers.get("content-type");
        return {
          status: response.status,
          ...(contentType ? { contentType } : {}),
          text: async () => text,
        };
      } finally {
        await agent.destroy();
      }
    } catch {
      throw new Error("Public broker request failed");
    }
  };
}

export const publicBrokerFetch: BrokerFetch = createPublicBrokerFetch();
