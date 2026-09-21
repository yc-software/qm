import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  readonly id: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly pooled: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();
const states = new WeakMap<TenantContext, Map<symbol, unknown>>();
const legacyState = new Map<symbol, unknown>();

export function createTenantContext(options: {
  id: string;
  env: Readonly<NodeJS.ProcessEnv>;
  pooled?: boolean;
}): TenantContext {
  if (!options.id.trim()) throw new Error("Tenant id must not be empty");
  if (options.env.ORG_ID !== undefined && options.env.ORG_ID !== options.id)
    throw new Error("Tenant id must match ORG_ID");
  return Object.freeze({
    id: options.id,
    env: Object.freeze({ ...options.env, ORG_ID: options.id }),
    pooled: options.pooled ?? false,
  });
}

export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

export function runWithTenant<T>(context: TenantContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function tenantEnv(): Readonly<NodeJS.ProcessEnv> {
  return currentTenant()?.env ?? process.env;
}

export function tenantState<T>(key: symbol, create: () => T): T {
  const context = currentTenant();
  let state = context ? states.get(context) : legacyState;
  if (!state) {
    state = new Map();
    states.set(context!, state);
  }
  if (!state.has(key)) state.set(key, create());
  return state.get(key) as T;
}
