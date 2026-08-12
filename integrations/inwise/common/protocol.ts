export const PROTOCOL_VERSION = 1 as const;

export const READ_ONLY_TOOLS = [
  "search_meetings",
  "get_meeting",
  "get_transcript",
  "list_action_items",
  "get_action_item",
  "list_people",
  "get_person",
  "list_upcoming_meetings",
  "prepare_meeting",
  "get_connection_status",
] as const;

export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];

export function isReadOnlyTool(value: string): value is ReadOnlyTool {
  return (READ_ONLY_TOOLS as readonly string[]).includes(value);
}

export interface EncryptedEnvelope {
  version: typeof PROTOCOL_VERSION;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface BridgeRequest {
  tool: ReadOnlyTool;
  args: Record<string, unknown>;
}

export type BridgeResponse =
  { ok: true; result: unknown } | { ok: false; error: string };

export interface RelayRequest {
  pairingId: string;
  requestId: string;
  envelope: EncryptedEnvelope;
}

export interface PairingFile {
  pairingId: string;
  relayUrl: string;
  cliToken: string;
  cliPublicKey: string;
  cliPrivateKey: string;
  edgePublicKey?: string;
  deviceName?: string;
  confirmedAt?: string;
}

export interface EdgeFile {
  pairingId: string;
  relayUrl: string;
  deviceId: string;
  edgeToken: string;
  edgePublicKey: string;
  edgePrivateKey: string;
  cliPublicKey: string;
  deviceName: string;
  mcpUrl: string;
}
