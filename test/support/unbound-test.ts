import * as nodeTest from "node:test";
import { withoutTenant } from "../../src/tenants/context.ts";

function unbound<F extends (...args: never[]) => unknown>(register: F): F {
  const call = register as unknown as (...args: unknown[]) => unknown;
  return Object.assign((...args: unknown[]) => withoutTenant(() => call(...args)), register) as unknown as F;
}

export const test = unbound(nodeTest.test);
export const it = unbound(nodeTest.it);
export const describe = unbound(nodeTest.describe);
export const before = unbound(nodeTest.before);
export const after = unbound(nodeTest.after);
