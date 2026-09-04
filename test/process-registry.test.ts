import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryProcessRegistry,
  createPostgresProcessRegistry,
  isDeclaredKind,
  type ProcessRegistry,
} from "../src/processes/process-registry.ts";

function backends(): Array<{ name: string; make: () => ProcessRegistry }> {
  return [{ name: "memory", make: () => createMemoryProcessRegistry() }];
}

for (const b of backends()) {
  test(`[${b.name}] register stamps expiry and liveByScope returns running+unexpired`, async () => {
    const reg = b.make();
    const rec = await reg.register({
      processId: id(1),
      scopeId: "personal:U1",
      kind: "build",
      command: "aws-sso: aws sso login",
      ttlMs: 60_000,
    });
    assert.equal(rec.status, "running");
    assert.ok(rec.expiresAt > rec.startedAt);

    const live = await reg.liveByScope("personal:U1");
    assert.equal(live.length, 1);
    assert.equal(live[0]!.processId, id(1));
    assert.equal((await reg.liveByScope("personal:U2")).length, 0);
  });

  test(`[${b.name}] expired running sessions are not live; listExpired surfaces them WITHOUT flipping status`, async () => {
    const reg = b.make();
    await reg.register({ processId: id(2), scopeId: "s", kind: "build", command: "x", ttlMs: -1 });
    assert.equal((await reg.liveByScope("s")).length, 0, "an expired session is not live");

    const expired = await reg.listExpired();
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.processId, id(2));
    assert.equal((await reg.get(id(2)))!.status, "running", "marking dead happens only after a confirmed kill");

    await reg.markStatus(id(2), "reaped");
    assert.equal((await reg.get(id(2)))!.status, "reaped");
    assert.equal((await reg.listExpired()).length, 0);
  });

  test(`[${b.name}] markStatus and delete`, async () => {
    const reg = b.make();
    await reg.register({ processId: id(3), scopeId: "s", kind: "build", command: "make", ttlMs: 60_000 });
    await reg.markStatus(id(3), "exited");
    assert.equal((await reg.liveByScope("s")).length, 0);
    assert.equal((await reg.get(id(3)))!.status, "exited");
    await reg.delete(id(3));
    assert.equal(await reg.get(id(3)), null);
  });

  test(`[${b.name}] only declared kinds may be registered`, async () => {
    const reg = b.make();
    await assert.rejects(
      reg.register({ processId: id(4), scopeId: "s", kind: "shell" as never, command: "sh", ttlMs: 1000 }),
      /not declared/,
    );
  });
}

test("isDeclaredKind gates which kinds may outlive a turn", () => {
  assert.equal(isDeclaredKind("build"), true);
  assert.equal(isDeclaredKind("auth"), false);
  assert.equal(isDeclaredKind("dev-server"), true);
  assert.equal(isDeclaredKind("browser-login"), false);
  assert.equal(isDeclaredKind("browser-agent"), false);
  assert.equal(isDeclaredKind("background"), true);
  assert.equal(isDeclaredKind("shell"), false);
});

for (const b of backends()) {
  test(`[${b.name}] a background kind registers and stamps expiresAt=now+ttlMs`, async () => {
    const reg = b.make();
    const before = Date.now();
    const rec = await reg.register({
      processId: id(7),
      scopeId: "personal:U1",
      kind: "background",
      command: "bg: npm test",
      ttlMs: 1_800_000,
    });
    assert.equal(rec.status, "running");
    assert.equal(rec.kind, "background");
    assert.ok(rec.expiresAt >= before + 1_800_000);
    assert.ok(rec.expiresAt <= Date.now() + 1_800_000);
    assert.equal((await reg.liveByScope("personal:U1")).length, 1);
  });
}

const PG_URL = process.env.TEST_DATABASE_URL;
test("[postgres] honors the registry contract (durable across a restart)", { skip: !PG_URL }, async () => {
  const reg = createPostgresProcessRegistry(PG_URL!);
  const scope = `pg-test-${Date.now()}`;
  try {
    const rec = await reg.register({
      processId: id(1),
      scopeId: scope,
      kind: "dev-server",
      command: "npm run dev",
      ttlMs: 60_000,
    });
    assert.equal(rec.status, "running");
    assert.ok(rec.expiresAt > rec.startedAt);

    const reg2 = createPostgresProcessRegistry(PG_URL!);
    const live = await reg2.liveByScope(scope);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.processId, id(1));
    assert.equal(typeof live[0]!.expiresAt, "number");

    await reg2.register({ processId: id(2), scopeId: scope, kind: "build", command: "y", ttlMs: -1 });
    assert.equal(
      (await reg2.listExpired()).some((r) => r.processId === id(2)),
      true,
    );
    await reg2.delete(id(1));
    await reg2.delete(id(2));
    reg2.close?.();
  } finally {
    reg.close?.();
  }
});

function id(n: number): string {
  const s = n.toString(16).padStart(12, "0");
  return `00000000-0000-0000-0000-${s}`;
}
