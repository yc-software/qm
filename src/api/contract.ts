export const CAPABILITY_HEADER = "x-agent-capability";
export const SANDBOX_MODEL_PREFIX = "/v1/sandbox-model";

export function sandboxModelOpenAiBaseUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}${SANDBOX_MODEL_PREFIX}/v1`;
}
