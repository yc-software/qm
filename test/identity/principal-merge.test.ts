import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPrincipalLinkService } from "../../src/identity/principal-links.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import { createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { personalScope } from "../../src/types.ts";
import { testAdvisoryLock, testConfigStore, testDatabaseUrl } from "../support/test-database.ts";

const ALIAS = "oidc:1111111111111111111111111111111111111111111111111111111111111111:am9yZGFu";
const CANONICAL = "jordan@acme.test";
const ALIAS_SCOPE = personalScope(ALIAS);
const CANONICAL_SCOPE = personalScope(CANONICAL);

function stores() {
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore({ databaseUrl });
  return {
    db: createPgPool(databaseUrl),
    sessions: createPostgresSessionStore(databaseUrl),
    memory: createPostgresMemoryService(databaseUrl),
    crons: createCronStore(databaseUrl, { fires: createPostgresCronFireStore(databaseUrl) }),
    config,
    links: createPrincipalLinkService(databaseUrl, testAdvisoryLock(), {
      refreshScopes: async (ids) => {
        await Promise.all(ids.map((id) => config.refreshScope(id)));
      },
    }),
  };
}

async function personalSession(s: ReturnType<typeof stores>, principalId: string, ref: string) {
  const session = await s.sessions.getOrCreateByThread(`web:${principalId}:${ref}`, "dm", personalScope(principalId));
  await s.sessions.addParticipant(session.id, principalId);
  return session;
}

