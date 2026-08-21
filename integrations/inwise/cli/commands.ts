import { randomUUID } from "node:crypto";
import { decryptJson, derivePairingKey, encryptJson, requestAad, responseAad } from "../common/crypto.js";
import { fetchJson, HttpError, joinUrl } from "../common/http.js";
import {
  isReadOnlyTool,
  type BridgeRequest,
  type BridgeResponse,
  type EncryptedEnvelope,
  type PairingFile,
  type ReadOnlyTool,
} from "../common/protocol.js";

interface PairStatus {
  status: "pending" | "paired";
  edgePublicKey?: string;
  deviceName?: string;
  expiresAt?: string;
}

export async function refreshPairing(config: PairingFile): Promise<PairingFile> {
  const status = await fetchJson<PairStatus>(
    joinUrl(config.relayUrl, `/v1/pairings/${config.pairingId}`),
    { headers: { authorization: `Bearer ${config.cliToken}` } },
    10_000,
  );
  if (status.status === "paired" && status.edgePublicKey) {
    const sameKey = config.edgePublicKey === status.edgePublicKey;
    return {
      ...config,
      edgePublicKey: status.edgePublicKey,
      deviceName: status.deviceName,
      ...(sameKey && config.confirmedAt ? { confirmedAt: config.confirmedAt } : { confirmedAt: undefined }),
    };
  }
  return config;
}

export async function callInwise(
  config: PairingFile,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!isReadOnlyTool(toolName)) throw new Error(`Unsupported or write-capable tool: ${toolName}`);
  if (!config.edgePublicKey) throw new Error("Pairing is waiting for approval on the Inwise laptop");
  if (!config.confirmedAt)
    throw new Error("Pairing keys are not verified. Compare the laptop code and run `inwise auth confirm CODE`");
  const tool: ReadOnlyTool = toolName;
  const requestId = randomUUID();
  const key = derivePairingKey(config.cliPrivateKey, config.edgePublicKey, config.pairingId);
  const command: BridgeRequest = { tool, args };
  const envelope = encryptJson(key, command, requestAad(config.pairingId, requestId));
  interface RelayRequestStatus {
    requestId: string;
    status: "pending" | "responded";
    envelope?: EncryptedEnvelope;
  }
  const deadline = Date.now() + 50_000;
  const retry = async (operation: () => Promise<RelayRequestStatus>): Promise<RelayRequestStatus> => {
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (Date.now() >= deadline || (error instanceof HttpError && error.status < 500)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  let response = await retry(() =>
    fetchJson<RelayRequestStatus>(
      joinUrl(config.relayUrl, `/v1/pairings/${config.pairingId}/requests`),
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.cliToken}` },
        body: JSON.stringify({ requestId, envelope }),
      },
      10_000,
    ),
  );
  if (response.requestId !== requestId) throw new Error("Relay returned the wrong request id");
  while (response.status === "pending") {
    if (Date.now() >= deadline) throw new Error("Inwise Desktop is offline or did not respond in time");
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await retry(() =>
      fetchJson<RelayRequestStatus>(
        joinUrl(config.relayUrl, `/v1/pairings/${config.pairingId}/requests/${requestId}`),
        { headers: { authorization: `Bearer ${config.cliToken}` } },
        10_000,
      ),
    );
  }
  if (!response.envelope) throw new Error("Relay response is incomplete");
  const result = decryptJson<BridgeResponse>(key, response.envelope, responseAad(config.pairingId, requestId));
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
