import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { rekeyPlan } from "../src/identity/sign-in-rekey.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { memberBrainId } from "../src/memory/registry.ts";
import { hashId } from "../src/util/crypto.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const url = testDatabaseUrl();

test("linking moves the sign-in's records to the main id, and the main id's own record wins a conflict", async () => {
  const main = `main-${randomUUID().slice(0, 8)}@example.com`;
  const alias = `U-${randomUUID().slice(0, 8)}`;
  const session = `s-${randomUUID()}`;
  const sessions = createPostgresSessionStore(url);
  const maps = createPostgresMapFactory(url);
  const souls = maps.map<{ scopeId: string; content: string }>("soul_configs");
  const creds = maps.map<{ id: string; ownerId: string; service: string; managed: string }>("keychain_credentials");
  const projects = maps.map<{ id: string; ownerId: string; memberIds: string[] }>("projects");
  const registry = maps.map<{ brains: { id: string; owner: string }[] }>("memory_registry");
  const connector = (owner: string) => hashId([owner, "api.example.com", "oauth:"]);
  await Promise.all([sessions.get(session), maps.map("keychain_grants").get(session)]);
  await maps.pool.q("INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ($1, 'dm', $2, $1, 1)", [
    session,
    `personal:${alias}`,
  ]);
  await maps.pool.q("INSERT INTO participants(session_id, principal_id) VALUES ($1, $2), ($1, $3)", [
    session,
    alias,
    main,
  ]);
  await souls.put(`personal:${alias}`, { scopeId: `personal:${alias}`, content: "alias" });
  await souls.put(`personal:${main}`, { scopeId: `personal:${main}`, content: "main" });
  await creds.put(connector(alias), {
    id: connector(alias),
    ownerId: alias,
    service: "api.example.com",
    managed: "connector",
  });
  await projects.put(session, { id: session, ownerId: alias, memberIds: [alias, main] });
  await registry.put(session, { brains: [{ id: memberBrainId(alias), owner: alias }] });

  await createPostgresUserStore(url).link({
    principalId: alias,
    canonicalId: main,
    evidence: "qa",
    linkedBy: "",
    createdAt: 1,
  });

  const scope = await maps.pool.q("SELECT scope_id FROM sessions WHERE id = $1", [session]);
  const people = await maps.pool.q("SELECT principal_id FROM participants WHERE session_id = $1", [session]);
  assert.deepEqual([scope[0]?.scope_id, people.map((r) => r.principal_id)], [`personal:${main}`, [main]]);
  assert.deepEqual(
    [await souls.get(`personal:${alias}`), (await souls.get(`personal:${main}`))?.content],
    [null, "main"],
  );
  assert.deepEqual(
    [await creds.get(connector(alias)), (await creds.get(connector(main)))?.ownerId],
    [null, main],
    "a connector's id is recomputed from its new owner",
  );
  assert.deepEqual(await projects.get(session), { id: session, ownerId: main, memberIds: [main] });
  assert.deepEqual(await registry.get(session), { brains: [{ id: memberBrainId(main), owner: main }] });
  const tables = new Set([
    "participants",
    "sessions",
    "soul_configs",
    "keychain_credentials",
    "projects",
    "memory_registry",
  ]);
  assert.deepEqual(await maps.pool.q(rekeyPlan(tables)), [], "nothing is left to move");
});
