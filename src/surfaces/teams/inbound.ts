import { PUBLIC, stripMentionsText, type TeamsChannelAccount } from "@microsoft/teams.api";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { LRUCache } from "lru-cache";
import { z } from "zod";
import type { App } from "../../api/app-types.ts";
import { inTenant } from "../../tenants/claim.ts";
import { tenantSettings } from "../../tenants/settings.ts";
import { errMessage } from "../../util/errors.ts";
import type { GenericChatUser } from "../generic-chat/protocol.ts";
import type { TeamsClient } from "./client.ts";
import { encodeTeamsChat, encodeTeamsUser, isTeamsChatType, TEAMS_ACTION_KEY, type TeamsBot } from "./ids.ts";

type Reply = { status: number; body: Record<string, unknown> };

const ROSTER_TTL_MS = 5 * 60_000;
const THREAD_MARKER = ";messageid=";

const account = z.object({ id: z.string().min(1), name: z.string().optional() });
const activitySchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  timestamp: z.iso.datetime({ offset: true }).optional(),
  serviceUrl: z.string().optional(),
  from: account,
  recipient: account,
  conversation: z.object({
    id: z.string().min(1),
    conversationType: z.string().optional(),
    tenantId: z.string().optional(),
    name: z.string().optional(),
  }),
  channelData: z.object({ tenant: z.object({ id: z.string() }).optional() }).optional(),
  text: z.string().optional(),
  entities: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        mentioned: account.optional(),
      }),
    )
    .optional(),
  replyToId: z.string().optional(),
  value: z.unknown().optional(),
  reactionsAdded: z.array(z.object({ type: z.string() })).optional(),
  reactionsRemoved: z.array(z.object({ type: z.string() })).optional(),
});

type Activity = z.infer<typeof activitySchema>;

type Mentioned = Parameters<typeof stripMentionsText>[0];

function messageText(activity: Activity): string {
  const own = stripMentionsText(activity as Mentioned, { accountId: activity.recipient.id }) ?? "";
  return (stripMentionsText({ ...activity, text: own } as Mentioned, { tagOnly: true }) ?? "").trim();
}

function actionId(value: unknown): string | undefined {
  const id = value && typeof value === "object" ? (value as Record<string, unknown>)[TEAMS_ACTION_KEY] : undefined;
  return typeof id === "string" && id ? id : undefined;
}

