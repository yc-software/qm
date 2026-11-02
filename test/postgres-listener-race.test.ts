import { mock, test } from "node:test";
import assert from "node:assert/strict";

class FakeSql {
  listens: string[] = [];
  ends = 0;
  notify = new Map<string, (payload: string) => void>();
  relisten = new Map<string, () => void>();

  async listen(channel: string, onnotify: (payload: string) => void, onlisten: () => void) {
    this.listens.push(channel);
    this.notify.set(channel, onnotify);
    this.relisten.set(channel, onlisten);
    onlisten();
    return { unlisten: async () => {} };
  }

  async end() {
    this.ends++;
  }
}

interface FakePool {
  dedicated(): Promise<FakeSql>;
  closes: number;
}

const pools = new Map<string, FakePool>();
mock.module("../src/persistence/pg-pool.ts", {
  namedExports: {
    createPgPool(url: string) {
      const pool = pools.get(url)!;
      return {
        dedicated: () => pool.dedicated(),
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

test("a reconnect that repeats LISTEN resyncs subscribers and keeps delivering", async () => {
  const sql = new FakeSql();
  const pool = { closes: 0, dedicated: async () => sql };
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
    sql.relisten.get("events")!();
    assert.equal(resyncs, 2);
    sql.notify.get("events")!("recovered");
    assert.deepEqual(payloads, ["recovered"]);
    assert.deepEqual(sql.listens, ["events"]);
  } finally {
    await stop();
  }
  assert.equal(sql.ends, 1);
  assert.equal(pool.closes, 1);
});

test("failed acquisition retries and closes the recovered connection", async () => {
  const sql = new FakeSql();
  let attempts = 0;
  const pool = {
    closes: 0,
    async dedicated() {
      if (++attempts === 1) throw new Error("database unavailable");
      return sql;
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
    assert.deepEqual(sql.listens, ["events"]);
  } finally {
    await stop();
  }
  assert.equal(sql.ends, 1);
  assert.equal(pool.closes, 1);
});

for (const fails of [false, true]) {
  test(`unsubscribe during acquisition closes resources when acquisition ${fails ? "fails" : "succeeds"}`, async () => {
    const acquired = Promise.withResolvers<FakeSql>();
    const sql = new FakeSql();
    let attempts = 0;
    const pool = {
      closes: 0,
      dedicated() {
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
    else acquired.resolve(sql);
    await closing;
    await until(() => sql.ends === (fails ? 0 : 1));
    assert.equal(resyncs, 0);
    assert.deepEqual(sql.listens, []);
    assert.equal(pool.closes, 1);
    await stop();
    assert.equal(pool.closes, 1);
  });
}
