import { createExactSecretValueMasker } from "../../security/secret-masking.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { errMessage } from "../../util/errors.ts";
import { personIds, samePerson } from "../../directory/person.ts";
import { composioUserIds, credential, request as composioRequest } from "./composio.ts";
import type { ApiCtx } from "./route.ts";

export async function hasSlackAccount(ctx: ApiCtx): Promise<boolean> {
  for (const id of personIds(ctx.actor!.p)) {
    const record = await ctx.deps.slackAccounts?.get(id);
    if (record && samePerson(record.memberId, ctx.actor!.p)) return true;
  }
  return false;
}

export async function composioSlackConnection(ctx: ApiCtx) {
  const access = await credential(ctx);
  if (!access) return undefined;
  const request: typeof composioRequest = async (...args) => {
    try {
      return await composioRequest(...args);
    } catch (error) {
      const sanitized = new Error(createExactSecretValueMasker([access.key])(redactSecrets(errMessage(error))));
      throw sanitized;
    }
  };
  for (const id of personIds(access.principal)) {
    const record = await ctx.deps.slackAccounts?.get(id);
    if (!record || !samePerson(record.memberId, access.principal)) continue;
    const account = await request(ctx, access.key, `/connected_accounts/${encodeURIComponent(record.accountId)}`);
    if (
      account.id !== record.accountId ||
      !composioUserIds(access.principal).includes(String(account.user_id)) ||
      (account.toolkit as { slug?: string } | undefined)?.slug !== "slack" ||
      account.status !== "ACTIVE" ||
      account.is_disabled === true
    )
      continue;
    const proxy = async (method: string, payload?: Record<string, unknown>) => {
      const result = await request(ctx, access.key, "/tools/execute/proxy", {
        connected_account_id: record.accountId,
        endpoint: `https://slack.com/api/${method}`,
        method: method === "chat.postMessage" ? "POST" : "GET",
        ...(method === "chat.postMessage"
          ? { body: payload, parameters: [{ name: "Content-Type", value: "application/json", in: "header" }] }
          : {
              parameters: Object.entries(payload ?? {}).map(([name, value]) => ({
                name,
                value: String(value),
                in: "query",
              })),
            }),
      });
      return result.data as
        { ok?: boolean; bot_id?: string; user_id?: string; team_id?: string; ts?: string; error?: string } | undefined;
    };
    const identity = await proxy("auth.test");
    const installation = await ctx.deps.slackInstallation?.get();
    if (
      !identity?.ok ||
      identity.bot_id ||
      identity.user_id !== record.userId ||
      identity.team_id !== record.teamId ||
      (installation?.teamId && identity.team_id !== installation.teamId)
    )
      continue;
    return { call: proxy, user: record.user, workspace: record.workspace };
  }
  return null;
}
