import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createKeychain, type KeychainCredential, type OAuthToken } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap, createPostgresMap } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";

for (const backing of ["memory", "postgres"] as const) {
  test(
    `${backing}: disconnect, replacement and concurrent refresh preserve credential generation`,
    { skip: backing === "postgres" && !process.env.DATABASE_URL },
    async (t) => {
      const pg = backing === "postgres" ? createPgPool(process.env.DATABASE_URL!) : undefined;
      const table = `credential_refresh_${randomBytes(6).toString("hex")}`;
      const creds = pg ? createPostgresMap<KeychainCredential>(pg, table) : createMemoryMap<KeychainCredential>();
      t.after(async () => {
        if (pg) {
          await pg.q(`DROP TABLE IF EXISTS ${table}`);
          await pg.q("DELETE FROM durable_map_versions WHERE tbl = $1", [table]);
          await pg.close();
        }
      });
      const key = deriveConnectorKey("synthetic-credential-test-key");
      const deferred = () => {
        let release!: (token: OAuthToken) => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const result = new Promise<OAuthToken>((resolve) => {
          release = resolve;
        });
        return {
          ready,
          release,
          refresh: async () => {
            entered();
            return result;
          },
        };
      };
      const make = (refreshConnector: () => Promise<OAuthToken>) =>
        createKeychain({
          creds: pg ? createPostgresMap<KeychainCredential>(pg, table) : creds,
          grants: createMemoryMap(),
          asks: createMemoryMap(),
          key,
          now: () => 1000,
          refreshConnector,
        });
      const host = "auth.openai.com";
      const owner = "user_test";
      const old = { accessToken: "old", refreshToken: "refresh-old", expiresAt: 999 };
      const fresh = { accessToken: "new", refreshToken: "refresh-new", expiresAt: 1_000_000 };
      const flight = deferred();
      const first = make(flight.refresh);
      await first.setConnectorToken(host, owner, old);
      const load = first.connectorAccessToken(host, owner);
      await flight.ready;
      await first.deleteConnectorToken(host, owner);
      flight.release(fresh);
      assert.equal(await load, null);
      assert.equal((await first.connectorTokenStatus(host, owner)).connected, false);

      const replace = deferred();
      const second = make(replace.refresh);
      await second.setConnectorToken(host, owner, old);
      const stale = second.connectorAccessToken(host, owner);
      await replace.ready;
      await first.deleteConnectorToken(host, owner);
      await first.setConnectorToken(host, owner, { ...fresh, accessToken: "intentional-reconnect" });
      replace.release(fresh);
      assert.equal(await stale, "intentional-reconnect");

      const a = deferred();
      const b = deferred();
      const workerA = make(a.refresh);
      const workerB = make(b.refresh);
      await first.setConnectorToken(host, owner, old);
      const readA = workerA.connectorAccessToken(host, owner);
      const readB = workerB.connectorAccessToken(host, owner);
      await Promise.all([a.ready, b.ready]);
      b.release({ ...fresh, accessToken: "worker-b" });
      assert.equal(await readB, "worker-b");
      a.release({ ...fresh, accessToken: "worker-a" });
      assert.equal(await readA, "worker-b");
      assert.equal(await first.connectorAccessToken(host, owner), "worker-b");
      const input = {
        ownerId: owner,
        service: "codex",
        origin: "operator-codex-cli-login",
        files: [{ path: ".codex/auth.json", contentBase64: Buffer.from("same material").toString("base64") }],
      };
      const saved = await first.save(input);
      assert(saved.revision);
      await first.remove(owner, saved.id);
      await assert.rejects(first.save({ ...input, expectedRevision: saved.revision }), /disconnected/);
      const reconnected = await first.save(input);
      assert.notEqual(reconnected.revision, saved.revision);
      await assert.rejects(first.save({ ...input, expectedRevision: saved.revision }), /changed/);
      assert.equal((await first.getCredential(saved.id))?.revision, reconnected.revision);
      const rotated = await first.save({ ...input, origin: undefined, expectedRevision: reconnected.revision });
      assert.equal(rotated.origin, input.origin);
    },
  );
}
