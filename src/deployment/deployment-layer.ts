export {
  compileApproval,
  credentialPathError,
  parseToolDescriptor,
  type ToolCredentialBroker,
  type ToolCredentialPath,
  type ToolDescriptor,
  type ToolInstallFile,
} from "../../cli/src/tool-descriptor.ts";

export function interpolateSplitEnv(
  template: Record<string, string>,
  ctx: { actingSlackUserId?: string },
): Record<string, string> {
  const placeholders: Record<string, string | undefined> = { actingSlackUserId: ctx.actingSlackUserId };
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(template)) {
    let missing = false;
    const value = raw.replace(/\{(\w+)\}/g, (_m, name: string) => {
      const v = Object.hasOwn(placeholders, name) ? placeholders[name] : undefined;
      if (v === undefined) {
        missing = true;
        return "";
      }
      return v;
    });
    if (missing) return {};
    out[key] = value;
  }
  return out;
}
