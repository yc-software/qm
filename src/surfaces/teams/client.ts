import { ConfidentialClientApplication, ServerError, type INetworkModule } from "@azure/msal-node";
import {
  Client,
  MessageActivityInput,
  PUBLIC,
  TypingActivityInput,
  cardAttachment,
  type TeamsChannelAccount,
} from "@microsoft/teams.api";
import { EMOJI_CHAR_BY_NAME } from "../../slack/emoji-map.ts";
import { safeChunks, safeClip } from "../../slack/safe-cut.ts";
import { tenantSettings } from "../../tenants/settings.ts";
import { GenericChatHttpError, type GenericChatClient } from "../generic-chat/client.ts";
import type { GenericChatAction } from "../generic-chat/protocol.ts";
import { UnknownGenericChatReaction } from "../generic-chat/reactions.ts";
import { decodeTeamsChat, decodeTeamsUser, TEAMS, TEAMS_ACTION_KEY, type TeamsBot } from "./ids.ts";

const SERVICE_URL = "https://smba.trafficmanager.net/teams/";
const MESSAGE_CHARS = 9_000;

const REACTIONS: Record<string, string> = {
  "👍": "like",
  "❤️": "heart",
  "😆": "laugh",
  "😮": "surprised",
  "😢": "sad",
  "😡": "angry",
  "👀": "1f440_eyes",
  "✅": "2705_whiteheavycheckmark",
  "👋": "1f44b_wavinghand",
  "📌": "1f4cc_pushpin",
  "🚀": "launch",
};

const REACTION_NAMES = Object.keys(EMOJI_CHAR_BY_NAME).filter((name) => EMOJI_CHAR_BY_NAME[name]! in REACTIONS);

const BUTTON_STYLE = { primary: "positive", danger: "destructive", default: "default" } as const;

function card(body: string, actions: readonly GenericChatAction[]) {
  return cardAttachment("adaptive", {
    type: "AdaptiveCard",
    version: "1.5",
    body: [{ type: "TextBlock", text: body, wrap: true }],
    actions: actions.map((a) => ({
      type: "Action.Submit",
      title: a.label,
      style: BUTTON_STYLE[a.style],
      data: { [TEAMS_ACTION_KEY]: a.id },
    })),
  });
}

function message(body: string, actions: readonly GenericChatAction[] | undefined): MessageActivityInput {
  if (actions?.length) return new MessageActivityInput().addAttachments(card(body, actions));
  return new MessageActivityInput(body).withTextFormat("markdown");
}

function failure(e: unknown): never {
  const status = (e as { response?: { status?: unknown } }).response?.status;
  if (typeof status === "number")
    throw new GenericChatHttpError(status, (e as { message?: string }).message ?? `HTTP ${status}`);
  throw e;
}

function teamsBot(): TeamsBot {
  const bot = tenantSettings().teams;
  if (!bot) throw new GenericChatHttpError(404, "teams: this workspace has no Teams bot configured");
  return bot;
}

export class TeamsTokenError extends GenericChatHttpError {
  readonly description: string;
  constructor(status: number, description: string) {
    super(status, `teams: token request failed: ${description}`);
    this.description = description;
  }
}

function confidentialClient({ tenantId, appId, appSecret }: TeamsBot, networkClient?: INetworkModule) {
  return new ConfidentialClientApplication({
    auth: { clientId: appId, clientSecret: appSecret, authority: `${PUBLIC.loginEndpoint}/${tenantId}` },
    ...(networkClient ? { system: { networkClient } } : {}),
  });
}

async function acquire(app: ConfidentialClientApplication): Promise<string> {
  try {
    const result = await app.acquireTokenByClientCredential({ scopes: [PUBLIC.botScope] });
    if (result?.accessToken) return result.accessToken;
    throw new TeamsTokenError(502, "Microsoft returned no access token");
  } catch (error) {
    if (error instanceof ServerError)
      throw new TeamsTokenError(error.status ?? 502, error.errorMessage || error.errorCode);
    throw error;
  }
}

