import { createHmac, scrypt } from "node:crypto";
import { probeModel } from "../harness/pi-harness.ts";
import { ProviderTurnError, type ProviderErrorCode } from "../core/turn-error.ts";
import { modelFromOverlay } from "./pi-models.ts";
import type { ModelOverlay } from "./model-overlay.ts";
import type { ModelCredentialStore } from "./model-credential-store.ts";
import { GatewayModelUnavailableError, type ModelGatewayTransportConfig } from "./provider-endpoints.ts";

export class ModelVerificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ModelVerificationContext {
  fingerprint: string;
  probe(signal: AbortSignal): Promise<void>;
}
export type ModelVerifier = (spec: ModelOverlay) => Promise<ModelVerificationContext>;

const VERIFICATION_FAILURES: Record<string, string> = {
  timeout: "Verification timed out. Try again; the model was not enabled.",
  access_denied: "The serving credential cannot access this model. Check its provider permissions.",
  quota_or_rate_limit: "The provider reports a quota, billing, or rate limit. Resolve it and verify again.",
  model_unavailable: "The provider could not serve this model ID. Check the ID and credential access.",
  unsupported_configuration: "The provider rejected this configuration. Check the template and fast-mode capability.",
  provider_failure: "The provider did not complete the verification request. Try again or check provider status.",
};

const VERIFICATION_CODES: Record<ProviderErrorCode, keyof typeof VERIFICATION_FAILURES> = {
  auth: "access_denied",
  model_budget: "quota_or_rate_limit",
  rate_limit: "quota_or_rate_limit",
  not_found: "model_unavailable",
  bad_request: "unsupported_configuration",
  context_too_long: "unsupported_configuration",
  refusal: "provider_failure",
  transient: "provider_failure",
  unknown: "provider_failure",
};

/** Maps a probe failure from structured signals only: ProviderTurnError.code or an abort/timeout error's name. */
export function verificationFailure(error: unknown): ModelVerificationError {
  if (error instanceof ModelVerificationError) return error;
  let code = "provider_failure";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) code = "timeout";
  else if (error instanceof GatewayModelUnavailableError) code = "model_unavailable";
  else if (error instanceof ProviderTurnError) code = VERIFICATION_CODES[error.code];
  return new ModelVerificationError(code, VERIFICATION_FAILURES[code]!);
}

export function createModelVerifier(input: {
  credentials: ModelCredentialStore;
  keyMaterial: string | Buffer;
  modelGateway?: ModelGatewayTransportConfig;
  probe?: typeof probeModel;
}): ModelVerifier {
  const salt = createHmac("sha256", input.keyMaterial).update("qm:model-verification:credential:v2").digest();
  const credentialKeys = new Map<
    ModelOverlay["provider"] | "gateway",
    { material: string; derived: Promise<Buffer> }
  >();
  function credentialKey(source: ModelOverlay["provider"] | "gateway", material: string): Promise<Buffer> {
    const cached = credentialKeys.get(source);
    if (cached?.material === material) return cached.derived;
    const derived = new Promise<Buffer>((resolve, reject) => {
      scrypt(material, salt, 32, { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    }).catch((error: unknown) => {
      if (credentialKeys.get(source)?.derived === derived) credentialKeys.delete(source);
      throw error;
    });
    credentialKeys.set(source, { material, derived });
    return derived;
  }
  return async (spec) => {
    const model = modelFromOverlay(spec);
    if (!model)
      throw new ModelVerificationError(
        "invalid_template",
        "The model template is unavailable. Choose another template.",
      );
    const gateway = input.modelGateway?.models[spec.id] ? input.modelGateway : undefined;
    const key = gateway?.apiKey ?? (await input.credentials.resolve(spec.provider));
    if (!key)
      throw new ModelVerificationError(
        "missing_credential",
        "Configure an organization provider credential before verifying this model.",
      );
    const status = (await input.credentials.statuses()).find((s) => s.provider === spec.provider);
    const derived = await credentialKey(
      gateway ? "gateway" : spec.provider,
      JSON.stringify({ key, apiKeyHeader: gateway?.apiKeyHeader }),
    );
    const fingerprint = createHmac("sha256", derived)
      .update(
        JSON.stringify({
          version: 2,
          spec,
          model,
          credentialRevision: gateway ? undefined : status,
          gateway: gateway ? { url: gateway.url, target: gateway.models[spec.id] } : undefined,
        }),
      )
      .digest("hex");
    return {
      fingerprint,
      async probe(signal) {
        const run = input.probe ?? probeModel;
        await run(model, { [spec.provider]: key }, signal, false, gateway);
        if (spec.fastMode) await run(model, { [spec.provider]: key }, signal, true, gateway);
      },
    };
  };
}