describe("linking a sign-in merges its data into the canonical principal", () => {
  it("moves sessions, memory, crons and personal settings to the canonical principal", async () => {
    const s = stores();
    const aliasSession = await personalSession(s, ALIAS, "a1");
    const canonicalSession = await personalSession(s, CANONICAL, "c1");
    await s.memory.capture(ALIAS_SCOPE, ["Alias fact"], Date.UTC(2026, 0, 1));
    await s.memory.capture(CANONICAL_SCOPE, ["Canonical fact"], Date.UTC(2026, 0, 2));
    const cron = await s.crons.create({
      schedule: { everyMs: 60_000 },
      action: "daily check-in",
      owner: ALIAS,
      createdBy: ALIAS,
      ownerScopeId: ALIAS_SCOPE,
      destination: { type: "web", target: aliasSession.threadRef, audienceScopeId: ALIAS_SCOPE },
    });
    await s.config.setInstructions(ALIAS_SCOPE, "alias guidance");

    await s.links.link({ principalId: ALIAS, canonicalId: CANONICAL, linkedBy: "admin" });

    const listed = await s.sessions.listByParticipant(CANONICAL);
    assert.deepEqual(listed.map((x) => x.id).toSorted(), [aliasSession.id, canonicalSession.id].toSorted());
    assert.deepEqual(await s.sessions.listByParticipant(ALIAS), []);
    const moved = await s.sessions.get(aliasSession.id);
    assert.equal(moved?.scopeId, CANONICAL_SCOPE);
    assert.equal((await s.sessions.getByThread(`web:${ALIAS}:a1`))?.id, aliasSession.id);

    assert.deepEqual((await s.memory.facts!(CANONICAL_SCOPE)).map((f) => f.text).toSorted(), [
      "Alias fact",
      "Canonical fact",
    ]);
    assert.deepEqual(await s.memory.facts!(ALIAS_SCOPE), []);

    const [owned] = await s.crons.byOwner(CANONICAL_SCOPE);
    assert.equal(owned?.id, cron.id);
    assert.equal(owned?.owner, CANONICAL);
    assert.equal(owned?.createdBy, CANONICAL);
    assert.deepEqual(owned?.destination, {
      type: "web",
      target: aliasSession.threadRef,
      audienceScopeId: CANONICAL_SCOPE,
    });
    assert.deepEqual(await s.crons.byOwner(ALIAS_SCOPE), []);

    assert.equal(s.config.getInstructions(CANONICAL_SCOPE), "alias guidance");
    assert.equal(s.config.getInstructions(ALIAS_SCOPE), null);
  });

  it("keeps the canonical principal's row when both accounts hold the same key", async () => {
    const s = stores();
    const shared = await s.sessions.getOrCreateByThread("web:shared:room", "dm", "group:room");
    await s.sessions.addParticipant(shared.id, ALIAS, "alias title");
    await s.sessions.addParticipant(shared.id, CANONICAL, "canonical title");
    await s.config.setInstructions(ALIAS_SCOPE, "alias guidance");
    await s.config.setInstructions(CANONICAL_SCOPE, "canonical guidance");
    const tidy = async (scope: string) => {
      const cron = await s.crons.create({
        schedule: { cron: "0 3 * * *" },
        action: "tidy memory",
        owner: scope === ALIAS_SCOPE ? ALIAS : CANONICAL,
        createdBy: scope === ALIAS_SCOPE ? ALIAS : CANONICAL,
        ownerScopeId: scope,
      });
      await s.db.q("INSERT INTO memory_tidy_profiles (id, cron_id) VALUES ($1, $2)", [scope, cron.id]);
      return cron;
    };
    await tidy(ALIAS_SCOPE);
    const canonicalTidy = await tidy(CANONICAL_SCOPE);

    await s.links.link({ principalId: ALIAS, canonicalId: CANONICAL, linkedBy: "admin" });

    assert.deepEqual(await s.sessions.participantsOf(shared.id), [CANONICAL]);
    assert.equal((await s.sessions.getForParticipant(shared.id, CANONICAL))?.title, "canonical title");
    assert.equal(s.config.getInstructions(CANONICAL_SCOPE), "canonical guidance");
    assert.equal(await s.config.getInstructionsDurable(ALIAS_SCOPE), null);
    assert.deepEqual(
      (await s.crons.byOwner(CANONICAL_SCOPE)).map((c) => c.id),
      [canonicalTidy.id],
      "the sign-in's managed cron goes with its dropped profile",
    );
    assert.deepEqual(await s.db.q("SELECT id, cron_id FROM memory_tidy_profiles"), [
      { id: CANONICAL_SCOPE, cron_id: canonicalTidy.id },
    ]);
  });

  it("merges into the canonical principal however the admin capitalised its email", async () => {
    const s = stores();
    const aliasSession = await personalSession(s, ALIAS, "a1");
    await s.memory.capture(ALIAS_SCOPE, ["Alias fact"], Date.UTC(2026, 0, 1));

    const link = await s.links.link({ principalId: ALIAS, canonicalId: "Jordan@Acme.Test", linkedBy: "admin" });

    assert.equal(link.canonicalId, CANONICAL);
    assert.deepEqual(
      (await s.sessions.listByParticipant(CANONICAL)).map((x) => x.id),
      [aliasSession.id],
    );
    assert.deepEqual(
      (await s.memory.facts!(CANONICAL_SCOPE)).map((f) => f.text),
      ["Alias fact"],
    );
  });

  it("unlinking leaves merged data with the canonical principal", async () => {
    const s = stores();
    const aliasSession = await personalSession(s, ALIAS, "a1");
    await s.memory.capture(ALIAS_SCOPE, ["Alias fact"], Date.UTC(2026, 0, 1));
    await s.links.link({ principalId: ALIAS, canonicalId: CANONICAL, linkedBy: "admin" });

    await s.links.unlink(ALIAS);

    assert.equal((await s.sessions.get(aliasSession.id))?.scopeId, CANONICAL_SCOPE);
    assert.deepEqual(
      (await s.sessions.listByParticipant(CANONICAL)).map((x) => x.id),
      [aliasSession.id],
    );
    assert.deepEqual(
      (await s.memory.facts!(CANONICAL_SCOPE)).map((f) => f.text),
      ["Alias fact"],
    );
    assert.deepEqual(await s.memory.facts!(ALIAS_SCOPE), []);
  });

  it("linking again after an unlink moves what the sign-in wrote in between", async () => {
    const s = stores();
    await s.links.link({ principalId: ALIAS, canonicalId: CANONICAL, linkedBy: "admin" });
    await s.links.unlink(ALIAS);
    const later = await personalSession(s, ALIAS, "later");
    await s.links.link({ principalId: ALIAS, canonicalId: CANONICAL, linkedBy: "admin" });
    await s.links.link({ principalId: ALIAS, canonicalId: CANONICAL, linkedBy: "admin" });
    assert.equal((await s.sessions.get(later.id))?.scopeId, CANONICAL_SCOPE);
  });
});
