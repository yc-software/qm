import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import type { ProviderKeys } from "./model-runtime.ts";
import { modelDisplayName } from "./pi-models.ts";

export type ModelBilling = "model_gateway" | "org_key" | "personal_account";

export interface ModelRoute {
  modelId: string;
  model: Model<Api>;
  keys: ProviderKeys;
  gateway?: ModelGatewayTransportConfig;
  billing: ModelBilling;
}

const BILLING_LABELS: Record<ModelBilling, string> = {
  model_gateway: "the shared model gateway",
  org_key: "the organization's own provider key",
  personal_account: "the person's own account",
};

export function modelBilling(viaGateway: boolean, personal: boolean): ModelBilling {
  if (personal) return "personal_account";
  return viaGateway ? "model_gateway" : "org_key";
}

export function routeLabel(route: Pick<ModelRoute, "modelId" | "billing">): string {
  return `${modelDisplayName(route.modelId)} (billed to ${BILLING_LABELS[route.billing]})`;
}
