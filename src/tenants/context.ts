import {
  boundTenant,
  isTenantId,
  pinTenant,
  withoutTenant,
  withTenant as bindTenant,
} from "../../plugins/chassis/src/tenant.ts";

export { boundTenant, isTenantId, pinTenant, withoutTenant };

type BindHook = (tenant: string) => Promise<unknown>;
const bindHooks = new Map<BindHook, Map<string, Promise<void> | true>>();

export function onFirstBind(hook: BindHook): () => void {
  bindHooks.set(hook, new Map());
  return () => bindHooks.delete(hook);
}

function prepare(tenant: string): Promise<void> | undefined {
  const pending: Array<Promise<void>> = [];
  for (const [hook, done] of bindHooks) {
    const existing = done.get(tenant);
    if (existing === true) continue;
    if (existing) {
      pending.push(existing);
      continue;
    }
    const run = Promise.resolve(tenant)
      .then(hook)
      .then(() => void done.set(tenant, true));
    done.set(tenant, run);
    run.catch(() => done.get(tenant) === run && done.delete(tenant));
    pending.push(run);
  }
  return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
}

export function tenantReady(): Promise<void> {
  return prepare(currentTenant()) ?? Promise.resolve();
}

export function withTenant<T>(id: string, fn: () => T): T {
  if (bindHooks.size && isTenantId(id)) prepare(id)?.catch(() => undefined);
  return bindTenant(id, fn);
}

export function currentTenant(): string {
  const id = boundTenant();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}

export function perTenant<V>(create: () => V): () => V {
  const values = new Map<string, V>();
  return () => {
    const id = currentTenant();
    const existing = values.get(id);
    if (existing !== undefined) return existing;
    const value = create();
    values.set(id, value);
    return value;
  };
}
