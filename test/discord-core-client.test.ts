import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createDiscordCoreClient } from "../src/api/discord-core-client.ts";
import { createIdentityService, type IdentityService } from "../src/identity/identity-service.ts";
import { type PrincipalLinkService } from "../src/identity/principal-links.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { discordExternalId } from "../src/discord/config.ts";
import { testPrincipalLinks } from "./support/principal-links.ts";
import { testMap } from "./support/test-database.ts";

type DiscordCoreDeps = Parameters<typeof createDiscordCoreClient>[0];

function createDeps(identity: IdentityService): DiscordCoreDeps {
  return {
    identity,
    runs: { onTerminal: () => {} },
  } as unknown as DiscordCoreDeps;
}

describe("discord core client identity links", () => {
  afterEach(() => {
    installPrincipalLinks(null);
  });

  it("classifies unlinked, linked internal, and deactivated discord users", async () => {
    const links: PrincipalLinkService = testPrincipalLinks();
    installPrincipalLinks(links);
    const identity = createIdentityService(testMap(), { externalMembers: testMap(), principalLinks: links });
    const client = createDiscordCoreClient(createDeps(identity));

    assert.equal(await client.linkedInternal("unlinked-user"), false);

    await links.link({
      principalId: discordExternalId("discord-user-1"),
      canonicalId: "user@example.test",
      evidence: "admin link",
      linkedBy: "admin",
    });

    assert.equal(await client.linkedInternal("discord-user-1"), true);

    await identity.deactivate("user@example.test");

    assert.equal(await client.linkedInternal("discord-user-1"), false);
  });

  it("discordUserIdsFor returns only the discord ids linked to a principal", async () => {
    const links: PrincipalLinkService = testPrincipalLinks();
    installPrincipalLinks(links);
    const identity = createIdentityService(testMap(), { externalMembers: testMap(), principalLinks: links });
    const client = createDiscordCoreClient(createDeps(identity));

    await links.link({
      principalId: discordExternalId("discord-1"),
      canonicalId: "member@example.test",
      evidence: "admin link 1",
      linkedBy: "admin",
    });
    await links.link({
      principalId: "slack:U12345",
      canonicalId: "member@example.test",
      evidence: "admin link slack",
      linkedBy: "admin",
    });

    assert.deepEqual(client.discordUserIdsFor("member@example.test"), ["discord-1"]);
    assert.deepEqual(client.discordUserIdsFor("other@example.test"), []);
    assert.deepEqual(client.discordUserIdsFor("discord:111"), ["111"]);
  });

  it("active external member linked stays guest on Discord", async () => {
    const links: PrincipalLinkService = testPrincipalLinks();
    installPrincipalLinks(links);
    const identity = createIdentityService(testMap(), { externalMembers: testMap(), principalLinks: links });
    const client = createDiscordCoreClient(createDeps(identity));

    await identity.putExternalMember({
      email: "external@example.test",
      role: "member",
      expiresAt: Date.now() + 100_000,
      invitedBy: "admin",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await links.link({
      principalId: discordExternalId("discord-ext-1"),
      canonicalId: "external@example.test",
      evidence: "self link",
      linkedBy: "external@example.test",
    });

    assert.equal(await client.linkedInternal("discord-ext-1"), false);

    await links.link({
      principalId: discordExternalId("discord-internal-1"),
      canonicalId: "internal@example.test",
      evidence: "self link",
      linkedBy: "internal@example.test",
    });

    assert.equal(await client.linkedInternal("discord-internal-1"), true);
  });

  it("coreStatus.notInternal is true for deactivated user and false for normal user", async () => {
    const links: PrincipalLinkService = testPrincipalLinks();
    installPrincipalLinks(links);
    const identity = createIdentityService(testMap(), { externalMembers: testMap(), principalLinks: links });
    const client = createDiscordCoreClient(createDeps(identity));

    assert.equal((await client.coreStatus("unlinked-normal")).notInternal, false);

    await links.link({
      principalId: discordExternalId("discord-user-deact"),
      canonicalId: "deact@example.test",
      evidence: "admin link",
      linkedBy: "admin",
    });
    assert.equal((await client.coreStatus("discord-user-deact")).notInternal, false);

    await identity.deactivate("deact@example.test");
    assert.equal((await client.coreStatus("discord-user-deact")).notInternal, true);

    await identity.deactivate(discordExternalId("direct-deact"));
    assert.equal((await client.coreStatus("direct-deact")).notInternal, true);
  });
});
