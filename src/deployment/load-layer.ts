import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  compileApproval,
  parseToolDescriptor,
  type ToolCredentialBroker,
  type ToolCredentialPath,
  type ToolDescriptor,
} from "./deployment-layer.ts";
import { credentialServiceForPath } from "../credentials/resident-paths.ts";
import type { ResidentAuthConnector } from "../credentials/resident-auth.ts";
import type { CommandRule } from "../types.ts";

export interface DeploymentLayerRuntime {
  dir: string;
  dataFiles: DeploymentLayerDataFile[];
  tools: ToolDescriptor[];
  connectors: ResidentAuthConnector[];
  advertisedTools: string[];
  hints: string[];
  credentialPaths: ToolCredentialPath[];
  splitEnvTemplates: Record<string, string>[];
  commandRules: CommandRule[];
  brokeredTools: BrokeredLayerTool[];
}

export interface DeploymentLayerDataFile {
  path: string;
  content: string;
}

export interface BrokeredLayerTool {
  service: string;
  binary: string;
  roots: string[];
  broker: ToolCredentialBroker;
}

export function emptyDeploymentLayer(): DeploymentLayerRuntime {
  return {
    dir: "",
    dataFiles: [],
    tools: [],
    connectors: [],
    advertisedTools: [],
    hints: [],
    credentialPaths: [],
    splitEnvTemplates: [],
    commandRules: [],
    brokeredTools: [],
  };
}

function assertDisjointCredentialLinks(tools: ToolDescriptor[]): void {
  const links = tools.flatMap((tool) => (tool.auth?.credentialPaths ?? []).map((entry) => ({ id: tool.id, ...entry })));
  for (const a of links) {
    const b = links.find(
      (other) =>
        other !== a &&
        (a.path === other.path
          ? a.kind !== other.kind
          : a.path.startsWith(`${other.path}/`) || other.path.startsWith(`${a.path}/`)),
    );
    if (b) {
      throw new Error(
        `deployment layer tools "${a.id}" and "${b.id}" declare incompatible credential paths ${JSON.stringify(a.path)} and ${JSON.stringify(b.path)} — declare matching kinds for shared paths or disjoint paths`,
      );
    }
  }
}

function toolService(tool: ToolDescriptor, why: string): string {
  const services = new Set(
    (tool.auth?.credentialPaths ?? []).flatMap((entry) => credentialServiceForPath(entry.path) ?? []),
  );
  if (services.has(tool.id) || services.size === 0) return tool.id;
  if (services.size === 1) return [...services][0]!;
  throw new Error(
    `deployment tool "${tool.id}" has ${why} but its credential paths map to multiple services: ${[...services].join(", ")}`,
  );
}

export function resolvedDeploymentLayer(
  dir: string,
  tools: ToolDescriptor[],
  dataFiles: DeploymentLayerDataFile[] = [],
): DeploymentLayerRuntime {
  assertDisjointCredentialLinks(tools);
  const withAuth = tools.filter((t) => t.auth);
  const brokered = withAuth.filter((t) => t.auth!.broker);
  if (brokered.length > 1) {
    throw new Error(
      `deployment layer declares credential brokers on multiple tools (${brokered.map((t) => t.id).join(", ")}) — ambient credential vending supports one brokered tool per deployment`,
    );
  }
  return {
    dir,
    dataFiles: dataFiles.map((file) => ({ ...file })),
    tools,
    connectors: withAuth.map((t) => ({
      id: t.id,
      label: t.label ?? t.id,
      check: t.auth!.check,
      reauth: t.auth!.reauth,
    })),
    advertisedTools: tools.flatMap((t) => (t.advertise ? [t.advertise] : [])),
    hints: tools.flatMap((t) => t.hints ?? []),
    credentialPaths: [
      ...new Map(withAuth.flatMap((t) => t.auth!.credentialPaths ?? []).map((entry) => [entry.path, entry])).values(),
    ],
    splitEnvTemplates: withAuth.flatMap((t) => (t.auth!.splitEnv ? [t.auth!.splitEnv] : [])),
    commandRules: tools.flatMap((tool) =>
      (tool.approvals ?? []).map((approval) => ({
        ...compileApproval(tool.install?.binary ?? tool.id, approval),
        ...(approval.reason ? { reason: approval.reason } : {}),
      })),
    ),
    brokeredTools: brokered.map((t) => {
      const service = toolService(t, "a credential broker");
      return {
        service,
        binary: t.install?.binary ?? t.id,
        roots: (t.auth!.credentialPaths ?? []).flatMap((entry) =>
          credentialServiceForPath(entry.path) === service ? [entry.path] : [],
        ),
        broker: t.auth!.broker!,
      };
    }),
  };
}

export function replaceDeploymentLayer(target: DeploymentLayerRuntime, source: DeploymentLayerRuntime): void {
  target.dir = source.dir;
  for (const key of [
    "dataFiles",
    "tools",
    "connectors",
    "advertisedTools",
    "hints",
    "credentialPaths",
    "splitEnvTemplates",
    "commandRules",
    "brokeredTools",
  ] as const) {
    target[key].splice(0, target[key].length, ...(source[key] as never[]));
  }
}

const JUNK_FILE = /^(?:\.DS_Store|Thumbs\.db|\._.*)$/;

function regularDirectoryExists(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} must be a regular directory`);
  return true;
}

function loadTextFiles(root: string, dir: string): DeploymentLayerDataFile[] {
  if (!regularDirectoryExists(dir)) return [];
  const files: DeploymentLayerDataFile[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).filter((entry) => !JUNK_FILE.test(entry.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path, relativePath);
        continue;
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a regular file`);
      const bytes = readFileSync(path);
      if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
        throw new Error(`deployment layer data must be UTF-8 text: ${path}`);
      files.push({ path: `${root}/${relativePath}`, content: bytes.toString("utf8") });
    }
  };
  walk(dir, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function loadDeploymentLayer(dir: string): DeploymentLayerRuntime {
  if (!regularDirectoryExists(dir)) {
    throw new Error(
      `DEPLOYMENT_LAYER points at ${dir}, which does not exist — a configured layer must be present at boot`,
    );
  }
  const toolsDir = join(dir, "tools");
  const tools: ToolDescriptor[] = [];
  if (regularDirectoryExists(toolsDir)) {
    const entries = readdirSync(toolsDir, { withFileTypes: true })
      .filter((entry) => !JUNK_FILE.test(entry.name))
      .sort((a, b) => {
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
      });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        throw new Error(
          `${join(toolsDir, entry.name)} is not a tool directory; the layer only accepts tools/<id>/tool.json`,
        );
      }
      const path = join(toolsDir, entry.name, "tool.json");
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) throw new Error(`${join(toolsDir, entry.name)} has no tool.json`);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a regular file`);
      const desc = parseToolDescriptor(readFileSync(path, "utf8"), path);
      if (tools.some((t) => t.id === desc.id)) throw new Error(`${path}: duplicate tool id "${desc.id}"`);
      tools.push(desc);
    }
  }
  return resolvedDeploymentLayer(dir, tools, loadTextFiles("data", join(dir, "data")));
}
