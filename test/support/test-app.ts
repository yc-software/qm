import { buildApp } from "../../src/wiring.ts";
import { recordSurfacePosts, type PostLog } from "./recording-outbound.ts";

export function buildTestApp(...args: Parameters<typeof buildApp>): ReturnType<typeof buildApp> & { posts: PostLog } {
  const built = buildApp(...args);
  return Object.assign(built, { posts: recordSurfacePosts(built.outbound) });
}

export type TestApp = ReturnType<typeof buildTestApp>;
