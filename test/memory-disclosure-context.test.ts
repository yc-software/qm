import { test } from "node:test";
import assert from "node:assert/strict";
import { contextMemory } from "../src/resolution/turn-context.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";

test("shared context cannot recall or search unlabeled personal memory merely because its notebook is a candidate", async () => {
  const memory: MemoryService = {
    read: async () => "- PRIVATE_SENTINEL",
    query: async () => ["PRIVATE_SENTINEL"],
    recall: async () => "PRIVATE_SENTINEL",
    capture: async () => 0,
    replace: async () => {},
  };
  const view = contextMemory({
    memory,
    scopes: ["personal:alice"],
    actorId: "alice",
    disclosure: {
      actor: { id: "alice", type: "internal" },
      targetScope: "group:room",
      nativeScopes: ["group:room"],
      audience: [
        { id: "alice", type: "internal" },
        { id: "bob", type: "internal" },
      ],
      open: true,
    },
  });
  assert.equal(await view.recall(), "");
  assert.deepEqual(await view.search("PRIVATE_SENTINEL"), []);
});
