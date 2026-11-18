import assert from "node:assert/strict";
import test from "node:test";
import {
  createLoginKeepAliveService,
  withLoginKeepAlive,
  type LoginKeepAliveProfile,
} from "../src/credentials/keep-alive.ts";
import type { Keychain, KeychainCredentialMeta } from "../src/credentials/keychain.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testMap, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";

const alice = scopeId("personal", "alice");

function fixture() {
  const logins: KeychainCredentialMeta[] = [];
  const store = testMap<LoginKeepAliveProfile>();
  const crons = createCronStore(testMap(), { fires: createPostgresCronFireStore(testDatabaseUrl()) });
  const calls: TurnRequest[] = [];
  const service = createLoginKeepAliveService({
    store,
    keychain: {
      listByOwner: async () => logins,
      listConnectorsByOwners: async () => new Map(),
      connectorAccessToken: async () => null,
    },
    timezone: async () => undefined,
    crons,
    scheduler: { notifyChanged: () => {} },
  });
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    crons,
    deliveries: createDeliveryStore(),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    idempotency: createIdempotencyStore(testMap()),
    skipFire: (cron) => service.skipFire(cron),
    run: async (request) => {
      calls.push(request);
      return { status: "silent" };
    },
  });
  const saved = { kind: "file", ownerId: "alice" } as KeychainCredentialMeta;
  const keychain = withLoginKeepAlive(
    { save: async () => saved, setConnectorToken: async () => {} } as unknown as Keychain,
    (ownerId) => service.ensure(ownerId),
  );
  return { logins, store, crons, calls, scheduler, keychain, saved };
}

test("saving a login or connecting an account arms one nightly keep-alive that runs only while there is something to keep", async () => {
  const f = fixture();
  await f.keychain.save({ ownerId: "alice", service: "aws" });
  await f.keychain.setConnectorToken("www.googleapis.com", "alice", { accessToken: "t" });
  assert.equal((await f.crons.list()).length, 1);
  const cron = (await f.crons.get((await f.store.get(alice))!.cronId!))!;
  assert.equal(cron.owner, "alice");
  assert.match(cron.schedule.cron!, /^\d+ 4 \* \* \*$/);

  await f.crons.update(cron.id, { schedule: { everyMs: 60_000 } });
  await f.scheduler.tick(Date.now() + 120_000);
  assert.equal(f.calls.length, 0);

  f.logins.push(f.saved);
  await f.scheduler.tick(Date.now() + 240_000);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.text, /\/v1\/keychain\/credentials\/:id\/check/);
});
