import type { DirectoryStore } from "../directory/directory-store.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";

export async function memoryRecallLabels(
  scopes: readonly ScopeId[],
  directory?: Pick<DirectoryStore, "get" | "resolveChannel">,
  projects?: Pick<ProjectStore, "recognizes" | "name">,
): Promise<Map<string, string>> {
  const labels = await Promise.all(
    scopes.map(async (scope): Promise<[string, string]> => {
      const { kind, ref } = parseScopeId(scope);
      let label: string | undefined;
      if (kind === "personal" && ref) {
        label = (await directory?.get(ref).catch(swallowAs("memory label: person", null)))?.displayName ?? ref;
      } else if (kind === "org") {
        label = "Organization";
      } else if (kind === "group" && ref && projects?.recognizes(ref)) {
        const name = await projects.name(ref).catch(swallowAs("memory label: project", undefined));
        if (name) label = `${name} (web project)`;
      } else if ((kind === "channel" || kind === "group") && ref) {
        const resolved = await directory?.resolveChannel(ref).catch(swallowAs("memory label: channel", null));
        if (resolved?.kind === "one" && resolved.channel.channelId.toLowerCase() === ref.toLowerCase())
          label = kind === "channel" ? `#${resolved.channel.name}` : resolved.channel.name;
      }
      return [scope, label?.replace(/\s+/g, " ").trim() || scope];
    }),
  );
  return new Map(labels);
}
