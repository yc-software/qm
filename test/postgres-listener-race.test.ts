import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import assert from "node:assert/strict";

class FakeClient extends EventEmitter {
  queries: string[] = [];
  releases = 0;
  afterQuery?: () => void;

  query(sql: string) {
    this.queries.push(sql);
    const result = Promise.resolve({ rows: [] });
    this.afterQuery?.();
    return result;
  }

  release() {
    this.releases++;
  }
}

interface FakePool {
  connect(): Promise<FakeClient>;
  closes: number;
}

const pools = new Map<string, FakePool>();
mock.module("../src/persistence/pg-pool.ts", {
  namedExports: {
    createPgPool(url: string) {
      const pool = pools.get(url)!;
      return {
        sessionPool: async () => pool,
        close: async () => {
          pool.closes++;
        },
      };
    },
  },
});
const { subscribePostgresChannel } = await import("../src/persistence/postgres-listener.ts");

async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("reconnect repeats LISTEN when the old client disconnects before its query continuation", async () => {
  const clients = [new FakeClient(), new FakeClient()];
  clients[0]!.afterQuery = () => clients[0]!.emit("error", new Error("connection lost"));
  let attempts = 0;
  const pool = { closes: 0, connect: async () => clients[attempts++]! };
  pools.set("listen-race", pool);
  let resyncs = 0;
  const payloads: string[] = [];
  const stop = subscribePostgresChannel(
    "listen-race",
    "events",
    (value) => payloads.push(value),
    () => resyncs++,
  );
  try {
    await until(() => resyncs === 1);
    assert.equal(attempts, 2);
    assert.deepEqual(
      clients.map((client) => client.queries),
      [["LISTEN events"], ["LISTEN events"]],
    );
    clients[1]!.emit("notification", { channel: "events", payload: "recovered" });
    assert.deepEqual(payloads, ["recovered"]);
  } finally {
    await stop();
  }
  assert.deepEqual(
    clients.map((client) => client.releases),
    [1, 1],
  );
  assert.equal(pool.closes, 1);
});

test("failed acquisition retries and closes the recovered connection", async () => {
  const client = new FakeClient();
  let attempts = 0;
  const pool = {
    closes: 0,
    async connect() {
      if (++attempts === 1) throw new Error("database unavailable");
      return client;
    },
  };
  pools.set("acquire-retry", pool);
  let resyncs = 0;
  const stop = subscribePostgresChannel(
    "acquire-retry",
    "events",
    () => {},
    () => resyncs++,
  );
  try {
    await until(() => resyncs === 1);
    assert.equal(attempts, 2);
    assert.deepEqual(client.queries, ["LISTEN events"]);
  } finally {
    await stop();
  }
  assert.equal(client.releases, 1);
  assert.equal(pool.closes, 1);
});

for (const fails of [false, true]) {
  test(`unsubscribe during acquisition closes resources when acquisition ${fails ? "fails" : "succeeds"}`, async () => {
    const acquired = Promise.withResolvers<FakeClient>();
    const client = new FakeClient();
    let attempts = 0;
    const pool = {
      closes: 0,
      connect() {
        attempts++;
        return acquired.promise;
      },
    };
    const url = `acquire-close-${fails}`;
    pools.set(url, pool);
    let resyncs = 0;
    const stop = subscribePostgresChannel(
      url,
      "events",
      () => {},
      () => resyncs++,
    );
    await until(() => attempts === 1);
    const closing = stop();
    if (fails) acquired.reject(new Error("database unavailable"));
    else acquired.resolve(client);
    await closing;
    assert.equal(resyncs, 0);
    assert.deepEqual(client.queries, []);
    assert.equal(client.releases, fails ? 0 : 1);
    assert.equal(pool.closes, 1);
    await stop();
    assert.equal(pool.closes, 1);
  });
}
