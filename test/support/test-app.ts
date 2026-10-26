import type { BuiltApp } from "../../src/wiring.ts";
import { buildApp } from "./build-app.ts";
import { recordSurfacePosts, type PostLog } from "./recording-outbound.ts";

export function buildTestApp(...args: Parameters<typeof buildApp>): BuiltApp & { posts: PostLog } {
  const built = buildApp(...args);
  return Object.assign(built, { posts: recordSurfacePosts(built.outbound) });
}

export type TestApp = ReturnType<typeof buildTestApp>;
