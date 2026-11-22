import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import type { TeamsBot } from "./ids.ts";

const MANIFEST_VERSION = "1.25";
const ICONS = {
  "color.png": readFileSync(new URL("assets/color.png", import.meta.url)),
  "outline.png": readFileSync(new URL("assets/outline.png", import.meta.url)),
};

export function teamsAppManifest(bot: Pick<TeamsBot, "appId">, o: { name: string; origin: string; version: string }) {
  const short = o.name.slice(0, 30);
  return {
    $schema: `https://developer.microsoft.com/en-us/json-schemas/teams/v${MANIFEST_VERSION}/MicrosoftTeams.schema.json`,
    manifestVersion: MANIFEST_VERSION,
    version: o.version,
    id: bot.appId,
    developer: { name: short, websiteUrl: o.origin, privacyUrl: o.origin, termsOfUseUrl: o.origin },
    name: { short, full: o.name.slice(0, 100) },
    description: {
      short: `${short} answers in your chats and channels.`,
      full: `${o.name} is your team's agent. Message it directly, or add it to a team or group chat, where it follows the conversation and answers when it can help.`,
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#4F46E5",
    bots: [{ botId: bot.appId, scopes: ["personal", "team", "groupChat"], isNotificationOnly: false }],
    supportsChannelFeatures: "tier1",
    validDomains: [new URL(o.origin).host],
    webApplicationInfo: { id: bot.appId, resource: "https://RscBasedStoreApp" },
    authorization: {
      permissions: {
        resourceSpecific: [
          { name: "ChannelMessage.Read.Group", type: "Application" },
          { name: "ChatMessage.Read.Chat", type: "Application" },
        ],
      },
    },
  };
}

export function teamsAppPackage(...args: Parameters<typeof teamsAppManifest>): Uint8Array {
  return zipSync({ "manifest.json": strToU8(JSON.stringify(teamsAppManifest(...args), null, 2)), ...ICONS });
}
