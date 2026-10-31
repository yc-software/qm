import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { createControlService } from "../src/api/control-service.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL (a Postgres) to run the Postgres linked-identity membership test";

test(
  "pg: a linked identity manages its own cron in a private channel whose roster lists the linked email",
  { skip, timeout: 60_000 },
  async () => {
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "pg-linked-")), databaseUrl: databaseUrl! }),
    );
    try {
      const control = createControlService(built.app, built.scheduler, built.admin);
      const email = "person@example.com";
      const canonical = "oidc|person";
      const room = scopeId("channel", "C-room");
      const channel = { channelId: "C-room", name: "room", isPrivate: true };
      const destination = { type: "slack", target: "C-room", audienceScopeId: room } as const;
      const claims = (actorId: string): CapabilityClaims => ({
        actorId,
        scopeId: room,
        privateScope: true,
        destination,
        destinations: [{ key: "k-room", label: "#room", ...destination }],
        defaultDestinationKey: "k-room",
        exp: Date.now() + CAPABILITY_TTL_MS,
      });
      const makeCron = () =>
        built.app.createCron({
          title: "Room digest",
          action: "summarize the channel",
          schedule: { everyMs: 3_600_000 },
          owner: canonical,
          createdBy: canonical,
          ownerScopeId: room,
        });

      await built.app.upsertDirectory([{ principalId: email, displayName: "Person", type: "internal" }]);
      await built.app.upsertChannels([channel], [{ channelId: "C-room", principalId: email }]);
      await built.principalLinks.link({
        principalId: email,
        canonicalId: canonical,
        evidence: "test: verified sign-in",
        linkedBy: canonical,
      });
      assert.equal(await built.directory.get(canonical), null, "the directory row stays keyed by the linked email");

      const cron = await makeCron();
      const disabled = await control.setCronEnabled(cron.id, false, claims(canonical));
      assert.ok(disabled.ok, JSON.stringify(disabled));
      assert.equal((await built.app.getCron(cron.id))?.enabled, false);
      assert.equal(await built.app.authorizesCapabilityScope({ actorId: canonical, scopeId: room }), true);
      assert.equal((await control.deleteCron(cron.id, claims("someone-else"))).ok, false);
      const deleted = await control.deleteCron(cron.id, claims(canonical));
      assert.ok(deleted.ok, JSON.stringify(deleted));
      assert.equal(await built.app.getCron(cron.id), null);

      const kept = await makeCron();
      await built.app.upsertChannels([channel], []);
      assert.equal((await control.deleteCron(kept.id, claims(canonical))).ok, false, "removed from the room");
      assert.equal(await built.app.authorizesCapabilityScope({ actorId: canonical, scopeId: room }), false);

      await built.app.upsertChannels([channel], [{ channelId: "C-room", principalId: email }]);
      await built.principalLinks.unlink(email);
      assert.equal((await control.deleteCron(kept.id, claims(canonical))).ok, false, "no longer the same person");
      assert.equal(await built.app.authorizesCapabilityScope({ actorId: canonical, scopeId: room }), false);
      assert.ok(await built.app.getCron(kept.id));
    } finally {
      await built.runtime.stop();
    }
  },
);
