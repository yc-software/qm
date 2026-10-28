import type { ExternalSlackAccess } from "../slack/external-access.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pinnedPerTenant } from "../tenant.ts";
import type { SurfaceSender } from "./outbound.ts";
import { surfaceProfile, type Surface } from "./surface.ts";

interface SlackAccountHandle {
  client: any;
  teamId: string;
  policy?: ExternalSlackAccess;
  inFlightRuns?: { add(id: string): void; delete(id: string): void; has(id: string): boolean };
}

export type SlackEventsHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface SlackNative {
  readonly accounts: Map<string, SlackAccountHandle>;
  attach(sender: SurfaceSender): () => void;
  serveEvents(account: string, handler: SlackEventsHandler): () => void;
  events(account: string): SlackEventsHandler | undefined;
}

export interface SlackSurface extends Surface {
  readonly slack: SlackNative;
}

export function createSlackSurface(): SlackSurface {
  const state = pinnedPerTenant(() => ({
    accounts: new Map<string, SlackAccountHandle>(),
    senders: [] as SurfaceSender[],
    events: new Map<string, SlackEventsHandler>(),
  }));
  const slack: SlackNative = {
    get accounts() {
      return state().accounts;
    },
    attach(sender) {
      const own = state();
      own.senders = [...own.senders, sender];
      return () => {
        own.senders = own.senders.filter((s) => s !== sender);
      };
    },
    serveEvents(account, handler) {
      const { events } = state();
      events.set(account, handler);
      return () => {
        if (events.get(account) === handler) events.delete(account);
      };
    },
    events: (account) => state().events.get(account),
  };
  return {
    name: "slack",
    label: surfaceProfile("slack").label!,
    traits: surfaceProfile("slack").traits,
    destinationTypes: ["slack", "group", "principal"],
    slack,
    async deliver(post) {
      const sender = state().senders.at(-1);
      if (!sender) throw new Error(`no ${post.destination.type} connection is available to post this message`);
      return sender(post);
    },
  };
}
