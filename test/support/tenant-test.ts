import * as nodeTest from "node:test";
import { withTenant } from "../../src/tenants/context.ts";
import { TEST_TENANT } from "./test-tenant.ts";

export { TEST_TENANT };
export { describe, mock, suite } from "node:test";
export type { TestContext } from "node:test";

type Body = (...args: never[]) => unknown;

function bind(fn: Body): Body {
  const run = fn as (...args: unknown[]) => unknown;
  if (fn.length >= 2) return ((t: unknown, done: unknown) => withTenant(TEST_TENANT, () => run(t, done))) as Body;
  return ((t: unknown) => withTenant(TEST_TENANT, () => run(t))) as Body;
}

function bindArgs<F extends (...args: never[]) => unknown>(base: F): F {
  const call = base as unknown as (...a: unknown[]) => unknown;
  const bound = (...args: unknown[]) => {
    const at = args.findLastIndex((a) => typeof a === "function");
    if (at >= 0) args[at] = bind(args[at] as Body);
    return call(...args);
  };
  return bound as unknown as F;
}

function bindRunner<F extends typeof nodeTest.test>(base: F): F {
  const bound = bindArgs(base);
  return Object.assign(bound, base, {
    skip: bindArgs(base.skip),
    only: bindArgs(base.only),
    todo: bindArgs(base.todo),
  });
}

export const test = bindRunner(nodeTest.test);
export const it = bindRunner(nodeTest.it);
export const before = bindArgs(nodeTest.before);
export const after = bindArgs(nodeTest.after);
export const beforeEach = bindArgs(nodeTest.beforeEach);
export const afterEach = bindArgs(nodeTest.afterEach);

export function tenantTest(name: string, fn: (t: nodeTest.TestContext) => void | Promise<void>): void {
  void nodeTest.test(name, (t) => withTenant(TEST_TENANT, () => fn(t)));
}

export function inTestTenant<T>(fn: () => T): T {
  return withTenant(TEST_TENANT, fn);
}
