import { test } from "node:test";
import assert from "node:assert/strict";
import { createPersonNames, personLabel, UNKNOWN_PERSON } from "../src/identity/person-names.ts";
import type { UserRecord } from "../src/identity/user-store.ts";

const user = (principalId: string, extra: Partial<UserRecord> = {}): UserRecord => ({
  id: "00000000-0000-0000-0000-000000000000",
  principalId,
  aliases: [principalId],
  kind: "person",
  ...extra,
});

test("a person's label is their name, then an email, and never a raw sign-in id", () => {
  assert.equal(personLabel("oidc:issuer:ada", { displayName: " Ada Founder " }), "Ada Founder");
  assert.equal(personLabel("oidc:issuer:ada", { user: user("oidc:issuer:ada", { displayName: "Ada" }) }), "Ada");
  assert.equal(personLabel("Grace@Example.com"), "Grace@Example.com");
  assert.equal(
    personLabel("oidc:issuer:ada", {
      user: user("oidc:issuer:ada", { aliases: ["oidc:issuer:ada", "ada@example.com"] }),
    }),
    "ada@example.com",
  );
  assert.equal(personLabel("oidc:issuer:ada", { displayName: "oidc:issuer:ada" }), UNKNOWN_PERSON);
  assert.equal(personLabel("oidc:issuer:ada", { displayName: "oidc:other:x" }), UNKNOWN_PERSON);
  assert.equal(personLabel("U123"), "U123");
  assert.equal(personLabel("Organization"), "Organization");
  assert.equal(UNKNOWN_PERSON, "Unknown person");
});

test("labels prefer the directory, then the stored name, and survive a failing store", async () => {
  const names = createPersonNames({
    directory: { get: async (id) => (id === "U1" ? ({ principalId: "U1", displayName: "Slack Sam" } as never) : null) },
    users: {
      resolve: async (ids) =>
        new Map(ids.filter((id) => id === "oidc:issuer:ada").map((id) => [id, user(id, { displayName: "Ada" })])),
    },
  });
  assert.deepEqual(
    [...(await names.labels(["U1", "oidc:issuer:ada", "oidc:issuer:nobody", "U1"]))],
    [
      ["U1", "Slack Sam"],
      ["oidc:issuer:ada", "Ada"],
      ["oidc:issuer:nobody", UNKNOWN_PERSON],
    ],
  );
  assert.deepEqual([...(await names.storedNames(["oidc:issuer:ada", "U1"]))], [["oidc:issuer:ada", "Ada"]]);
  const broken = createPersonNames({ users: { resolve: async () => Promise.reject(new Error("down")) } });
  assert.deepEqual([...(await broken.labels(["bo@example.com"]))], [["bo@example.com", "bo@example.com"]]);
});
