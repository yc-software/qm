import { parseScopeId } from "../types.ts";
import { isProjectGroupRef } from "../projects/project-store.ts";

export function supportsAmbientControls(scope: string): boolean {
  const { kind, ref } = parseScopeId(scope);
  return !!ref && (kind === "channel" || (kind === "group" && !isProjectGroupRef(ref)));
}

export const UNSUPPORTED_AMBIENT_CONTROLS =
  "Web projects support standing orders, but not ambient behavior or bot handling. Omit bots and ambientEnabled.";
