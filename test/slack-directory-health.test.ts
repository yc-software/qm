import { test } from "node:test";
import assert from "node:assert";
import { createDirectory } from "../src/slack/directory.ts";
import type { BotIdentity } from "../src/slack/directory.ts";

function ids(extra: Partial<BotIdentity> = {}): BotIdentity {
  return {
    ownTeamId: "T1",
    botUserId: "U1",
    ownBotId: "B1",
    botHandle: "qm",
    ownWorkspaceUrl: "https://x.slack.com",
    identityMode: "email",
    ...extra,
  } as BotIdentity;
}

function coreStub() {
  const health: any[] = [];
  const pushes: any[] = [];
  const core: any = {
    reportSurfaceHealth: async (patch: any) => {
      health.push(patch);
    },
    pushDirectory: async (body: any) => {
      pushes.push(body);
    },
  };
  return { core, health, pushes };
}

function clientWith(list: () => AsyncIterable<any>, infoError?: string) {
  const calls: any[] = [];
  return {
    calls,
    paginate(method: string, args: any) {
      calls.push({ method, args });
      if (method === "conversations.list") return list();
      return (async function* () {
        yield { members: [{ id: "U1", team_id: "T1", profile: { email: "a@b.c" }, name: "a" }] };
      })();
    },
    conversations: {
      info: async () => {
        if (infoError) {
          const e: any = new Error(`An API error occurred: ${infoError}`);
          e.data = { error: infoError };
          throw e;
        }
        return { channel: { name: "general" } };
      },
      members: async () => ({ members: [] }),
    },
  };
}

test("a failed channel list reports unhealthy sync state instead of only logging", async () => {
  const { core, health } = coreStub();
  const dir = createDirectory({ core, ids: ids() });
  const client = clientWith(() =>
    // eslint-disable-next-line require-yield
    (async function* () {
      const e: any = new Error("An API error occurred: missing_scope");
      e.data = { error: "missing_scope" };
      throw e;
    })(),
  );
  await dir.forceDirectorySync(client);
  const sync = health.find((h) => h.lastSyncOk === false);
  assert.ok(sync, "unhealthy sync reported");
  assert.match(sync.lastSyncError, /missing_scope/);
});

test("a successful sync reports healthy state with the channel count", async () => {
  const { core, health } = coreStub();
  const dir = createDirectory({ core, ids: ids() });
  const client = clientWith(() =>
    (async function* () {
      yield { channels: [{ id: "C9", name: "general", is_member: true }] };
    })(),
  );
  await dir.forceDirectorySync(client);
  const sync = health.findLast((h) => h.lastSyncOk === true);
  assert.ok(sync, "healthy sync reported");
  assert.equal(sync.channelsSynced, 1);
  assert.equal(sync.lastSyncError, "");
});

test("conversations.info failures are reported, not silently swallowed", async () => {
  const { core, health } = coreStub();
  const dir = createDirectory({ core, ids: ids() });
  const client = clientWith(
    () =>
      (async function* () {
        yield { channels: [] };
      })(),
    "channel_not_found",
  );
  const info = await dir.getChannelInfo(client, "C123");
  assert.equal(info, undefined);
  assert.ok(health.some((h) => /channel_not_found/.test(h.lastChannelInfoError ?? "")));
});

test("org-wide (Enterprise Grid) installs pass team_id to conversations.list", async () => {
  const { core } = coreStub();
  const dir = createDirectory({ core, ids: ids({ isEnterpriseInstall: true }) });
  const client = clientWith(() =>
    (async function* () {
      yield { channels: [] };
    })(),
  );
  await dir.forceDirectorySync(client);
  const listCall = client.calls.find((c: any) => c.method === "conversations.list");
  assert.ok(listCall, "conversations.list called");
  assert.equal(listCall.args.team_id, "T1");
});

test("workspace-level installs do not pass team_id", async () => {
  const { core } = coreStub();
  const dir = createDirectory({ core, ids: ids() });
  const client = clientWith(() =>
    (async function* () {
      yield { channels: [] };
    })(),
  );
  await dir.forceDirectorySync(client);
  const listCall = client.calls.find((c: any) => c.method === "conversations.list");
  assert.ok(listCall, "conversations.list called");
  assert.equal(listCall.args.team_id, undefined);
});