export function createTeamsInbound(deps: {
  client: Pick<TeamsClient, "members" | "member">;
  app: Pick<App, "tenantFor">;
  dispatch: (event: unknown, tenant?: string) => Promise<Reply>;
  keys?: JWTVerifyGetKey;
}) {
  const keys = deps.keys ?? createRemoteJWKSet(new URL("keys", PUBLIC.openIdMetadataUrl));
  const rosters = new LRUCache<string, TeamsChannelAccount[]>({ max: 1_000, ttl: ROSTER_TTL_MS });

  async function refusal(authorization: string | undefined, bot: TeamsBot, activity: Activity) {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (!token) return "no bearer token";
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: PUBLIC.tokenIssuer,
        audience: bot.appId,
        algorithms: ["RS256"],
        clockTolerance: 300,
      });
      if (payload.serviceurl !== activity.serviceUrl)
        return `token serviceurl ${String(payload.serviceurl)} does not match the activity's ${activity.serviceUrl}`;
      return undefined;
    } catch (e) {
      return errMessage(e);
    }
  }

  async function roster(conversationId: string, authorId: string): Promise<TeamsChannelAccount[]> {
    const cached = rosters.get(conversationId);
    if (!cached) {
      const fresh = await deps.client.members(conversationId);
      rosters.set(conversationId, fresh);
      return fresh;
    }
    if (!cached.some((m) => m.id === authorId)) cached.push(await deps.client.member(conversationId, authorId));
    return cached;
  }

  function person(m: TeamsChannelAccount, bot: TeamsBot): GenericChatUser {
    const email = m.email ?? m.userPrincipalName;
    return {
      id: encodeTeamsUser(m.id),
      ...(m.name ? { name: m.name } : {}),
      ...(email ? { email } : {}),
      member: m.tenantId === bot.tenantId && m.userRole !== "guest" && m.userRole !== "anonymous",
    };
  }

  async function toEvent(activity: Activity, bot: TeamsBot, tenantId: string): Promise<object | null> {
    const type = activity.conversation.conversationType;
    if (!isTeamsChatType(type)) return null;
    const [conversationId = activity.conversation.id, root] = activity.conversation.id.split(THREAD_MARKER);
    const self = { id: encodeTeamsUser(activity.recipient.id), name: activity.recipient.name ?? "", bot: true };
    const members = (await roster(conversationId, activity.from.id)).map((m) => person(m, bot));
    const author = members.find((m) => m.id === encodeTeamsUser(activity.from.id)) ?? {
      id: encodeTeamsUser(activity.from.id),
      ...(activity.from.name ? { name: activity.from.name } : {}),
    };
    const messageId = activity.type === "message" && !actionId(activity.value) ? activity.id : activity.replyToId;
    const base = {
      protocol: 2,
      event_id: `${activity.type}:${activity.id ?? messageId}`,
      account: tenantId,
      chat: {
        id: encodeTeamsChat({ type, id: conversationId }),
        kind: type === "personal" ? "dm" : "group",
        ...(activity.conversation.name ? { name: activity.conversation.name } : {}),
        members: [...members, self],
      },
      thread_id: type === "channel" && root && root !== messageId ? root : null,
    };
    const createdAt = activity.timestamp ?? new Date().toISOString();
    const posted = (body: string, user: GenericChatUser, mentions = false) => ({
      id: messageId,
      user,
      body,
      mentions_agent: mentions,
      app_post: user.bot === true,
      files: [],
      created_at: createdAt,
    });
    const mentioned = activity.entities?.some((e) => e.type === "mention" && e.mentioned?.id === activity.recipient.id);
    switch (activity.type) {
      case "message": {
        const clicked = actionId(activity.value);
        if (clicked)
          return { ...base, type: "action.invoked", message: posted("", self), action: { id: clicked, user: author } };
        return { ...base, type: "message.created", message: posted(messageText(activity), author, mentioned) };
      }
      case "messageUpdate":
        return { ...base, type: "message.updated", message: posted(messageText(activity), author, mentioned) };
      case "messageDelete":
        return { ...base, type: "message.deleted", message: posted("", author) };
      case "messageReaction": {
        const added = activity.reactionsAdded?.[0];
        const removed = activity.reactionsRemoved?.[0];
        const reaction = added ?? removed;
        if (!reaction) return null;
        return {
          ...base,
          type: added ? "reaction.added" : "reaction.removed",
          message: posted("", { id: "unknown" }),
          reaction: { name: reaction.type, user: author },
        };
      }
      default:
        return null;
    }
  }

  async function handle(authorization: string | undefined, rawBody: string): Promise<Reply> {
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch (e) {
      return { status: 400, body: { error: "invalid_json", detail: errMessage(e) } };
    }
    const parsed = activitySchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      console.log(`[teams] refused a malformed activity: ${issues.join("; ")}`);
      return { status: 400, body: { error: "bad_request", issues } };
    }
    const activity = parsed.data;
    const tenantId = activity.conversation.tenantId ?? activity.channelData?.tenant?.id;
    const tenant = tenantId ? await deps.app.tenantFor("teams_tenant", tenantId) : undefined;
    if (!tenant || !tenantId) {
      console.log(`[teams] ignoring an activity for Microsoft tenant ${tenantId}: no serving workspace is bound to it`);
      return { status: 404, body: { error: "unknown_account" } };
    }
    const outcome = await inTenant(tenant, async (): Promise<Reply | object | null> => {
      const bot = tenantSettings().teams;
      let refused = bot ? undefined : "this workspace has no Teams bot";
      if (bot && bot.tenantId !== tenantId) refused = `the workspace's bot belongs to Microsoft tenant ${bot.tenantId}`;
      if (bot && !refused) refused = await refusal(authorization, bot, activity);
      if (refused || !bot) {
        console.log(`[teams] refused a ${activity.type} activity for Microsoft tenant ${tenantId}: ${refused}`);
        return { status: 401, body: { error: "unauthorized" } };
      }
      return toEvent(activity, bot, tenantId);
    });
    if (outcome === null) {
      console.log(
        `[teams] ignoring a ${activity.type} activity in a ${activity.conversation.conversationType ?? "unknown"} conversation`,
      );
      return { status: 200, body: { ok: true, ignored: "activity" } };
    }
    if ("status" in outcome) return outcome as Reply;
    return deps.dispatch(outcome, tenant);
  }

  return { handle };
}
