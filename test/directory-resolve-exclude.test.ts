import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectoryStore, type DirectoryStore } from "../src/directory/directory-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";

const URL = process.env.DATABASE_URL;

const people = Array.from({ length: 12 }, (_, i) => ({
  principalId: `U-sam${String(i).padStart(2, "0")}`,
  displayName: `Sam ${String(i).padStart(2, "0")}`,
  type: "internal" as const,
}));

async function addableBeyondTheCap(store: DirectoryStore): Promise<void> {
  await store.replace(people);
  const members = people.slice(0, 10).map((p) => p.principalId);
  const r = await store.resolve("sam", members);
  let found = r.kind === "ambiguous" ? r.candidates : [];
  if (r.kind === "one") found = [r.member];
  assert.deepEqual(found.map((m) => m.principalId).sort(), ["U-sam10", "U-sam11"]);
}

test("people already in the room do not crowd addable people out of the capped search", async () => {
  await addableBeyondTheCap(createDirectoryStore());
});

test(
  "the Postgres directory applies the same exclusion before its cap",
  { skip: URL ? false : "set DATABASE_URL to run" },
  async () => {
    await addableBeyondTheCap(createPostgresDirectoryStore(URL!));
  },
);
