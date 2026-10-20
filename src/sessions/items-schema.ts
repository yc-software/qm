export type ItemKind =
  | "UserMessage"
  | "SteeringMessage"
  | "AgentMessage"
  | "Reasoning"
  | "ToolCall"
  | "ToolResult"
  | "Elicitation"
  | "ElicitationResponse"
  | "Wake"
  | "Error"
  | "ContextCompaction"
  | "Retraction"
  | "Stop"
  | "RuntimeChange";

export const WAKE_CAUSES = ["cron", "webhook", "child_done", "system"] as const;
