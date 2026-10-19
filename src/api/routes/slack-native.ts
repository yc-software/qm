import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { redactSecrets } from "../../harness/redact-secrets.ts";
import { errMessage } from "../../util/errors.ts";
import { ErrorCode, type WebAPIPlatformError, type AuthTestResponse } from "@slack/web-api";
import { slackWebClient } from "../../slack/web-client.ts";
import { personIds, samePerson } from "../../directory/person.ts";
import { resolverFor } from "./connectors.ts";
import type { ApiCtx } from "./route.ts";

export async function nativeSlackConfigured(ctx: ApiCtx): Promise<boolean> {
  try {
    await resolverFor(ctx.deps)("slack", {});
    return Boolean(ctx.deps.connectorTokens);
  } catch {
    return false;
  }
}

export async function nativeSlackConnection(ctx: ApiCtx) {
  const principal = ctx.actor!.p;
  for (const id of personIds(principal)) {
    for (const accountType of ["default", "personal", "company"]) {
      const auth = await ctx.deps.connectorTokens?.connectorDerivedAuth("slack.com", id, accountType);
      if (!auth) continue;
      const call = async (method: string, payload?: Record<string, unknown>, token = auth.accessToken) => {
        const client = slackWebClient(token, ctx.deps.slackWebClient);
        try {
          return (await client.apiCall(method, payload)) as AuthTestResponse & { ts?: string };
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === ErrorCode.PlatformError)
            return (error as WebAPIPlatformError).data as AuthTestResponse & { ts?: string };
          const sanitized = new Error(createExactSecretValueMasker([token])(redactSecrets(errMessage(error))));
          throw sanitized;
        }
      };
      const identity = await call("auth.test");
      if (!identity.ok || identity.bot_id || !identity.user_id || !identity.team_id) continue;
      const members = (await ctx.deps.directory?.list()) ?? [];
      const member = members.find(
        (m) =>
          (m.slackId === identity.user_id || m.principalId === identity.user_id) &&
          samePerson(m.principalId, principal),
      );
      if (!member || member.type !== "internal") continue;
      const installation = await ctx.deps.slackInstallation?.get();
      let teamId = installation?.teamId;
      if (!teamId && ctx.deps.slackEnvBotToken) {
        const bot = await call("auth.test", undefined, ctx.deps.slackEnvBotToken);
        if (bot.ok) teamId = bot.team_id;
      }
      if (!teamId || teamId !== identity.team_id) continue;
      return { call, user: identity.user ?? member.displayName, workspace: identity.team };
    }
  }
  return null;
}
