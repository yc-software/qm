import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolContextRef } from "./agent-tools.ts";

export interface TurnSession {
  agentSession: AgentSession;
  ref: ToolContextRef & { effortLevel?: string };
  composedPromptTokens: number;
  agentDir: string;
  ephemeralCwd?: string;
}
