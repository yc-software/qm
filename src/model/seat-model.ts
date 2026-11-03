import type { Api, Model } from "@earendil-works/pi-ai";

export const SEAT_MODEL_ID = "agent-seat";

export function seatModel(): Model<Api> {
  return {
    id: SEAT_MODEL_ID,
    name: "You (Agent Seat)",
    api: "anthropic-messages",
    provider: SEAT_MODEL_ID,
    baseUrl: "https://agent-seat.invalid",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}
