import type { AssistantMessage } from "@earendil-works/pi-ai";

type MaybeAssistant = { role?: string; stopReason?: AssistantMessage["stopReason"]; errorMessage?: string };

export function showStateError(messages: readonly unknown[], stateError: string | undefined): boolean {
  if (!stateError || stateError === "aborted") return false;
  const last = messages[messages.length - 1] as MaybeAssistant | undefined;
  return !(last?.role === "assistant" && last.stopReason === "error" && last.errorMessage === stateError);
}
