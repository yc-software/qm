import type { GatewayContext } from "../types.ts";

export function renderGatewayContext(surface: string | undefined, ctx?: GatewayContext): string {
  const gateway = (surface ?? "").trim();
  const location = ctx?.location?.trim();
  const details = Object.entries(ctx?.details ?? {})
    .map(([k, v]) => [k.trim(), String(v).trim()] as const)
    .filter(([k, v]) => k && v);
  const instructions = ctx?.instructions?.trim();
  if (!gateway && !location && details.length === 0 && !instructions) return "";

  const lines = ["## Where you are"];
  if (gateway && location) lines.push(`You are talking with the user over ${gateway}, in ${location}.`);
  else if (gateway) lines.push(`You are talking with the user over ${gateway}.`);
  else if (location) lines.push(`You are talking with the user in ${location}.`);
  if (details.length) {
    lines.push("Identifiers for this conversation (use these if you need to act on it directly):");
    for (const [k, v] of details) lines.push(`- ${k}: ${v}`);
  }
  if (gateway.toLowerCase() === "web") {
    lines.push(
      'This web UI cannot receive future external notifications. For scheduled notifications, reminders, digests, or reports, create the cron with a real platform destination: use `recipient` for a Slack DM to the requesting user when you can resolve them as a teammate, `channel` for a named Slack channel, or ask the user where it should post. Do not put "deliver to Slack" only inside `action`.',
    );
  }
  if (instructions) lines.push(instructions);
  return lines.join("\n");
}
