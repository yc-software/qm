import { test } from "node:test";
import assert from "node:assert/strict";
import { configurePgPooling, pgPoolMax } from "../../src/persistence/pg-pool.ts";

test("pool sizes accept any positive integer and reject the rest", () => {
  configurePgPooling({ queryMax: 250, sessionMax: 3 });
  assert.equal(pgPoolMax("query"), 250);
  assert.equal(pgPoolMax("session"), 3);
  assert.throws(() => configurePgPooling({ queryMax: 0 }), /DATABASE_POOL_MAX must be a positive integer/);
  assert.throws(() => configurePgPooling({ sessionMax: 1.5 }), /DATABASE_DIRECT_POOL_MAX must be a positive integer/);
  configurePgPooling({});
  assert.equal(pgPoolMax("query"), 10);
  assert.equal(pgPoolMax("session"), 32);
});
