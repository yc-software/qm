import type { GatewayContext } from "../types.ts";

export function renderGatewayContext(surface: string | undefined, ctx?: GatewayContext): string {
  const gateway = (surface ?? "").trim();
  const location = ctx?.location?.trim();
  const details = Object.entries(ctx?.details ?? {})
    .map(([k, v]) => [k.trim(), String(v).trim()] as const)
    .filter(([k, v]) => k && v)
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
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
      "A cron, reminder, or watch you create here with no explicit destination posts back into this web conversation, and the person sees it here. Leave the destination unset by default; use `recipient`, `channel`, or `destinationKey` only when the person asks for delivery somewhere else.",
    );
  }
  if (instructions) lines.push(instructions);
  return lines.join("\n");
}
