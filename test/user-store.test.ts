import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { foldPrincipalId, installPrincipalLinks } from "../src/directory/person.ts";
import { createPrincipalLinkService, PrincipalLinkError } from "../src/identity/principal-links.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresUserStore, fold, type UserStore } from "../src/identity/user-store.ts";
import { personLabel, UNKNOWN_PERSON } from "../src/identity/person-names.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";
import { testAdvisoryLock, testMigratedDatabaseUrl } from "./support/test-database.ts";
import { recordUser } from "../src/core/orchestrator/intake.ts";
import { appUrl, ownerUrl } from "./support/test-tenant.ts";
import { withTenant } from "../src/tenants/context.ts";

const url = testMigratedDatabaseUrl();
const store = (): UserStore => createPostgresUserStore(url);
const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}@example.com`;

test("a person joins the roster once, folded to one row, and keeps their first arrival", async () => {
  const pat = unique("pat");
  const roster = store();
  await roster.record({ id: pat.toUpperCase(), source: "turn", at: Date.now() });
  const row = (await roster.get(pat))!;
  assert.deepEqual([row.principalId, row.source], [pat, "turn"]);
  assert.match(row.id, /^[0-9a-f-]{36}$/, "the user's key is a generated id, not the sign-in");
  assert.equal(typeof row.firstSeenAt, "number");
  await roster.record({ id: pat, source: "admin", at: Date.now() });
  assert.deepEqual([(await roster.get(pat))!.source, (await roster.get(pat))!.firstSeenAt], ["turn", row.firstSeenAt]);
  assert.equal((await roster.list()).filter((u) => u.principalId === pat).length, 1);
});

test("a user is a person until QM records it as an app by its own sign-in; then what its sign-ins made is bot work, and a person's is not", async () => {
  const [roster, pg] = [store(), createPgPool(url)];
  const [bot, synced, pat, absent] = [unique("bot"), unique("synced"), unique("pat"), unique("absent")];
  const [split, kim] = [unique("split"), unique("kim")];
  for (const id of [bot, synced, pat]) await roster.record({ id, source: "turn", at: 1 });
  await createPostgresDirectoryStore(url).replace([
    { principalId: kim, displayName: "Kim", type: "internal", isBot: false },
  ]);
  for (const [alias, person] of [
    [split, pat],
    [kim, synced],
  ] as const)
    await roster.link({ principalId: alias, canonicalId: person, evidence: "admin", linkedBy: "", createdAt: 1 });
  const creators = { crons: "createdBy", monitors: "createdBy", keychain_asks: "requesterId", loops: "createdBy" };
  const put = (table: string, id: string, json: object) =>
    pg.q(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [id, { id, ownerScopeId: "channel:C1", ...json }]);
  const shipActions = [{ action: "send_email", gate: "auto" }];
  for (const [table, creator] of Object.entries(creators))
    for (const who of [bot, pat]) await put(table, who, { [creator]: who, shipActions });
  for (const who of [bot, synced, pat]) await put("loop_ship_grants", who, { loopId: pat, actorId: who });
  await put("loops", "marked", { createdBy: bot, botActor: true, shipActions });
  await put("loops", "pats-bot-loop", { createdBy: pat, botActor: true, shipActions });
  await put("loops", split, { createdBy: split, shipActions });
  await put("loop_ship_grants", split, { loopId: pat, actorId: split });
  await put("loops", "kims-bot-loop", { createdBy: kim, botActor: true, shipActions });
  const rowsSql = `SELECT concat_ws(' ', t, id, json ->> 'botActor', json #>> '{shipActions,0,gate}', json ->> 'revokedBy') AS r
    FROM (${[...Object.keys(creators), "loop_ship_grants"].map((t) => `SELECT '${t}' t, * FROM ${t}`).join(" UNION ")}) x`;
  const rows = async () => (await pg.q(rowsSql)).map((r) => r.r as string).sort();
  const bots = (t: string) => `${t} ${bot} true ${t === "loops" ? "hold" : "auto"}`;
  const made = [
    ...Object.keys(creators).flatMap((t) => [bots(t), `${t} ${pat} auto`]),
    "loops marked true hold",
    "loops pats-bot-loop true auto",
    "loops kims-bot-loop true auto",
  ];
  const splitRows = (marked: boolean) =>
    marked
      ? [`loops ${split} true hold`, `loop_ship_grants ${split} system`]
      : [`loops ${split} auto`, `loop_ship_grants ${split}`];
  const grants = (...apps: string[]) =>
    [bot, synced, pat].map((who) => `loop_ship_grants ${who}${apps.includes(who) ? " system" : ""}`);
  assert.equal((await roster.get(bot))?.kind, "person");
  await recordUser(roster, bot, true);
  assert.equal((await roster.get(bot))?.kind, "app");
  assert.deepEqual(await rows(), [...made, ...splitRows(false), ...grants(bot)].sort());
  await roster.applyDirectoryBots(
    [synced, bot, absent, split].map(
      (principalId) => ({ principalId, displayName: principalId, type: "internal", isBot: true }) as const,
    ),
  );
  assert.deepEqual(await rows(), [...made, ...splitRows(true), ...grants(bot, synced)].sort());
  assert.equal(await roster.get(absent), null, "marking never creates a row");
  await roster.link({ principalId: absent, canonicalId: pat, evidence: "admin", linkedBy: "", createdAt: Date.now() });
  assert.deepEqual([await roster.markApps([absent]), (await roster.get(pat))?.kind], [0, "person"]);
  const audit = `SELECT string_agg(action || ' ' || resource, ', ' ORDER BY action, resource) AS r FROM audit_log
    WHERE principal_id = 'system'`;
  const logged = `loop_update ${bot}, loop_update marked, loop_update ${split}, ship_grant_revoke ${bot}, ship_grant_revoke ${split}, ship_grant_revoke ${synced}`;
  assert.equal((await pg.q(audit))[0]!.r, logged);
  await pg.close();
});

test("a link refuses an app user unless its directory row says it is a person, the merge keeps a person, and what a sign-in made becomes bot work when it joins an app", async () => {
  const app = `U-${randomUUID().slice(0, 8)}`;
  const [pat, sam, kit, lee] = [unique("pat"), unique("sam"), unique("kit"), unique("lee")];
  const [roster, db] = [store(), createPgPool(url)];
  for (const id of [app, sam, kit]) await roster.record({ id, source: "turn", at: Date.now() });
  await roster.markApps([app, sam]);
  const link = { principalId: app, canonicalId: pat, evidence: "admin", linkedBy: "", createdAt: Date.now() };
  await assert.rejects(roster.link(link), PrincipalLinkError);
  await createPostgresDirectoryStore(url).replace(
    [app, sam].map((principalId) => ({ principalId, displayName: "Sam", type: "internal", isBot: false }) as const),
  );
  await roster.link(link);
  assert.deepEqual([(await roster.get(app))?.principalId, (await roster.get(pat))?.kind], [pat, "person"]);
  const auto = { ownerScopeId: "channel:C1", shipActions: [{ gate: "auto" }] };
  for (const who of [kit, lee]) {
    await db.q("INSERT INTO loops (id, json) VALUES ($1, $2)", [who, { ...auto, createdBy: who }]);
    await db.q("INSERT INTO loop_ship_grants (id, json) VALUES ($1, $2)", [who, { loopId: who, actorId: who }]);
    await roster.link({ ...link, principalId: who, canonicalId: sam });
  }
  const held = `SELECT id FROM loops l WHERE json @> '{"botActor": true, "shipActions": [{"gate": "hold"}]}'
    AND EXISTS (SELECT 1 FROM loop_ship_grants g WHERE g.id = l.id AND g.json ->> 'revokedBy' = 'system')`;
  assert.equal((await db.q(`${held} AND id = ANY($1)`, [[kit, lee]])).length, 2);
});

test("offboarding sets offboarded_at once; reactivation clears it", async () => {
  const leaver = unique("leaver");
  const roster = store();
  const first = await roster.markOffboarded(leaver, "admin-alice");
  assert.equal(first.offboardedBy, "admin-alice");
  assert.equal(typeof first.offboardedAt, "number");
  const retry = await roster.markOffboarded(leaver.toUpperCase(), "admin-bob");
  assert.deepEqual([retry.offboardedAt, retry.offboardedBy], [first.offboardedAt, "admin-alice"]);

  await roster.record({ id: leaver, source: "turn", at: Date.now() });
  const seen = (await roster.get(leaver))!;
  assert.deepEqual([seen.offboardedBy, seen.source], ["admin-alice", "turn"], "a first arrival keeps the offboarding");

  const back = await roster.markReactivated(leaver);
  assert.deepEqual([back?.offboardedAt, back?.source], [undefined, "turn"]);
  const stranger = unique("stranger");
  assert.equal(await roster.markReactivated(stranger), null);
  assert.equal(await roster.get(stranger), null, "reactivating a stranger adds no row");
});

test("linking merges the sign-in's row into its user, and later writes for it land on that user", async () => {
  const sam = unique("sam");
  const slack = unique("sam-alt");
  const backing = store();
  const links = createPrincipalLinkService(backing, testAdvisoryLock());
  const roster = backing;
  const db = createPgPool(url);
  const rowIds = async () =>
    (await db.q("SELECT primary_alias FROM users WHERE primary_alias = ANY($1)", [[sam, slack]]))
      .map((r) => r.primary_alias as string)
      .sort();
  await roster.record({ id: sam, source: "admin", at: 200 });
  await roster.record({ id: slack, source: "turn", at: 150 });
  const { offboardedAt: slackOffboarded } = await backing.markOffboarded(slack, "admin-bob");
  await new Promise((r) => setTimeout(r, 5));
  await backing.markOffboarded(sam, "admin-alice");
  assert.deepEqual(await rowIds(), [sam, slack].sort(), "before the link they are two users");

  installPrincipalLinks(links);
  try {
    await links.link({ principalId: slack, canonicalId: sam, evidence: "qa", linkedBy: "admin-alice" });
    assert.deepEqual(await rowIds(), [sam], "the sign-in's row is merged away");
    const merged = (await roster.get(sam))!;
    assert.deepEqual(
      [merged.firstSeenAt, merged.source, merged.offboardedAt, merged.offboardedBy],
      [150, "turn", slackOffboarded, "admin-bob"],
      "earliest arrival and earliest offboarding win",
    );
    assert.equal((await roster.get(slack))?.principalId, sam, "the sign-in reads as its user");
    assert.equal((await roster.get(slack))?.id, (await roster.get(sam))?.id);

    await backing.record({ id: slack, source: "turn", at: 1 });
    await backing.markOffboarded(slack, "admin-carol");
    assert.deepEqual(await rowIds(), [sam], "writes under the sign-in resolve to the user");
    assert.equal((await roster.markReactivated(slack))?.offboardedAt, undefined);

    const ghost = unique("ghost");
    const other = `U-${randomUUID().slice(0, 8)}`;
    await links.link({ principalId: other, canonicalId: ghost, evidence: "qa", linkedBy: "admin-alice" });
    assert.ok(
      (await db.q("SELECT 1 FROM users WHERE primary_alias = $1", [ghost])).length,
      "linking to someone new creates their user",
    );
    assert.equal(
      (await roster.list()).some((u) => u.principalId === ghost),
      false,
      "but a user nobody has met is not listed",
    );

    await links.unlink(slack);
    assert.deepEqual(await rowIds(), [sam], "unlinking keeps the merged row with the user");
    assert.equal(await links.unlink(ghost), null, "a user's own primary sign-in is not a link to remove");
    await assert.rejects(
      db.query("UPDATE users SET primary_alias = $1 WHERE primary_alias = $2", [unique("nobody"), ghost]),
      /users_primary_alias_link/,
      "a user's primary sign-in must be one of their own links",
    );
  } finally {
    installPrincipalLinks(null);
  }
});

test("the SQL fold matches foldPrincipalId", async () => {
  const db = createPgPool(url);
  for (const id of ["Pat@Example.COM", "  pat@example.com ", "U01ABC", " U01abc ", "oidc:AbC:dEf", "Mixed@Case"]) {
    const [row] = await db.q(`SELECT ${fold("$1::text")} AS folded`, [id]);
    assert.equal(row!.folded, foldPrincipalId(id), id);
  }
});

test("the same sign-in is a separate user in each tenant, and a link stays in its tenant", async () => {
  const owner = createPgPool(ownerUrl(url).toString());
  const [a, b] = [randomUUID(), randomUUID()];
  await owner.q("INSERT INTO tenants(id) VALUES ($1), ($2)", [a, b]);
  const roster = createPostgresUserStore(appUrl(url));
  const pat = unique("pat");
  const alias = `U-${randomUUID().slice(0, 8)}`;
  try {
    await withTenant(a, () => roster.record({ id: pat, source: "turn", at: Date.now() }));
    await withTenant(b, () => roster.record({ id: pat, source: "invite", at: Date.now() }));
    const inA = (await withTenant(a, () => roster.get(pat)))!;
    const inB = (await withTenant(b, () => roster.get(pat)))!;
    assert.deepEqual([inA.source, inB.source], ["turn", "invite"]);
    await withTenant(a, () =>
      roster.link({ principalId: alias, canonicalId: pat, evidence: "test", linkedBy: "", createdAt: Date.now() }),
    );
    const linked = async (tenant: string) =>
      (await withTenant(tenant, () => roster.links())).filter((l) => l.principalId === alias).map((l) => l.canonicalId);
    assert.deepEqual(await linked(a), [pat]);
    assert.deepEqual(await linked(b), []);
  } finally {
    await owner.q("DELETE FROM users WHERE tenant_id = ANY($1::uuid[])", [[a, b]]);
    await owner.q("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [[a, b]]);
    await owner.close();
  }
});

test("activity is one row per user across every linked sign-in, counting only the turns each person wrote", async () => {
  const sessions = createPostgresSessionStore(url);
  const roster = store();
  const pat = unique("pat");
  const slack = `U-${randomUUID().slice(0, 8)}`;
  const quiet = `U-${randomUUID().slice(0, 8)}`;
  const stranger = `U-${randomUUID().slice(0, 8)}`;
  await roster.record({ id: pat, source: "turn", at: 1 });
  await roster.record({ id: slack, source: "turn", at: 2 });
  await roster.link({ principalId: slack, canonicalId: pat, evidence: "qa", linkedBy: "", createdAt: Date.now() });
  await roster.record({ id: quiet, source: "turn", at: 3 });
  await roster.markApps([quiet]);

  const dm = await sessions.getOrCreateByThread(`dm:${randomUUID()}`, "dm", scopeId("personal", pat));
  const channel = await sessions.getOrCreateByThread(`ch:${randomUUID()}`, "channel", scopeId("channel", "C1"));
  await sessions.addParticipant(dm.id, pat.toUpperCase());
  await sessions.addParticipant(channel.id, pat);
  await sessions.addParticipant(channel.id, slack);
  await sessions.addParticipant(channel.id, quiet);
  const first = await sessions.append(
    { sessionId: dm.id },
    { kind: "UserMessage", text: "hi", author: pat.toUpperCase() },
  );
  await sessions.append({ sessionId: dm.id }, { kind: "AgentMessage", text: "hello" });
  await sessions.append(
    { sessionId: channel.id },
    { kind: "UserMessage", text: "chatter", author: pat, body: { overheard: true } },
  );
  await sessions.addParticipant(channel.id, stranger);
  const last = await sessions.append(
    { sessionId: channel.id },
    { kind: "SteeringMessage", text: "also", author: slack },
  );
  await sessions.removeParticipant(channel.id, quiet);

  const rows = await roster.activity();
  const user = (await roster.get(pat))!;
  const mine = rows.filter((r) => r.principalId === pat);
  assert.equal(mine.length, 1, "the email and Slack sign-ins are one row");
  assert.deepEqual(
    { ...mine[0]!, days: undefined },
    {
      userId: user.id,
      principalId: pat,
      kind: "person",
      sessions: 2,
      turns: 2,
      lastSeenAt: last.createdAt,
      days: undefined,
    },
    "both sessions once; turns written under either sign-in count once each; agent and overheard excluded",
  );
  assert.deepEqual(mine[0]!.days, [
    ...new Set([first.createdAt, last.createdAt].map((t) => Math.floor(t / 86_400_000))),
  ]);
  assert.equal(
    rows.some((r) => r.principalId === quiet),
    false,
    "a participant who left is not credited",
  );
  assert.deepEqual(
    rows.filter((r) => r.principalId === stranger).map((r) => [r.userId, r.kind, r.sessions, r.turns]),
    [[null, "person", 1, 0]],
    "a participant with no user row still counts, under their own sign-in, but is not credited with others' turns",
  );
});

test("resolve and get find a user by any sign-in or by its id, with every sign-in listed primary first", async () => {
  const roster = store();
  const pat = unique("pat");
  const slack = `U-${randomUUID().slice(0, 8)}`;
  await roster.record({ id: pat, source: "turn", at: 1 });
  await roster.link({ principalId: slack, canonicalId: pat, evidence: "qa", linkedBy: "", createdAt: Date.now() });
  const user = (await roster.get(pat))!;
  assert.deepEqual(user.aliases, [pat, slack]);
  assert.deepEqual(await roster.get(user.id), user);
  assert.deepEqual(await roster.get(` ${pat.toUpperCase()} `), user);
  const resolved = await roster.resolve([slack, pat.toUpperCase(), "nobody@example.com", ""]);
  assert.deepEqual(
    [...resolved].map(([alias, u]) => [alias, u.id]).sort(),
    [
      [pat.toUpperCase(), user.id],
      [slack, user.id],
    ].sort(),
  );
  assert.equal(await roster.get(randomUUID()), null);
});

test("a person's display name is stored once per user, refreshed when it changes, and shared by every linked sign-in", async () => {
  const email = unique("named");
  const oidc = `oidc:issuer:${randomUUID().slice(0, 8)}`;
  const roster = store();
  await roster.link({ principalId: oidc, canonicalId: email, evidence: "sso", linkedBy: "", createdAt: 0 });
  assert.equal((await roster.get(oidc))?.displayName, undefined);
  assert.equal(await roster.setDisplayName(oidc, "  Ada\u0000 \n Lovelace  "), true);
  assert.equal((await roster.get(email))?.displayName, "Ada Lovelace");
  assert.equal(
    await roster.setDisplayName(email.toUpperCase(), "Ada Lovelace"),
    false,
    "an unchanged name is not rewritten",
  );
  assert.equal(await roster.setDisplayName(oidc, "   "), false, "a blank name never clears a stored one");
  assert.equal(await roster.setDisplayName(oidc, "Ada King"), true);
  assert.equal((await roster.resolve([oidc])).get(oidc)?.displayName, "Ada King");
  await roster.setDisplayName(oidc, "x".repeat(500));
  assert.equal((await roster.get(oidc))?.displayName?.length, 200);
});

test("linking keeps the name a sign-in already had, and labels fall back to an email, never to a raw sign-in", async () => {
  const email = unique("label");
  const oidc = `oidc:issuer:${randomUUID().slice(0, 8)}`;
  const roster = store();
  await roster.setDisplayName(oidc, "Grace Hopper");
  await roster.record({ id: email, source: "turn", at: Date.now() });
  await roster.link({ principalId: oidc, canonicalId: email, evidence: "sso", linkedBy: "", createdAt: 0 });
  assert.equal(personLabel(email, { user: await roster.get(email) }), "Grace Hopper");
  const bare = `oidc:issuer:${randomUUID().slice(0, 8)}`;
  await roster.record({ id: bare, source: "turn", at: Date.now() });
  assert.equal(personLabel(bare, { user: await roster.get(bare) }), UNKNOWN_PERSON);
  const mailOnly = unique("mail");
  await roster.link({ principalId: bare, canonicalId: mailOnly, evidence: "sso", linkedBy: "", createdAt: 0 });
  assert.equal(personLabel(bare, { user: await roster.get(bare) }), mailOnly);
});
