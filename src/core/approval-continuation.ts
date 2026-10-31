const CONVERSATION_KINDS = new Set(["dm", "channel", "group"]);

export function approvalDeniedReason(command: string): string {
  return `approval denied for ${command}`;
}

export function approvalContinuation(request: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!request) return null;
  const actor = request.actor as { externalId?: unknown } | undefined;
  const conversation = request.conversation as { kind?: unknown } | undefined;
  if (typeof actor?.externalId !== "string" || typeof request.text !== "string") return null;
  if (!CONVERSATION_KINDS.has(String(conversation?.kind))) return null;
  const {
    surface: _surface,
    async: _async,
    idempotencyKey: _idempotencyKey,
    redeliveryKey: _redeliveryKey,
    approval: _approval,
    relayInput: _relayInput,
    ...turn
  } = request;
  return turn;
}
