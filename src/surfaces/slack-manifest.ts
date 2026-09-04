import { readFileSync } from "node:fs";

interface SlackBotManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string } };
}

let template: string | undefined;

export function slackBotManifestCreationUrl(name?: string): string {
  template ??= readFileSync(new URL("../../cli/templates/slack-manifest.json", import.meta.url), "utf8");
  const manifest = JSON.parse(template) as SlackBotManifest;
  const label = [...(name?.trim() || "qm")].slice(0, 35).join("");
  manifest.display_information.name = label;
  manifest.display_information.description = `${label} workspace agent`;
  manifest.features.bot_user.display_name = label;
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(manifest));
  return url.toString();
}
