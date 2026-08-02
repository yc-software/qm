import assert from "node:assert/strict";
import test from "node:test";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import type { ScopeId } from "../src/types.ts";

class CountingMap<T> implements DurableMap<T> {
  allCalls = 0;
  private readonly m = new Map<string, T>();

  async all(): Promise<T[]> {
    this.allCalls += 1;
    return [...this.m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  }

  async entries(): Promise<Array<[string, T]>> {
    return [...this.m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  async get(id: string): Promise<T | null> {
    return this.m.get(id) ?? null;
  }

  async put(id: string, value: T): Promise<void> {
    this.m.set(id, value);
  }

  async putIfAbsent(id: string, value: T): Promise<T> {
    const existing = this.m.get(id);
    if (existing !== undefined) return existing;
    this.m.set(id, value);
    return value;
  }

  async insertIfAbsent(id: string, value: T): Promise<boolean> {
    if (this.m.has(id)) return false;
    this.m.set(id, value);
    return true;
  }

  async merge(id: string, patch: Partial<T>): Promise<T | null> {
    const current = this.m.get(id);
    if (!current) return null;
    const next = { ...current, ...patch } as T;
    this.m.set(id, next);
    return next;
  }

  async delete(id: string): Promise<void> {
    this.m.delete(id);
  }

  async take(id: string): Promise<T | null> {
    const current = this.m.get(id) ?? null;
    this.m.delete(id);
    return current;
  }
}

function skill(id: string, name: string, scopeId: ScopeId): Skill {
  return {
    id,
    scopeId,
    manifest: { name, description: `Skill ${name}`, requiredCapabilities: [], body: "body" },
    signature: "test-signature",
    status: "published",
    createdBy: "test",
    version: 1,
    grantedCapabilities: [],
    approvals: [],
  };
}

test("visibleFor resolves a large shadowed catalog with one full skills read", async () => {
  const backing = new CountingMap<Skill>();
  const store = createSkillStore({ signingSecret: "test-secret", backing });
  const personal = "personal:U1" as ScopeId;
  const org = "org:default-org" as ScopeId;

  for (let i = 0; i < 200; i += 1) {
    const name = `bench-skill-${String(i).padStart(3, "0")}`;
    await backing.put(`personal-${i}`, skill(`personal-${i}`, name, personal));
    await backing.put(`org-${i}`, skill(`org-${i}`, name, org));
  }

  backing.allCalls = 0;
  const visible = await store.visibleFor([personal, org]);

  assert.equal(visible.length, 200);
  assert.equal(backing.allCalls, 1, "visibleFor should not call skills.all() once per skill name");
  assert.equal(visible[0]?.skill.scopeId, personal);
  assert.equal(visible[0]?.shadowed.length, 1);
  assert.equal(visible[0]?.shadowed[0]?.scopeId, org);
});
