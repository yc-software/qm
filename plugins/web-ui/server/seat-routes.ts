import type { IncomingMessage, ServerResponse } from "node:http";

interface SeatCtx {
  req: IncomingMessage;
  res: ServerResponse;
  user: string;
  params: Record<string, string>;
}

interface SeatRouteDeps {
  impersonated: (req: IncomingMessage) => boolean;
  relayCore: (res: ServerResponse, method: "GET" | "POST", pathWithQuery: string, rawBody?: string) => Promise<void>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: <T extends object>(req: IncomingMessage, res: ServerResponse, allowEmpty?: boolean) => Promise<T | null>;
}

const stepPath = (id: string) => `/v1/seat/steps/${encodeURIComponent(id)}`;
const asUser = (user: string) => new URLSearchParams({ principalId: user }).toString();

export function seatRoutes(d: SeatRouteDeps) {
  const refused = (c: SeatCtx) => {
    if (!d.impersonated(c.req)) return false;
    d.json(c.res, 403, { error: "forbidden", message: "Agent Seat is not available while viewing as someone else." });
    return true;
  };
  return [
    {
      method: "GET",
      path: "/api/seat/steps",
      handle: async (c: SeatCtx) => {
        if (refused(c)) return;
        return d.relayCore(c.res, "GET", `/v1/seat/steps?${asUser(c.user)}`);
      },
    },
    {
      method: "GET",
      path: "/api/seat/steps/:id",
      handle: async (c: SeatCtx) => {
        if (refused(c)) return;
        return d.relayCore(c.res, "GET", `${stepPath(c.params.id!)}?${asUser(c.user)}`);
      },
    },
    {
      method: "POST",
      path: "/api/seat/steps/:id/move",
      handle: async (c: SeatCtx) => {
        if (refused(c)) return;
        const body = await d.readJson<{ content?: unknown }>(c.req, c.res, false);
        if (!body) return;
        const payload = JSON.stringify({ content: body.content, principalId: c.user });
        return d.relayCore(c.res, "POST", `${stepPath(c.params.id!)}/move`, payload);
      },
    },
    {
      method: "POST",
      path: "/api/seat/steps/:id/ask",
      handle: async (c: SeatCtx) => {
        if (refused(c)) return;
        return d.relayCore(c.res, "POST", `${stepPath(c.params.id!)}/ask`, JSON.stringify({ principalId: c.user }));
      },
    },
  ];
}