export function requestTeamsToken(bot: TeamsBot, networkClient?: INetworkModule): Promise<string> {
  return acquire(confidentialClient(bot, networkClient));
}

export function createTeamsClient(deps: { networkClient?: INetworkModule; serviceUrl?: string } = {}) {
  const apps = new Map<string, ConfidentialClientApplication>();

  function token(bot: TeamsBot): Promise<string> {
    const key = `${bot.tenantId}:${bot.appId}:${bot.appSecret}`;
    let app = apps.get(key);
    if (!app) apps.set(key, (app = confidentialClient(bot, deps.networkClient)));
    return acquire(app);
  }

  function api(): Client {
    const bot = teamsBot();
    return new Client(deps.serviceUrl ?? SERVICE_URL, { token: () => token(bot) });
  }

  async function members(conversationId: string): Promise<TeamsChannelAccount[]> {
    const client = api();
    const all: TeamsChannelAccount[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await client.conversations.members(conversationId).getPaged(500, continuationToken).catch(failure);
      all.push(...page.members);
      continuationToken = page.continuationToken || undefined;
    } while (continuationToken);
    return all;
  }

  async function member(conversationId: string, id: string): Promise<TeamsChannelAccount> {
    return api().conversations.members(conversationId).getById(id).catch(failure);
  }

  const client: GenericChatClient & { members: typeof members; member: typeof member } = {
    surface: TEAMS,
    tenantKey: "teams_tenant",
    reactions: REACTION_NAMES,
    files: false,
    members,
    member,
    async post(_account, m) {
      const chat = decodeTeamsChat(m.chat_id);
      const conversations = api().conversations;
      const target = m.thread_id && chat.type === "channel" ? `${chat.id};messageid=${m.thread_id}` : chat.id;
      const parts = safeChunks(m.body, MESSAGE_CHARS);
      let messageId = "";
      for (const [i, part] of parts.entries()) {
        const activity = message(part, i === parts.length - 1 ? m.actions : undefined);
        const res = m.recipient_user_id
          ? await conversations
              .activities(chat.id)
              .createTargeted(
                activity.withRecipient({ id: decodeTeamsUser(m.recipient_user_id), name: "", role: "user" }, true),
              )
              .catch(failure)
          : await conversations.activities(target).create(activity).catch(failure);
        messageId = res.id;
      }
      return { message_id: messageId };
    },
    async update(_account, m) {
      const chat = decodeTeamsChat(m.chat_id);
      await api()
        .conversations.activities(chat.id)
        .update(m.message_id, message(safeClip(m.body, MESSAGE_CHARS), m.actions))
        .catch(failure);
      return {};
    },
    async delete(_account, m) {
      await api().conversations.activities(decodeTeamsChat(m.chat_id).id).delete(m.message_id).catch(failure);
      return {};
    },
    async typing(_account, state) {
      if (!state.typing) return {};
      const chat = decodeTeamsChat(state.chat_id);
      const target = state.thread_id && chat.type === "channel" ? `${chat.id};messageid=${state.thread_id}` : chat.id;
      await api().conversations.activities(target).create(new TypingActivityInput()).catch(failure);
      return {};
    },
    async react(_account, reaction, { on, emoji }) {
      const type = REACTIONS[emoji];
      if (!type) throw new UnknownGenericChatReaction(reaction.name);
      const chat = decodeTeamsChat(reaction.chat_id);
      const reactions = api().reactions;
      await (on ? reactions.add : reactions.delete).call(reactions, chat.id, reaction.message_id, type).catch(failure);
      return {};
    },
    async fileUrl() {
      throw new GenericChatHttpError(501, "teams: files are not supported yet");
    },
    async upload() {
      throw new GenericChatHttpError(501, "teams: files are not supported yet");
    },
  };
  return client;
}

export type TeamsClient = ReturnType<typeof createTeamsClient>;
