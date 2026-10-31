import { signingHeaders } from "./deployment-layer.ts";
import { CliError } from "./log.ts";
import { deploymentSecretValue, isInvalidSecret } from "./util.ts";

export type CoreHttp = (path: string, init: RequestInit) => Promise<{ status: number; body: string }>;

export interface CoreLink {
  request: CoreHttp;
  close(): void;
}

export interface OperatorCredentials {
  signing: string;
  control: string;
}

export const fetchCoreAt =
  (origin: string): CoreHttp =>
  async (path, init) => {
    const response = await fetch(new URL(path, origin), init);
    return { status: response.status, body: await response.text() };
  };

export function operatorCredentials(
  values: ReadonlyMap<string, string>,
  fallback?: (name: string) => string | undefined,
): OperatorCredentials {
  const read = (name: string): string | undefined => deploymentSecretValue(name, values.get(name)) ?? fallback?.(name);
  const signing = read("CORE_SIGNING_SECRET");
  const control = read("DEPLOYMENT_CONTROL_SECRET");
  if (!signing || isInvalidSecret("CORE_SIGNING_SECRET", signing))
    throw new CliError("CORE_SIGNING_SECRET is required locally to reach the core operator routes");
  if (!control || isInvalidSecret("DEPLOYMENT_CONTROL_SECRET", control) || control === signing)
    throw new CliError("DEPLOYMENT_CONTROL_SECRET is required locally and must differ from CORE_SIGNING_SECRET");
  return { signing, control };
}

export function operatorInit(credentials: OperatorCredentials, method: "PUT", path: string, body: string): RequestInit {
  return {
    method,
    headers: {
      ...signingHeaders(credentials.signing, method, path, body),
      authorization: `Bearer ${credentials.control}`,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  };
}
