import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPrincipalGraph, handle } from "../src/identity/principals.ts";

describe("principal graph", () => {
  it("handles name their provider; only emails are folded", () => {
    assert.deepEqual(handle("email", " Alice@Example.com "), { provider: "email", externalId: "alice@example.com" });
    assert.deepEqual(handle("slack", "U0123ABC"), { provider: "slack", externalId: "U0123ABC" });
    assert.deepEqual(handle("oidc", "oidc:abc:Sub"), { provider: "oidc", externalId: "oidc:abc:Sub" });
  });

  it("gives an acting handle a principal once", async () => {
    const g = createPrincipalGraph();
    const a = await g.act(handle("oidc", "oidc:alice"));
    assert.equal(await g.act(handle("oidc", "oidc:alice")), a);
    assert.equal(g.principalOf(handle("oidc", "oidc:alice")), a);
    assert.deepEqual(
      g.identitiesOf(a).map((i) => [i.provider, i.externalId]),
      [["oidc", "oidc:alice"]],
    );
    assert.equal((await g.principals()).length, 1);
  });

  it("auto-links an identity whose email matches exactly one principal", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act(handle("oidc", "oidc:alice"));
    await g.setEmails(alice, ["alice@acme.test"], "platform:yc");
    const viaSlack = await g.act(handle("slack", "U1"), { email: "Alice@acme.test" });
    assert.equal(viaSlack, alice);
    const row = (await g.identities(alice)).find((i) => i.provider === "slack");
    assert.equal(row?.linkedBy, "auto:email");
    assert.equal(row?.evidence, "alice@acme.test");
  });

  it("links unverified emails too (recall first)", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act(handle("oidc", "oidc:alice"));
    await g.setEmails(alice, ["alt@acme.test"], "admin:x");
    assert.equal(await g.autoLink(handle("slack", "U2"), "alt@acme.test"), alice);
  });

  it("an email belongs to at most one principal, so a second claim never makes a match ambiguous", async () => {
    const g = createPrincipalGraph();
    const a = await g.act(handle("oidc", "oidc:a"));
    const b = await g.act(handle("oidc", "oidc:b"));
    await g.setEmails(a, ["shared@acme.test"], "admin:x");
    await g.setEmails(b, ["shared@acme.test"], "admin:y");
    assert.equal(g.principalOf(handle("email", "shared@acme.test")), a);
    assert.equal(await g.autoLink(handle("slack", "U3"), "shared@acme.test"), a);
    const fresh = await g.act(handle("slack", "U9"), { email: "nobody@acme.test" });
    assert.ok(![a, b].includes(fresh));
  });

  it("never links on name", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act(handle("oidc", "oidc:alice"), { displayName: "Alice Smith" });
    const other = await g.act(handle("slack", "U4"), { displayName: "Alice Smith" });
    assert.notEqual(other, alice);
  });

  it("slack sync links an already-seen identity once its email is added", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act(handle("oidc", "oidc:alice"));
    assert.equal(await g.autoLink(handle("slack", "U5"), "alice@acme.test"), undefined);
    await g.setEmails(alice, ["alice@acme.test"], "platform:yc");
    assert.equal(await g.autoLink(handle("slack", "U5"), "alice@acme.test"), alice);
  });

  it("self-serve and admin linking reach the same end state whichever account came first", async () => {
    for (const order of ["web-first", "slack-first"]) {
      const g = createPrincipalGraph();
      const web = handle("oidc", "oidc:alice");
      const slack = handle("slack", "U6");
      const first = order === "web-first" ? web : slack;
      const second = order === "web-first" ? slack : web;
      const a = await g.act(first);
      const b = await g.act(second);
      await g.attach(second, a, "self", "connect");
      assert.equal(g.principalOf(handle("oidc", "oidc:alice")), g.principalOf(handle("slack", "U6")), order);
      assert.equal((await g.principals()).length, 1, order);
      assert.ok(!(await g.principals()).some((p) => p.principalId === b), order);
    }
  });

  it("setEmails is idempotent and removes addresses the source no longer lists", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act(handle("oidc", "oidc:alice"));
    await g.setEmails(alice, ["a@x.test", "b@x.test"], "platform:yc");
    await g.setEmails(alice, ["a@x.test", "b@x.test"], "platform:yc");
    await g.setEmails(alice, ["b@x.test"], "platform:yc");
    const emails = (await g.identities(alice)).filter((i) => i.provider === "email").map((i) => i.externalId);
    assert.deepEqual(emails, ["b@x.test"]);
  });

  it("unlink detaches one identity; its next action follows the normal rules", async () => {
    const g = createPrincipalGraph();
    const alice = await g.act(handle("oidc", "oidc:alice"));
    await g.act(handle("slack", "U7"));
    await g.attach(handle("slack", "U7"), alice, "admin:x", "test");
    await g.unlink(handle("slack", "U7"));
    assert.equal(g.principalOf(handle("slack", "U7")), undefined);
    assert.notEqual(await g.act(handle("slack", "U7")), alice);
  });
});
