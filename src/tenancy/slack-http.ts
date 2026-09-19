import { AsyncResource } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SlackPluginConfig } from "../slack/config.ts";
import { createHttpEventsReceiver, SLACK_EVENTS_PATH, type HttpEventsReceiver } from "../slack/http-events.ts";

export function createTenantSlackHttp() {
  const active = new Map<string, HttpEventsReceiver>();

  return {
    wrap: AsyncResource.bind((config: SlackPluginConfig): SlackPluginConfig => {
      if (config.eventsMode !== "http" || config.receiverFactory) return config;
      const signingSecret = config.signingSecret;
      if (!signingSecret) throw new Error("Slack HTTP events require a signing secret");
      const path = config.accountId
        ? `/slack/accounts/${encodeURIComponent(config.accountId)}/events`
        : SLACK_EVENTS_PATH;
      return {
        ...config,
        receiverFactory: AsyncResource.bind((staging) => {
          const receiver = createHttpEventsReceiver({
            externalListener: true,
            signingSecret,
            port: config.eventsPort ?? 0,
            path,
            ...(config.ackCapMs !== undefined ? { capMs: config.ackCapMs } : {}),
            ...(staging ? { staging } : {}),
          });
          return {
            init: receiver.init?.bind(receiver),
            start: AsyncResource.bind(async (...args: Parameters<typeof receiver.start>) => {
              const previous = active.get(path);
              if (previous && previous !== receiver) throw new Error(`Slack HTTP events path already active: ${path}`);
              active.set(path, receiver);
              try {
                return await receiver.start(...args);
              } catch (error) {
                if (active.get(path) === receiver) active.delete(path);
                throw error;
              }
            }),
            stop: AsyncResource.bind(async (...args: Parameters<typeof receiver.stop>) => {
              if (active.get(path) === receiver) active.delete(path);
              await receiver.stop(...args);
            }),
          };
        }),
      };
    }),
    handle: AsyncResource.bind(async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const path = (req.url ?? "").split("?")[0]!;
      if (path !== SLACK_EVENTS_PATH && !/^\/slack\/accounts\/[^/]+\/events$/.test(path)) return false;
      const receiver = active.get(path);
      if (receiver) await receiver.handle(req, res);
      else {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_ready" }));
      }
      return true;
    }),
  };
}
