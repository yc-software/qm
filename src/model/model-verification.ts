import { createHmac } from "node:crypto";
import { probeModel } from "../harness/pi-harness.ts";
import { modelFromOverlay } from "./pi-models.ts";
import type { ModelOverlay } from "./model-overlay.ts";
import type { ModelCredentialStore } from "./model-credential-store.ts";
import type { ModelGatewayTransportConfig } from "./provider-endpoints.ts";

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

export function verificationFailure(error: unknown): ModelVerificationError {
  if (error instanceof ModelVerificationError) return error;
  const text = error instanceof Error ? error.message : "";
  if (/timeout|aborted|aborterror/i.test(text))
    return new ModelVerificationError("timeout", "Verification timed out. Try again; the model was not enabled.");
  if (/401|403|unauthori[sz]ed|forbidden|permission|authentication|(?:invalid|incorrect).api.key/i.test(text))
    return new ModelVerificationError(
      "access_denied",
      "The serving credential cannot access this model. Check its provider permissions.",
    );
  if (/429|quota|rate.limit|billing|credit|resource.exhausted/i.test(text))
    return new ModelVerificationError(
      "quota_or_rate_limit",
      "The provider reports a quota, billing, or rate limit. Resolve it and verify again.",
    );
  if (/404|not.found|does not exist|model.*unavailable/i.test(text))
    return new ModelVerificationError(
      "model_unavailable",
      "The provider could not serve this model ID. Check the ID and credential access.",
    );
  if (/\b5\d\d\b/.test(text))
    return new ModelVerificationError(
      "provider_failure",
      "The provider is temporarily unable to complete verification. Try again later.",
    );
  if (/400|422|unsupported|invalid.*(parameter|request)|not.supported/i.test(text))
    return new ModelVerificationError(
      "unsupported_configuration",
      "The provider rejected this configuration. Check the template and fast-mode capability.",
    );
  return new ModelVerificationError(
    "provider_failure",
    "The provider did not complete the verification request. Try again or check provider status.",
  );
}

export function createModelVerifier(input: {
  credentials: ModelCredentialStore;
  keyMaterial: string | Buffer;
  modelGateway?: ModelGatewayTransportConfig;
  probe?: typeof probeModel;
}): ModelVerifier {
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
    const fingerprint = createHmac("sha256", input.keyMaterial)
      .update(
        JSON.stringify({
          version: 1,
          spec,
          model,
          key,
          credentialRevision: gateway ? undefined : status,
          gateway: gateway
            ? { url: gateway.url, apiKeyHeader: gateway.apiKeyHeader, target: gateway.models[spec.id] }
            : undefined,
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
