import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createMcpClient, type McpSkill } from "../src/mcp/mcp-client.ts";
import type { McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpPackFetcher } from "../src/skills/mcp-pack-fetcher.ts";
import type { SkillPack } from "../src/skills/skill-pack-store.ts";

const body = (name: string) => `---\nname: ${name}\ndescription: Does ${name}\n---\n\nSteps for ${name}.\n`;
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const skill = (name: string, text = body(name)): McpSkill => ({
  uri: `skill://${name}/SKILL.md`,
  name,
  digest: digest(text),
  size: Buffer.byteLength(text),
  text,
});
const server = (over: Partial<McpServer> = {}): McpServer => ({
  id: "skills",
  name: "Skills",
  url: "https://skills.example/mcp",
  auth: "bearer",
  readOnly: true,
  enabled: true,
  updatedAt: 0,
  updatedBy: "admin",
  ...over,
});
const pack = { id: "p1", kind: "mcp", url: "https://skills.example/mcp" } as SkillPack;

function fetcherOver(servers: McpServer[], skills: McpSkill[]) {
  return createMcpPackFetcher({
    servers: { list: async () => servers },
    clientFor: () => ({ listSkills: async () => skills, readSkills: async () => skills }),
  });
}

test("the MCP client lists skills and reads each SKILL.md over the skills extension", async () => {
  const listed = [skill("alpha"), skill("beta")];
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw) as { id?: number; method: string; params?: { cursor?: string; uri?: string } };
    if (message.id === undefined) return void res.writeHead(202).end();
    const page = message.params?.cursor ? listed.slice(1) : listed.slice(0, 1);
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: "2025-06-18",
        capabilities: { resources: {} },
        serverInfo: { name: "t", version: "1" },
      },
      "skills/list": {
        skills: page.map((s) => ({
          uri: s.uri,
          frontmatter: { name: s.name },
          resources: [{ uri: s.uri, digest: s.digest, size: s.size }],
        })),
        ...(message.params?.cursor ? {} : { nextCursor: "2" }),
      },
      "resources/read": {
        contents: [{ uri: message.params?.uri, text: listed.find((s) => s.uri === message.params?.uri)?.text }],
      },
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: results[message.method] }));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  try {
    const { port } = http.address() as AddressInfo;
    const client = createMcpClient({
      url: `http://127.0.0.1:${port}/mcp`,
      auth: { mode: "none" },
      fetch: (url, init) => fetch(url, init),
    });
    assert.deepEqual(await client.readSkills({ maxFiles: 5000, maxTotalBytes: 1 << 20 }), listed);
    await assert.rejects(client.listSkills({ maxFiles: 1, maxTotalBytes: 1 << 20 }), (e: Error) =>
      String((e.cause as Error).message).includes("more than 1 skills"),
    );
  } finally {
    http.close();
  }
});

test("an MCP pack's version follows the listed digests, and its files are each verified SKILL.md", async () => {
  const skills = [skill("beta"), skill("alpha")];
  const fetcher = fetcherOver([server(), server({ id: "off", enabled: false })], skills);
  const version = await fetcher.resolveRef(pack);
  assert.equal(await fetcherOver([server()], [...skills].reverse()).resolveRef(pack), version);
  assert.notEqual(await fetcherOver([server()], [skill("alpha", "changed")]).resolveRef(pack), version);
  assert.deepEqual(await fetcher.fetch(pack), {
    commit: version,
    files: ["alpha", "beta"].map((name) => ({ path: `${name}/SKILL.md`, text: body(name), binary: false })),
  });
  await assert.rejects(fetcherOver([server()], [{ ...skill("alpha"), text: "tampered" }]).fetch(pack), /listed digest/);
  await assert.rejects(fetcherOver([server()], [skill("../x")]).fetch(pack), /unusable name/);
});

test("an MCP pack needs one enabled server with shared credentials at its URL", async () => {
  await assert.rejects(fetcherOver([], []).resolveRef(pack), /exactly one enabled MCP server/);
  await assert.rejects(fetcherOver([server(), server({ id: "twin" })], []).resolveRef(pack), /exactly one/);
  await assert.rejects(fetcherOver([server({ credentialScope: "per-user" })], []).resolveRef(pack), /per person/);
  await assert.rejects(fetcherOver([server({ auth: "oauth-user" })], []).resolveRef(pack), /per person/);
});
