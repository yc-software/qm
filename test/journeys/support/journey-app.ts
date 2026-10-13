import "../../support/auto-fake-sprites.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../../../src/wiring.ts";
import type { Config } from "../../../src/config.ts";
import type { IncomingAttachment, TurnRequest, TurnResult } from "../../../src/types.ts";
import { setGatewayModels } from "../../../src/model/gateway-models.ts";
import { testConfig } from "../../support/test-config.ts";
import {
  GATEWAY_API_KEY,
  GATEWAY_API_KEY_HEADER,
  GATEWAY_MODEL_ID,
  startFakeGateway,
  type FakeGateway,
  type GatewayLimits,
} from "./fake-gateway.ts";

export interface JourneyApp {
  built: BuiltApp;
  config: Config;
  gateway: FakeGateway;
  upload(name: string, mimetype: string, bytes: Uint8Array): Promise<IncomingAttachment>;
  webTurn(actorId: string, threadRef: string, text: string, attachments?: IncomingAttachment[]): Promise<TurnResult>;
  stop(): Promise<void>;
}

export const journeyTestOptions = (timeout: number) => {
  if (process.env.CI && !process.env.DATABASE_URL) throw new Error("journeys need DATABASE_URL in CI");
  return {
    timeout,
    skip: process.env.DATABASE_URL ? false : "journeys need DATABASE_URL (run them through npm run test:journey)",
  };
};

export async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function startJourneyApp(limits: GatewayLimits, overrides: Partial<Config> = {}): Promise<JourneyApp> {
  const gateway = await startFakeGateway(limits);
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "qm-journey-")),
    databaseUrl: process.env.DATABASE_URL!,
    sessionStore: "postgres",
    runStore: "postgres",
    harness: "pi",
    modelId: GATEWAY_MODEL_ID,
    modelGateway: { url: gateway.url, apiKey: GATEWAY_API_KEY, apiKeyHeader: GATEWAY_API_KEY_HEADER, models: {} },
    backgroundWorkEnabled: true,
    ...overrides,
  });
  const built = buildApp(config);
  await built.refreshModels();
  await built.identity.hydrate();
  built.runtime.start();
  const turn = (req: TurnRequest) => built.app.turn(req);
  return {
    built,
    config,
    gateway,
    async upload(name, mimetype, bytes) {
      const info = await built.blobTransfer.put(bytes);
      return { name, mimetype, sizeBytes: info.sizeBytes, blobId: info.blobId };
    },
    webTurn(actorId, threadRef, text, attachments) {
      return turn({
        surface: "web",
        actor: { externalId: actorId },
        conversation: { kind: "dm", threadRef },
        text,
        ...(attachments?.length ? { attachments } : {}),
      });
    },
    async stop() {
      await built.scheduler.stop();
      await built.runtime.stop();
      await gateway.close();
      setGatewayModels([]);
    },
  };
}
