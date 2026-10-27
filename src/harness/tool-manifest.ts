import { surfaceHas } from "../surfaces/surface.ts";
import { adminOperations } from "../tools/admin.ts";
import { SWARM_ACTIONS } from "../swarms/swarm.ts";

export const CRON_ACTIONS = ["create", "list", "get", "runs", "patch", "delete", "run", "disable", "note"] as const;

const READ_ONLY_TOOLS = new Set(["memory", "history", "finish_silently", "runtime", "sessions", "subagents", "swarm"]);

export interface ToolManifestInput {
  controlTools: boolean;
  surfaceTools: boolean;
  surfaceName?: string;
  delegateWork: boolean;
  sessionTools: boolean;
  readOnly: boolean;
  canvasInstall: boolean;
  adminOperations: boolean;
  connectorTools: ReadonlyArray<{ name: string; serverId: string; readOnly: boolean }>;
  clientTools: readonly string[];
}

export interface ToolManifestEntry {
  name: string;
  source: "native" | "connector" | "client";
  present: boolean;
  reason: string;
  actions?: string[];
  connector?: string;
}

const ALWAYS = "Always on.";
const CONTROL_ON = "On because an admin set up this server's control API.";
const CONTROL_OFF = "Off until an admin sets up this server's control API.";
const EXECUTE_ON = "On unless a conversation hands command work to helper agents.";
const DELEGATED = "Off because this conversation hands command work to helper agents.";
const NO_SUBAGENTS = "Off for people outside the organization.";
const POSTS_ITSELF = "On because the agent posts its own messages in this run, as in channels and scheduled runs.";
const READ_ONLY = "Off because this run is read-only.";
export const CONNECTOR_SHADOWED = "Off because a built-in tool has the same name.";

const PURPOSE: Record<string, string> = {
  execute: "Runs commands on a sandbox computer.",
  skills: "Finds and reads saved skills.",
  files: "Reads and writes files.",
  apps: "Publishes web apps.",
  memory: "Saves and recalls facts about you.",
  history: "Searches earlier parts of this conversation.",
  background: "Checks on and stops long-running commands.",
  subagents: "Hands work to helper agents that run alongside.",
  swarm: "Runs a group of helper agents that share a message board.",
  sessions: "Opens and reads other conversations in your sidebar.",
  sandbox: "Creates and manages sandbox computers.",
  cron: "Schedules future and recurring work.",
  webhook: "Starts work when another service sends an event.",
  admin: "Runs org admin tasks.",
  guidance: "Saves standing instructions for how the agent behaves.",
  attach: "Sends files with the reply.",
  finish_silently: "Ends a run without replying, such as a scheduled check with nothing to report.",
  goal: "Keeps the agent working on a long task until it is done.",
  runtime: "Switches the model the agent runs on.",
  context: "Shortens the agent's working memory in long conversations.",
};

function gate(on: boolean, yes: string, no: string): { present: boolean; reason: string } {
  return { present: on, reason: on ? yes : no };
}

export function toolManifest(input: ToolManifestInput): ToolManifestEntry[] {
  const surface = input.surfaceName ?? "slack";
  const surfaceLabel = ({ slack: "Slack", web: "the web app" } as Record<string, string>)[surface] ?? surface;
  const control = input.controlTools;
  const shared = (extra: string[]) => (control ? extra : []);
  const native = (
    name: string,
    state: { present: boolean; reason: string },
    actions?: string[],
  ): ToolManifestEntry => ({
    name,
    source: "native",
    ...state,
    reason: `${PURPOSE[name] ?? `Lets the agent post, react and read messages in ${surfaceLabel} on its own.`} ${state.reason}`,
    ...(actions ? { actions } : {}),
  });
  const always = { present: true, reason: ALWAYS };
  const builtIn = [
    native("execute", gate(!input.delegateWork, EXECUTE_ON, DELEGATED)),
    native("skills", always, ["list", "search", "read", ...shared(["share", "move"])]),
    native("files", always, [
      "read",
      "write",
      ...shared(["share"]),
      ...(input.canvasInstall ? ["install_canvas"] : []),
    ]),
    native("apps", always, ["publish", ...shared(["share", "move"])]),
    native("memory", always),
    native("history", always),
    native("background", gate(!input.delegateWork, EXECUTE_ON, DELEGATED)),
    native("subagents", gate(input.sessionTools, ALWAYS, NO_SUBAGENTS)),
    native("swarm", gate(input.sessionTools, ALWAYS, NO_SUBAGENTS), [...SWARM_ACTIONS]),
    native(
      "sessions",
      input.sessionTools
        ? gate(
            surfaceHas(surface, "sidebar"),
            "On in web conversations.",
            "Off outside the web app, the only place with a sidebar.",
          )
        : { present: false, reason: NO_SUBAGENTS },
    ),
    native("sandbox", always),
    native("cron", gate(control, CONTROL_ON, CONTROL_OFF), [...CRON_ACTIONS, "share"]),
    native("webhook", gate(control, CONTROL_ON, CONTROL_OFF)),
    native(
      "admin",
      gate(
        control,
        input.adminOperations ? CONTROL_ON : `${CONTROL_ON} Only org admins get more than a status check.`,
        CONTROL_OFF,
      ),
      input.adminOperations ? Object.keys(adminOperations) : ["whoami"],
    ),
    native("instructions", gate(control || input.surfaceTools, control ? CONTROL_ON : POSTS_ITSELF, CONTROL_OFF)),
    native(
      surface,
      gate(
        input.surfaceTools,
        POSTS_ITSELF,
        "Off in your conversations, where the agent's reply appears directly; on when it posts on its own, as in scheduled runs.",
      ),
    ),
    native(
      "attach",
      gate(
        !input.surfaceTools,
        "On because the agent's reply appears directly.",
        `Off because the agent posts its own messages in this run and sends files through the ${surface} tool.`,
      ),
    ),
    native("finish_silently", always),
    native("goal", always, ["create", "get", "update"]),
    native("runtime", always),
    native("context", always),
  ];
  const client = [...input.clientTools]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((name): ToolManifestEntry => ({
      name,
      source: "client",
      present: true,
      reason: "Provided by the page you have open.",
    }));
  const taken = new Set([...builtIn, ...client].filter((entry) => entry.present).map((entry) => entry.name));
  const connectors = input.connectorTools.map((tool): ToolManifestEntry => {
    const base = { name: tool.name, source: "connector" as const, connector: tool.serverId };
    if (input.readOnly && !tool.readOnly)
      return { ...base, present: false, reason: "Off because this run is read-only and this tool makes changes." };
    if (taken.has(tool.name)) return { ...base, present: false, reason: CONNECTOR_SHADOWED };
    return { ...base, present: true, reason: `From the ${tool.serverId} connector.` };
  });
  const scoped = [...builtIn, ...client].map((entry) =>
    input.readOnly && entry.present && !READ_ONLY_TOOLS.has(entry.name)
      ? { ...entry, present: false, reason: `${PURPOSE[entry.name] ?? ""} ${READ_ONLY}`.trim() }
      : entry,
  );
  return [...scoped, ...connectors];
}
