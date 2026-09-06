import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  compileApproval,
  parseToolDescriptor,
  type ToolCredentialPath,
  type ToolCredentialBroker,
  type ToolDescriptor,
  type ToolInstallFile,
} from "./deployment-layer.ts";
import { credentialServiceForPath } from "../credentials/resident-paths.ts";
import type { ResidentAuthConnector } from "../credentials/resident-auth.ts";
import type { CommandRule } from "../types.ts";

export interface DeploymentLayerRuntime {
  dir: string;
  tools: ToolDescriptor[];
  connectors: ResidentAuthConnector[];
  advertisedTools: string[];
  hints: string[];
  credentialPaths: ToolCredentialPath[];
  splitEnvTemplates: Record<string, string>[];
  brokeredTools: BrokeredLayerTool[];
  commandRules: CommandRule[];
  credentialTools: LayerCredentialTool[];
  installFiles: LayerInstallFile[];
}

export interface BrokeredLayerTool {
  service: string;
  binary: string;
  roots: string[];
  broker: ToolCredentialBroker;
}

export interface LayerInstallFile {
  to: string;
  mode: string;
  content: string;
}

export interface LayerCredentialTool {
  service: string;
  roots: string[];
}

export function emptyDeploymentLayer(): DeploymentLayerRuntime {
  return {
    dir: "",
    tools: [],
    connectors: [],
    advertisedTools: [],
    hints: [],
    credentialPaths: [],
    splitEnvTemplates: [],
    brokeredTools: [],
    commandRules: [],
    credentialTools: [],
    installFiles: [],
  };
}

function assertDistinctInstallTargets(tools: ToolDescriptor[]): void {
  const owners = new Map<string, string>();
  for (const tool of tools) {
    for (const file of tool.install?.files ?? []) {
      const owner = owners.get(file.to);
      if (owner !== undefined && owner !== tool.id) {
        throw new Error(
          `deployment layer tools "${owner}" and "${tool.id}" both install ${JSON.stringify(file.to)} — every installed path needs exactly one owner`,
        );
      }
      owners.set(file.to, tool.id);
    }
  }
}

export function declaredInstallFiles(
  tools: ToolDescriptor[],
  read: (tool: ToolDescriptor, file: ToolInstallFile) => string,
): LayerInstallFile[] {
  assertDistinctInstallTargets(tools);
  return tools
    .flatMap((tool) =>
      (tool.install?.files ?? []).map((file) => ({ to: file.to, mode: file.mode, content: read(tool, file) })),
    )
    .sort((a, b) => a.to.localeCompare(b.to));
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

function toolServices(tool: ToolDescriptor): string[] {
  const services = new Set(
    (tool.auth?.credentialPaths ?? []).flatMap((entry) => credentialServiceForPath(entry.path) ?? []),
  );
  return services.has(tool.id) || services.size === 0 ? [tool.id] : [...services];
}

export function resolvedDeploymentLayer(
  dir: string,
  tools: ToolDescriptor[],
  installFiles: LayerInstallFile[] = [],
): DeploymentLayerRuntime {
  assertDisjointCredentialLinks(tools);
  assertDistinctInstallTargets(tools);
  const withAuth = tools.filter((t) => t.auth);
  const brokered = withAuth.filter((t) => t.auth!.broker);
  if (brokered.length > 1) {
    throw new Error(
      `deployment layer declares credential brokers on multiple tools (${brokered.map((t) => t.id).join(", ")}) — ambient credential vending supports one brokered tool per deployment`,
    );
  }
  return {
    dir,
    tools,
    connectors: withAuth
      .filter((t) => !t.auth!.broker)
      .map((t) => ({
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
    commandRules: tools.flatMap((tool) =>
      (tool.approvals ?? []).map((approval) => ({
        ...compileApproval(tool.install?.binary ?? tool.id, approval),
        ...(approval.reason ? { reason: approval.reason } : {}),
      })),
    ),
    credentialTools: withAuth.flatMap((t) =>
      toolServices(t).map((service) => ({
        service,
        roots: (t.auth!.credentialPaths ?? []).flatMap((entry) =>
          credentialServiceForPath(entry.path) === service ? [entry.path] : [],
        ),
      })),
    ),
    installFiles,
  };
}

export function replaceDeploymentLayer(target: DeploymentLayerRuntime, source: DeploymentLayerRuntime): void {
  target.dir = source.dir;
  for (const key of [
    "tools",
    "connectors",
    "advertisedTools",
    "hints",
    "credentialPaths",
    "splitEnvTemplates",
    "brokeredTools",
    "commandRules",
    "credentialTools",
    "installFiles",
  ] as const) {
    target[key].splice(0, target[key].length, ...(source[key] as never[]));
  }
}

const JUNK_FILE = /^(?:\.DS_Store|Thumbs\.db|\._.*)$/;

export function loadDeploymentLayer(dir: string): DeploymentLayerRuntime {
  if (!existsSync(dir)) {
    throw new Error(
      `DEPLOYMENT_LAYER points at ${dir}, which does not exist — a configured layer must be present at boot`,
    );
  }
  const toolsDir = join(dir, "tools");
  const tools: ToolDescriptor[] = [];
  const toolDirs = new Map<string, string>();
  if (existsSync(toolsDir)) {
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
      if (!existsSync(path)) throw new Error(`${join(toolsDir, entry.name)} has no tool.json`);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a regular file`);
      const desc = parseToolDescriptor(readFileSync(path, "utf8"), path);
      if (tools.some((t) => t.id === desc.id)) throw new Error(`${path}: duplicate tool id "${desc.id}"`);
      tools.push(desc);
      toolDirs.set(desc.id, join(toolsDir, entry.name));
    }
  }
  const installFiles = declaredInstallFiles(tools, (tool, file) =>
    readLayerTextFile(join(toolDirs.get(tool.id)!, file.from)),
  );
  return resolvedDeploymentLayer(dir, tools, installFiles);
}

function readLayerTextFile(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is declared under install.files but does not exist`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} must be a regular file`);
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${path} must be UTF-8 text — the deployment layer delivers text tools only`);
  }
  return text;
}
