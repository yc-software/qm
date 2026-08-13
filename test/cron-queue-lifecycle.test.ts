import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

test("pg-boss queue serializes stop behind in-flight startup", async () => {
  const entered = deferred();
  const resume = deferred();
  const bosses: FakePgBoss[] = [];
  class TestPgBoss extends FakePgBoss {
    constructor() {
      super(entered, resume);
      bosses.push(this);
    }
  }
  mock.module("pg-boss", { namedExports: { PgBoss: TestPgBoss } });
  const { createPgBossCronQueue } = await import("../src/cron/job-queue.ts");
  const queue = createPgBossCronQueue("postgres://unused/test");
  const starting = queue.start({ onFire: async () => {}, onTick: async () => {} }, 5);
  await entered.promise;
  let stopped = false;
  const stopping = queue.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(bosses[0]!.stops, 0);
  resume.resolve();
  await starting;
  await stopping;
  assert.equal(bosses[0]!.stops, 1);
  assert.equal(queue.healthy(), false);
  const sends = bosses[0]!.sends;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bosses[0]!.sends, sends);
});

class FakePgBoss extends EventEmitter {
  starts = 0;
  stops = 0;
  sends = 0;
  private queues = 0;
  private readonly entered: ReturnType<typeof deferred>;
  private readonly resume: ReturnType<typeof deferred>;

  constructor(entered: ReturnType<typeof deferred>, resume: ReturnType<typeof deferred>) {
    super();
    this.entered = entered;
    this.resume = resume;
  }

  async start(): Promise<this> {
    this.starts++;
    return this;
  }

  async createQueue(): Promise<void> {
    this.queues++;
    if (this.queues !== 1) return;
    this.entered.resolve();
    await this.resume.promise;
  }

  async work(): Promise<string> {
    return "worker";
  }

  async send(): Promise<string> {
    this.sends++;
    return "job";
  }

  async stop(): Promise<void> {
    this.stops++;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
