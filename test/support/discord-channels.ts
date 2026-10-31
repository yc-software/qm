import { createDiscordChannels } from "../../src/discord/gateway.ts";
import type { DiscordInstallationStore } from "../../src/surfaces/discord-installation.ts";

export const noLinkChannels = (client: unknown) => createDiscordChannels(client as never, async () => {});

const TEST_BOT = {
  token: "test-bot-token",
  userId: "100000000000000001",
  tag: "qm#1",
  applicationId: "100000000000000002",
};

export const installDiscord = (built: { discordInstallation: DiscordInstallationStore }) =>
  built.discordInstallation.set({
    guildIds: [],
    internalRoleIds: [],
    bot: TEST_BOT,
    updatedBy: "test",
  });
