import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createDiscordCoreClient } from "../src/api/discord-core-client.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the Postgres Discord roster test";

const CHANNEL = "100000000000000401";

test(
  "pg: a Discord roster listing a member linked to a Slack principal resolves identity at read time",
  {
    skip,
    timeout: 60_000,
  },
  async () => {
    const org = `org-discord-roster-${randomUUID()}`;
    const previous = process.env.ORG_ID;
    process.env.ORG_ID = org;
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "pg-discord-roster-")), databaseUrl: databaseUrl! }),
    );
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const core = createDiscordCoreClient({
        app: built.app,
        identity: built.identity,
        runs: { onTerminal: () => {} },
      } as never);
      await built.app.upsertDirectory([{ principalId: "U-ana", displayName: "Ana", type: "internal" }]);
      await built.principalLinks.link({
        principalId: "discord:77",
        canonicalId: "U-ana",
        evidence: "test: verified link",
        linkedBy: "U-ana",
      });
      await core.syncDirectory([
        { principalId: "discord:77", displayName: "Ana", type: "internal" },
        { principalId: "discord:78", displayName: "Bo", type: "internal" },
      ]);
      assert.equal(
        await built.directory.get("discord:77"),
        null,
        "a linked Discord member has no directory row of its own",
      );
      await core.syncChannels(
        {
          channels: [{ channelId: CHANNEL, name: "leads", isPrivate: true }],
          members: [
            { channelId: CHANNEL, principalId: "discord:77" },
            { channelId: CHANNEL, principalId: "discord:78" },
          ],
          keep: [],
        },
        Date.now(),
      );
      assert.deepEqual(await built.directory.channelMemberIds(CHANNEL), ["discord:77", "discord:78"]);
      const people = await built.directory.conversationMembers("channel", CHANNEL);
      assert.deepEqual(people?.map((m) => m.principalId).sort(), ["U-ana", "discord:78"]);
      const reaches = async (actorId: string) =>
        (await built.directory.channelMember(CHANNEL, actorId)) &&
        (await built.app.authorizesCapabilityScope({ actorId, scopeId: `channel:${CHANNEL}` }));
      assert.equal(await reaches("discord:77"), true);
      assert.equal(await reaches("U-ana"), true);

      await built.principalLinks.unlink("discord:77");
      assert.equal(await reaches("U-ana"), false, "unlinking takes the channel from the Slack principal at once");
      assert.equal(await reaches("discord:77"), true, "and leaves it with the Discord account that was listed");
    } finally {
      await built.runtime.stop();
      for (const t of ["directory_sync", "directory_channels", "directory_channel_members", "directory_members"])
        await pool.query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
      await pool.end();
      if (previous === undefined) delete process.env.ORG_ID;
      else process.env.ORG_ID = previous;
    }
  },
);

test("pg: conversationMembers matches a roster email to a directory row regardless of case", { skip }, async () => {
  const org = `org-case-roster-${randomUUID()}`;
  const previous = process.env.ORG_ID;
  process.env.ORG_ID = org;
  const store = createPostgresDirectoryStore(databaseUrl!);
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query(
      "INSERT INTO directory_members (org_id, principal_id, display_name, display_name_lc, type) VALUES ($1, $2, 'Ana', 'ana', 'internal')",
      [org, "Ana@Example.com"],
    );
    await store.replaceChannels(
      [{ channelId: "C-case", name: "case" }],
      [{ channelId: "C-case", principalId: "ana@example.com" }],
      Date.now(),
    );
    const people = await store.conversationMembers("channel", "C-case");
    assert.deepEqual(
      people?.map((m) => m.principalId),
      ["Ana@Example.com"],
    );
  } finally {
    for (const t of ["directory_sync", "directory_channels", "directory_channel_members", "directory_members"])
      await pool.query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await pool.end();
    if (previous === undefined) delete process.env.ORG_ID;
    else process.env.ORG_ID = previous;
  }
});
