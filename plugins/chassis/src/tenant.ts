import { AsyncLocalStorage } from "node:async_hooks";

const MINT = Symbol("tenant");
let mint: (id: string) => Tenant;

export class Tenant {
  readonly #id: string;

  private constructor(key: symbol, id: string) {
    if (key !== MINT) throw new Error("Tenant tokens are minted only by withTenant");
    this.#id = id;
  }

  get id(): string {
    return this.#id;
  }

  static {
    mint = (id) => new Tenant(MINT, id);
  }
}

const binding = new AsyncLocalStorage<Tenant | undefined>();
const pinned = new AsyncLocalStorage<{ tenant: string | undefined; open: boolean }>();
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

export function withTenant<T>(id: string, fn: (tenant: Tenant) => T): T {
  if (!isTenantId(id)) throw new Error(`Tenant id must be a lowercase uuid, got ${JSON.stringify(id)}`);
  const tenant = mint(id);
  return bind(tenant, () => fn(tenant));
}

export function withoutTenant<T>(fn: () => T): T {
  return bind(undefined, fn);
}

export async function pinTenant<T>(tenant: string | undefined, fn: () => Promise<T>): Promise<T> {
  const pin = { tenant, open: true };
  try {
    return await pinned.run(pin, fn);
  } finally {
    pin.open = false;
  }
}

function bind<T>(tenant: Tenant | undefined, fn: () => T): T {
  const pin = pinned.getStore();
  if (pin?.open && pin.tenant !== tenant?.id) throw new Error("A transaction is already open for another tenant");
  return binding.run(tenant, fn);
}

export function boundTenant(): string | undefined {
  return binding.getStore()?.id;
}

export function ambientTenant(): Tenant {
  const tenant = binding.getStore();
  if (tenant === undefined) throw new Error("No tenant is bound to this work");
  return tenant;
}

export function explicitTenantId(tenant: Tenant): string {
  if (!(tenant instanceof Tenant)) throw new Error("Tenant tokens are minted only by withTenant");
  const bound = binding.getStore();
  if (bound !== undefined && bound.id !== tenant.id)
    throw new Error(`Work bound to tenant ${bound.id} used an explicit token for tenant ${tenant.id}`);
  return tenant.id;
}
