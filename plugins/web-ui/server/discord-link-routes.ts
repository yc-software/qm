import type { IncomingMessage, ServerResponse } from "node:http";

type LinkMethod = "GET" | "POST" | "DELETE";

interface LinkCtx {
  req: IncomingMessage;
  res: ServerResponse;
}

interface DiscordLinkRouteDeps {
  relayCore: (res: ServerResponse, method: LinkMethod, pathWithQuery: string, rawBody?: string) => Promise<void>;
  readJson: <T extends object>(req: IncomingMessage, res: ServerResponse, allowEmpty?: boolean) => Promise<T | null>;
}

export function discordLinkRoutes(d: DiscordLinkRouteDeps) {
  const relay = (c: LinkCtx, method: LinkMethod, path: string, body?: unknown) => {
    c.res.setHeader("Cache-Control", "no-store");
    return d.relayCore(c.res, method, path, body === undefined ? undefined : JSON.stringify(body));
  };
  return [
    {
      method: "GET",
      path: "/api/discord/link",
      handle: (c: LinkCtx) => relay(c, "GET", "/v1/discord/link"),
    },
    {
      method: "POST",
      path: "/api/discord/link/authorize",
      handle: async (c: LinkCtx) => {
        const body = await d.readJson<{ nonceHash?: unknown }>(c.req, c.res, false);
        if (!body) return;
        return relay(c, "POST", "/v1/discord/link/authorize", { nonceHash: body.nonceHash });
      },
    },
    {
      method: "POST",
      path: "/api/discord/link/complete",
      handle: async (c: LinkCtx) => {
        const body = await d.readJson<{ code?: unknown; state?: unknown; nonce?: unknown }>(c.req, c.res, false);
        if (!body) return;
        return relay(c, "POST", "/v1/discord/link/complete", {
          code: body.code,
          state: body.state,
          nonce: body.nonce,
        });
      },
    },
    {
      method: "DELETE",
      path: "/api/discord/link",
      handle: (c: LinkCtx) => relay(c, "DELETE", "/v1/discord/link"),
    },
  ];
}
