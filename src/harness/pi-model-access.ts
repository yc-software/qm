import { type Api, type Model } from "@earendil-works/pi-ai";
import { getRequiredModel } from "../model/pi-models.ts";
import { modelGatewayRequest, type ModelGatewayTransportConfig } from "../model/provider-endpoints.ts";
import { type ProviderKeys } from "./pi-model-runtime.ts";

export interface PiModelAccessOptions {
  apiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  resolveProviderKeys?: () => Promise<ProviderKeys>;
  modelGateway?: ModelGatewayTransportConfig;
  companyModelId?: (id: string) => string;
}

export interface PiModelAccess {
  readonly gateway: ModelGatewayTransportConfig | undefined;
  providerKeys(): Promise<ProviderKeys>;
  servedId(id: string): string;
  model(id: string, company?: boolean): Model<Api>;
  keyFor(keys: ProviderKeys, model: Model<Api>): string | undefined;
}

export function createPiModelAccess(opts?: PiModelAccessOptions): PiModelAccess {
  const configuredProviderKeys: ProviderKeys = opts?.resolveProviderKeys
    ? {}
    : {
        ...(opts?.apiKey ? { anthropic: opts.apiKey } : {}),
        ...(opts?.openaiApiKey ? { openai: opts.openaiApiKey } : {}),
        ...(opts?.openrouterApiKey ? { openrouter: opts.openrouterApiKey } : {}),
      };
  const gateway = opts?.modelGateway;
  const servedId = (id: string) => (opts?.companyModelId ? opts.companyModelId(id) : id);
  return {
    gateway,
    providerKeys: async () => ({ ...configuredProviderKeys, ...(await opts?.resolveProviderKeys?.()) }),
    servedId,
    model: (id, company = true) => getRequiredModel(company ? servedId(id) : id),
    keyFor: (keys, model) => modelGatewayRequest(gateway, model)?.apiKey ?? keys[String(model.provider)],
  };
}
