import assert from "node:assert/strict";
import test from "node:test";
import { seedTwinUsers, type TwinAdmin, type TwinSession } from "./live-slack/arga.ts";

const session: TwinSession = {
  runId: "run-1",
  baseUrl: "https://slack.example",
  adminUrl: "https://admin.example",
  proxyToken: "proxy",
  botToken: "xoxb-bot",
  signingSecret: "signing",
};

function fakeAdmin(stripQaFileWrite = false): TwinAdmin {
  let config: {
    users: Array<{ id: string; name: string; is_bot: boolean }>;
    tokens: Array<{ token: string; user_id: string; scopes: string[]; is_bot: boolean }>;
  } = {
    users: [{ id: "UBOT", name: "bot", is_bot: true }],
    tokens: [{ token: session.botToken, user_id: "UBOT", scopes: [], is_bot: true }],
  };
  return {
    async getConfig() {
      return config;
    },
    async patchConfig(partial: Record<string, unknown>) {
      config = {
        ...config,
        ...partial,
        users: (partial.users ?? config.users) as typeof config.users,
        tokens: (partial.tokens ?? config.tokens) as typeof config.tokens,
      };
      if (stripQaFileWrite) {
        config.tokens = config.tokens.map((token) =>
          token.token.includes("-qa-")
            ? { ...token, scopes: token.scopes.filter((scope) => scope !== "files:write") }
            : token,
        );
      }
      return { ok: true, config };
    },
  } as unknown as TwinAdmin;
}

test("Arga provisioning reads back bot and user scopes, including file writes", async () => {
  const seeded = await seedTwinUsers(fakeAdmin(), session, ["qa"]);
  assert.match(seeded.get("qa")!.token, /^xoxp-e2e-qa-/);
});

test("Arga provisioning fails closed when the twin omits a requested user scope", async () => {
  await assert.rejects(seedTwinUsers(fakeAdmin(true), session, ["qa"]), /qa token.*files:write/);
});
