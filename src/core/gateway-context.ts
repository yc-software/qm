import type { GatewayContext } from "../types.ts";

export function renderGatewayContext(surface: string | undefined, ctx?: GatewayContext, dmWith?: string): string {
  const gateway = (surface ?? "").trim();
  const location = ctx?.location?.trim();
  const details = Object.entries(ctx?.details ?? {})
    .map(([k, v]) => [k.trim(), String(v).trim()] as const)
    .filter(([k, v]) => k && v)
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const instructions = ctx?.instructions?.trim();
  if (!gateway && !location && details.length === 0 && !instructions) return "";

  const lines = ["## Where you are"];
  const place = gateway ? `${gateway.charAt(0).toUpperCase()}${gateway.slice(1)}` : "";
  if (place && dmWith) lines.push(`${place} DM with ${dmWith}.`);
  else if (place && location) lines.push(`${place}, in ${location}.`);
  else if (place) lines.push(`${place} conversation.`);
  else if (location) lines.push(`In ${location}.`);
  if (details.length) {
    lines.push("Identifiers for this conversation (use these if you need to act on it directly):");
    for (const [k, v] of details) lines.push(`- ${k}: ${v}`);
  }
  if (gateway.toLowerCase() === "web") lines.push("Crons you create here post back here.");
  if (instructions) lines.push(instructions);
  return lines.join("\n");
}
