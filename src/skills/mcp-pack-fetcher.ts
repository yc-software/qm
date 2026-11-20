import { createHash } from "node:crypto";
import type { McpSkillClient, McpSkillEntry } from "../mcp/mcp-client.ts";
import type { McpServer, McpServerStore } from "../mcp/mcp-server-store.ts";
import { PACK_LIMITS, type SkillPackFetcher } from "./pack-fetcher.ts";
import type { SkillPack } from "./skill-pack-store.ts";
import { isSafeSkillName } from "./skill-name.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function listingVersion(entries: readonly McpSkillEntry[]): string {
  return sha256(
    entries
      .map((entry) => `${entry.uri} ${entry.digest}`)
      .sort()
      .join("\n"),
  ).slice(0, 40);
}

export function createMcpPackFetcher(opts: {
  servers: Pick<McpServerStore, "list">;
  clientFor: (server: McpServer) => McpSkillClient;
}): SkillPackFetcher {
  async function source(pack: SkillPack): Promise<McpSkillClient> {
    const matches = (await opts.servers.list()).filter((server) => server.enabled && server.url === pack.url);
    const server = matches[0];
    if (!server || matches.length > 1)
      throw new Error(`skill pack ${pack.id} needs exactly one enabled MCP server at ${pack.url}`);
    if ((server.credentialScope ?? "shared") !== "shared" || server.auth === "oauth-user")
      throw new Error(`MCP server ${server.id} signs in per person, so it cannot supply an org skill pack`);
    return opts.clientFor(server);
  }

  return {
    async resolveRef(pack) {
      return listingVersion(await (await source(pack)).listSkills(PACK_LIMITS));
    },
    async fetch(pack) {
      const skills = await (await source(pack)).readSkills(PACK_LIMITS);
      const files = skills.map((skill) => {
        if (!isSafeSkillName(skill.name)) throw new Error(`MCP skill ${skill.uri} has an unusable name`);
        const digest = `sha256:${sha256(skill.text)}`;
        if (digest !== skill.digest || Buffer.byteLength(skill.text, "utf8") !== skill.size)
          throw new Error(`MCP skill ${skill.uri} does not match its listed digest and size`);
        return { path: `${skill.name}/SKILL.md`, text: skill.text, binary: false };
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { commit: listingVersion(skills), files };
    },
  };
}
