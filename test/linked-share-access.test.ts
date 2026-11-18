import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { installPrincipalLinks, ownsPersonalScope, recordForPerson } from "../src/directory/person.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { composioUserId, personAccounts } from "../src/api/routes/composio.ts";
import { canEditAppPermissions } from "../src/deploy/app-access.ts";
import { boundLoopCron } from "../src/loops/authority.ts";
import { ensureDefaultInboxLoops } from "../src/loops/inbox-loop.ts";
import { orgId } from "../src/config.ts";
import type { ScopeId } from "../src/types.ts";
import type { Cron } from "../src/triggers/types.ts";
import type { Loop } from "../src/loops/types.ts";
import type { LoopStore } from "../src/loops/loop-store.ts";
import { seedTestTenant } from "./support/test-tenant.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres store tests";
const CANON = "jo@acme.test";
const ALIAS = "oidc:issuer:jo";

before(async () => {
  installPrincipalLinks({
    canonical: (key) => (key === ALIAS ? CANON : undefined),
    aliases: (key) => (key === CANON ? [ALIAS] : []),
  });
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP SCHEMA public CASCADE");
  await p.query("CREATE SCHEMA public");
  await p.end();
  await seedTestTenant(URL);
});

after(() => installPrincipalLinks(null));

test(
  "a person's sessions show from every linked sign-in, once each, with the sign-in in use's own view",
  { skip },
  async () => {
    const store = createPostgresSessionStore(URL!);
    const tag = randomUUID();
    const old = await store.getOrCreateByThread(`web:${ALIAS}:${tag}-old`, "dm", `personal:${ALIAS}` as ScopeId);
    await store.addParticipant(old.id, ALIAS, `Before linking ${tag}`);
    await store.append({ sessionId: old.id }, { kind: "UserMessage", text: `hello ${tag}` });
    const both = await store.getOrCreateByThread(`web:${CANON}:${tag}-both`, "dm", `personal:${CANON}` as ScopeId);
    await store.addParticipant(both.id, ALIAS, "alias view");
    await store.addParticipant(both.id, CANON, "canonical view");
    await store.append({ sessionId: both.id }, { kind: "UserMessage", text: "both" });

    const fromCanon = (await store.listByParticipant(CANON)).filter((s) => s.id === old.id || s.id === both.id);
    assert.equal(fromCanon.length, 2);
    assert.equal(fromCanon.find((s) => s.id === both.id)?.title, "canonical view");
    assert.equal((await store.getForParticipant(both.id, ALIAS))?.title, "alias view");
    assert.equal((await store.getForParticipant(old.id, CANON))?.title, `Before linking ${tag}`);
    assert.equal((await store.visibleItems(old.id, CANON)).length, 1);
    assert.equal((await store.searchSessionTitles(CANON, `Before linking ${tag}`)).length, 1);

    await store.updateParticipantView(old.id, CANON, { pinned: true });
    const pinned = await store.listParticipantPage(CANON, { pinned: true, limit: 10 });
    assert.deepEqual(
      pinned.sessions.map((s) => s.id),
      [old.id],
    );
    const page = await store.listParticipantPage(CANON, { limit: 50 });
    assert.equal(page.sessions.filter((s) => s.id === both.id).length, 1);

    const stranger = `U-${tag}`;
    assert.equal(await store.getForParticipant(old.id, stranger), null);
    assert.equal((await store.listByParticipant(stranger)).length, 0);
    assert.equal((await store.visibleItems(old.id, stranger)).length, 0);
  },
);

test("a personal scope belongs to every linked sign-in and no one else", () => {
  assert.equal(ownsPersonalScope(`personal:${ALIAS}`, CANON), true);
  assert.equal(ownsPersonalScope(`personal:${CANON}`, ALIAS), true);
  assert.equal(ownsPersonalScope("personal:U2", CANON), false);
  assert.equal(ownsPersonalScope(`channel:${CANON}`, CANON), false);
  assert.equal(ownsPersonalScope("personal:U2", "U2"), true);
  assert.equal(canEditAppPermissions(`personal:${ALIAS}`, CANON), true);
  assert.equal(canEditAppPermissions("personal:U2", CANON), false);
});

test("a record under the sign-in in use wins, then the canonical one, then the most recent", async () => {
  const rows = new Map([
    [`personal:${ALIAS}`, { provider: "openai", at: 2 }],
    [`personal:${CANON}`, { provider: "anthropic", at: 1 }],
  ]);
  const read = (p: string) => Promise.resolve(rows.get(`personal:${p}`));
  assert.equal((await recordForPerson(ALIAS, read))?.provider, "openai");
  assert.equal((await recordForPerson(CANON, read))?.provider, "anthropic");
  rows.delete(`personal:${CANON}`);
  assert.equal((await recordForPerson(CANON, read))?.provider, "openai");
  assert.equal(await recordForPerson("U2", read), undefined);
});

test("Composio connections made under a linked sign-in's own user are found without re-keying", () => {
  const account = (id: string, principal: string, updated: string) => ({
    id,
    user_id: composioUserId(orgId(), principal),
    updated_at: updated,
    toolkit: { slug: "gmail" },
  });
  const accounts = [account("ca_alias", ALIAS, "2026-01-02"), account("ca_canon", CANON, "2026-01-01")];
  assert.deepEqual(
    personAccounts(CANON, accounts).map((a) => a.id),
    ["ca_canon"],
  );
  assert.deepEqual(
    personAccounts(ALIAS, accounts).map((a) => a.id),
    ["ca_alias"],
  );
  assert.deepEqual(
    personAccounts(CANON, [accounts[0]!]).map((a) => a.id),
    ["ca_alias"],
  );
  const other = account("ca_u2", "U2", "2026-01-01");
  assert.deepEqual(
    personAccounts("U2", [other]).map((a) => a.id),
    ["ca_u2"],
  );
});

test("a loop and its cron stay bound when written under different sign-ins of one person", async () => {
  const loop = { id: "l1", cronId: "c1", owner: ALIAS, ownerScopeId: `personal:${ALIAS}` } as Loop;
  const cron = { id: "c1", loopId: "l1", owner: CANON, ownerScopeId: `personal:${ALIAS}` } as Cron;
  assert.equal((await boundLoopCron(loop, { get: async () => cron }))?.id, "c1");
  await assert.rejects(boundLoopCron(loop, { get: async () => ({ ...cron, owner: "U2" }) }));
});

test("the default inbox loops kept under a linked sign-in are reused, not duplicated", async () => {
  const loops = ["gmail", "slack"].map(
    (source) => ({ id: source, owner: ALIAS, ownerScopeId: `personal:${ALIAS}`, surface: `inbox:${source}` }) as Loop,
  );
  const store = { list: async () => loops } as unknown as LoopStore;
  assert.deepEqual(
    (await ensureDefaultInboxLoops(store, CANON)).map((l) => l.id),
    ["gmail", "slack"],
  );
});
