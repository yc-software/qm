import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPrincipalGraph, handleOf } from "../src/identity/principals.ts";

describe("principal graph", () => {
  it("maps raw handles to providers", () => {
    assert.deepEqual(handleOf("Alice@Example.com"), { provider: "email", externalId: "alice@example.com" });
    assert.deepEqual(handleOf("U0123ABC"), { provider: "slack", externalId: "U0123ABC" });
    assert.deepEqual(handleOf("oidc:abc:sub"), { provider: "oidc", externalId: "oidc:abc:sub" });
  });

  it("gives an acting handle a principal once", async () => {
    const g = createPrincipalGraph();
    const a = await g.act("oidc:alice");
    assert.equal(await g.act("oidc:alice"), a);
    assert.equal(g.principalOf("oidc:alice"), a);
    assert.equal(g.principalOf(a), a);
    assert.equal((await g.principals()).length, 1);
  });

  it("auto-links an identity whose email matches exactly one principal", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act("oidc:alice");
    await g.setEmails(alice, ["alice@acme.test"], "platform:yc");
    const viaSlack = await g.act("U1", { email: "Alice@acme.test" });
    assert.equal(viaSlack, alice);
    const row = (await g.identities(alice)).find((i) => i.provider === "slack");
    assert.equal(row?.linkedBy, "auto:email");
    assert.equal(row?.evidence, "alice@acme.test");
  });

  it("links unverified emails too (recall first)", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act("oidc:alice");
    await g.setEmails(alice, ["alt@acme.test"], "admin:x");
    assert.equal(await g.autoLink("U2", "alt@acme.test"), alice);
  });

  it("an email belongs to at most one principal, so a second claim never makes a match ambiguous", async () => {
    const g = createPrincipalGraph();
    const a = await g.act("oidc:a");
    const b = await g.act("oidc:b");
    await g.setEmails(a, ["shared@acme.test"], "admin:x");
    await g.setEmails(b, ["shared@acme.test"], "admin:y");
    assert.equal(g.principalOf("shared@acme.test"), a);
    assert.equal(await g.autoLink("U3", "shared@acme.test"), a);
    const fresh = await g.act("U9", { email: "nobody@acme.test" });
    assert.ok(![a, b].includes(fresh));
  });

  it("never links on name", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act("oidc:alice", { displayName: "Alice Smith" });
    const other = await g.act("U4", { displayName: "Alice Smith" });
    assert.notEqual(other, alice);
  });

  it("slack sync links an already-seen identity once its email is added", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act("oidc:alice");
    assert.equal(await g.autoLink("U5", "alice@acme.test"), undefined);
    await g.setEmails(alice, ["alice@acme.test"], "platform:yc");
    assert.equal(await g.autoLink("U5", "alice@acme.test"), alice);
  });

  it("self-serve and admin linking reach the same end state whichever account came first", async () => {
    for (const order of ["web-first", "slack-first"]) {
      const g = createPrincipalGraph();
      const first = order === "web-first" ? "oidc:alice" : "U6";
      const second = order === "web-first" ? "U6" : "oidc:alice";
      const a = await g.act(first);
      const b = await g.act(second);
      await g.attach(second, a, "self", "connect");
      assert.equal(g.principalOf("oidc:alice"), g.principalOf("U6"), order);
      assert.equal((await g.principals()).length, 1, order);
      assert.ok(!(await g.principals()).some((p) => p.principalId === b), order);
    }
  });

  it("setEmails is idempotent and removes addresses the source no longer lists", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act("oidc:alice");
    await g.setEmails(alice, ["a@x.test", "b@x.test"], "platform:yc");
    await g.setEmails(alice, ["a@x.test", "b@x.test"], "platform:yc");
    await g.setEmails(alice, ["b@x.test"], "platform:yc");
    const emails = (await g.identities(alice)).filter((i) => i.provider === "email").map((i) => i.externalId);
    assert.deepEqual(emails, ["b@x.test"]);
  });

  it("unlink detaches one identity; its next action follows the normal rules", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act("oidc:alice");
    await g.act("U7");
    await g.attach("U7", alice, "admin:x", "test");
    await g.unlink("U7");
    assert.equal(g.principalOf("U7"), undefined);
    assert.notEqual(await g.act("U7"), alice);
  });
});
