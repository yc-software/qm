import { createHash } from "node:crypto";
import type { McpSkillClient, McpSkillEntry } from "../mcp/mcp-client.ts";
import type { McpServer, McpServerStore } from "../mcp/mcp-server-store.ts";
import { PACK_LIMITS, type SkillPackFetcher } from "./pack-fetcher.ts";
import type { SkillPack } from "./skill-pack-store.ts";
import { isSafeSkillName } from "./skill-name.ts";
import { hashId } from "../util/crypto.ts";

function listingVersion(entries: readonly McpSkillEntry[]): string {
  return hashId(entries.map((entry) => `${entry.uri} ${entry.digest}`).sort(), 40);
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
        if (`sha256:${createHash("sha256").update(skill.text, "utf8").digest("hex")}` !== skill.digest)
          throw new Error(`MCP skill ${skill.uri} does not match its listed digest`);
        return { path: `${skill.name}/SKILL.md`, text: skill.text, binary: false };
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { commit: listingVersion(skills), files };
    },
  };
}
