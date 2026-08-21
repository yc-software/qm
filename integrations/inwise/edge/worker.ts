import {
  decryptJson,
  derivePairingKey,
  encryptJson,
  requestAad,
  responseAad,
} from "../common/crypto.js";
import { fetchJson, joinUrl } from "../common/http.js";
import {
  isReadOnlyTool,
  type BridgeRequest,
  type BridgeResponse,
  type EdgeFile,
  type RelayRequest,
} from "../common/protocol.js";
import { callLocalMcp } from "./local-mcp.js";

export interface EdgeWorkerOptions {
  onError?: (error: Error) => void;
  shouldStop?: () => boolean;
  retryDelayMs?: number;
}

export async function runEdgeWorker(
  config: EdgeFile,
  options: EdgeWorkerOptions = {},
): Promise<void> {
  const key = derivePairingKey(
    config.edgePrivateKey,
    config.cliPublicKey,
    config.pairingId,
  );
  const shouldStop = options.shouldStop ?? (() => false);
  const retryDelayMs = options.retryDelayMs ?? 2_000;

  while (!shouldStop()) {
    try {
      const request = await fetchJson<RelayRequest | undefined>(
        joinUrl(
          config.relayUrl,
          `/v1/devices/${config.deviceId}/requests?wait=25`,
        ),
        { headers: { authorization: `Bearer ${config.edgeToken}` } },
        30_000,
      );
      if (!request) continue;
      await handleRequest(config, key, request);
    } catch (error) {
      if (shouldStop()) break;
      options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

async function handleRequest(
  config: EdgeFile,
  key: Buffer,
  request: RelayRequest,
): Promise<void> {
  if (request.pairingId !== config.pairingId)
    throw new Error("Relay returned the wrong pairing id");
  let response: BridgeResponse;
  try {
    const command = decryptJson<BridgeRequest>(
      key,
      request.envelope,
      requestAad(config.pairingId, request.requestId),
    );
    if (!isReadOnlyTool(command.tool))
      throw new Error(`Tool is not allowed: ${String(command.tool)}`);
    const result = await callLocalMcp(
      config.mcpUrl,
      command.tool,
      command.args ?? {},
    );
    response = { ok: true, result };
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const envelope = encryptJson(
    key,
    response,
    responseAad(config.pairingId, request.requestId),
  );
  await fetchJson<void>(
    joinUrl(
      config.relayUrl,
      `/v1/devices/${config.deviceId}/requests/${request.requestId}/response`,
    ),
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.edgeToken}` },
      body: JSON.stringify({ envelope }),
    },
    10_000,
  );
}
