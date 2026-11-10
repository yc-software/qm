import { createPostgresNotifyBus, MAX_NOTIFY_PAYLOAD_BYTES } from "../persistence/postgres-notify-bus.ts";
import { boundTenant } from "../tenants/context.ts";
import type { SessionStateBus, SessionStateEvent } from "./session-state-bus.ts";

const CHANNEL = "session_state";

export function encodeWirePayload(event: SessionStateEvent, maxBytes = MAX_NOTIFY_PAYLOAD_BYTES): string | null {
  const full = JSON.stringify(event);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;
  const { participants: _participants, ...bare } = event;
  const shed = JSON.stringify({ ...bare, participantsShed: true });
  return Buffer.byteLength(shed, "utf8") <= maxBytes ? shed : null;
}

export function createPostgresSessionStateBus(connectionString: string): SessionStateBus {
  const bus = createPostgresNotifyBus<SessionStateEvent>(connectionString, CHANNEL, "session-state", (event) =>
    encodeWirePayload(event),
  );
  return { ...bus, emit: (event) => bus.emit({ ...event, tenantId: event.tenantId ?? boundTenant() }) };
}
