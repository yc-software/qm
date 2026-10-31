import { Check } from "typebox/value";
import { isObj } from "../../util/objects.ts";
import { MaskedExecutionError } from "../../security/secret-masking.ts";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { CONFIG_DEFAULTS } from "../../config.ts";
import { NeedsApproval, CommandDenied } from "../../tools/primitives.ts";
import { errMessage } from "../../util/errors.ts";
import { computerVerdict } from "../../sandbox/sandbox.ts";
import { redactSecrets } from "../../../plugins/chassis/src/redact-secrets.ts";
import { SANDBOX_CAPABILITY_TTL_MS } from "../../auth/capability-token.ts";
import { text, type ToolKit } from "./kit.ts";

function fmtStatus(s: { state: "running" } | { state: "exited"; code: number }): string {
  return s.state === "exited" ? `exited ${s.code}` : "running";
}

const PRESSURE_WARN_FULL60 = 50;

export function computerTools(kit: ToolKit) {
  const { ref, opts, log, recordCall, recordResult, blockOnApproval } = kit;
  const reachExec = !!opts?.reachExec;
  const execTimeoutSec = Math.round((opts?.execTimeoutMs ?? CONFIG_DEFAULTS.execTimeoutDefaultSec * 1000) / 1000);
  const execCeilingSec = Math.round((opts?.execTimeoutCeilingMs ?? CONFIG_DEFAULTS.execTimeoutMaxSec * 1000) / 1000);
  const bgTtlSec = Math.round((opts?.backgroundJobTtlMs ?? CONFIG_DEFAULTS.backgroundJobTtlSec * 1000) / 1000);
  const bgTtlMaxSec = Math.round((opts?.backgroundJobTtlMaxMs ?? CONFIG_DEFAULTS.backgroundJobTtlMaxSec * 1000) / 1000);
  const bgTtlMin = Math.round(bgTtlSec / 60);
  const bgTtlMaxMin = Math.round(bgTtlMaxSec / 60);
  const capabilityTtlMs = opts?.sandboxCapabilityTtlMs ?? SANDBOX_CAPABILITY_TTL_MS;
  const capabilityTtlHours = capabilityTtlMs / 3_600_000;
  const capabilityExpiry =
    capabilityTtlMs === 0
      ? "Those turn tokens do not expire here, but authorization checks still apply."
      : `Those turn tokens expire ${capabilityTtlHours} hours after the launching turn started (then they 401), so publish checkpoints to Files before that and keep the file ID.`;
  const EXECUTE_TIMEOUT_GUIDANCE =
    "Commands may run under POSIX sh; wrap bash-only syntax in bash -c. " +
    `Timeout default ${execTimeoutSec}s, max ${execCeilingSec}s: raise \`timeout_seconds\` for builds/installs/tests, lower it for quick commands. ` +
    "For anything longer, and for servers, use background:true (never a shell ampersand) and the background tool. " +
    "On hangs or unexplained transport errors use sandbox status/restart; if that fails twice, create a fresh sandbox, set it default, and recover work from git or Files.";

  const executeBaseParams = {
    command: Type.String({ description: "The shell command to run." }),
    background: Type.Optional(
      Type.Boolean({
        description: "Run detached and return a process_id for the background tool. Scoped only.",
      }),
    ),
    sandbox_id: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Exact sandbox ID; omit to use this scope's default.",
      }),
    ),
    purpose: Type.String({
      description:
        'Intent label, at most 4 words, starting with an -ing verb (e.g. "Checking disk space"), describing the purpose not the code; shown in activity and approval requests.',
    }),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: `Seconds until kill (exit 124); default ${execTimeoutSec}, max ${execCeilingSec}. With background:true, the job lifetime (default ${bgTtlSec}, max ${bgTtlMaxSec}).`,
      }),
    ),

    credentials: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Exact authorized credential handles to materialize for this command only (for a background job, until it exits). Newly granted handles are accepted. In a shared conversation, credentials other than brokered org services run on this turn's scratch computer instead, even with sandbox_id (no shared workspace files: fetch scripts from Files or git in the command); a background job naming them gets its own computer that nothing else can reach.",
      }),
    ),
  };

  const runExecute = async (
    callId: string,
    params: {
      command: string;
      sandbox_id?: string;
      timeout_seconds?: number;
      purpose?: string;
      credentials?: string[];
    },
    route?: { scratch?: boolean; reachTarget?: string },
  ) => {
    const tc = ref.current;
    if (!tc) return text("[error] no active tool context");
    let scopeNote: { scope?: string } = {};
    if (route?.reachTarget !== undefined) {
      scopeNote = { scope: route.reachTarget };
    } else if (route !== undefined) {
      scopeNote = { scope: route.scratch ? "scratch" : "scoped" };
    }
    await recordCall(callId, {
      tool: "execute",
      command: params.command,
      purpose: params.purpose,
      ...scopeNote,
      ...(params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {}),
    });
    try {
      const execOpts = {
        ...(params.sandbox_id !== undefined ? { sandboxId: params.sandbox_id } : {}),
        ...(params.timeout_seconds !== undefined ? { timeoutSeconds: params.timeout_seconds } : {}),
        ...(route?.scratch ? { scratch: true } : {}),
        ...(route?.reachTarget !== undefined ? { reachTarget: route.reachTarget } : {}),
        ...(params.credentials?.length ? { credentials: params.credentials } : {}),
        ...(ref.abortSignal ? { signal: ref.abortSignal } : {}),
      };
      const r = await tc.execute(params.command, Object.keys(execOpts).length ? execOpts : undefined);
      const { stdout: _stdout, stderr: _stderr, scratchReroute, ...execMeta } = r;
      const resultScope = scratchReroute ? { scope: "scratch" } : scopeNote;
      const parts = [r.stdout, r.stderr ? `[stderr]\n${r.stderr}` : ""].filter(Boolean).join("\n");
      let placePrefix = "";
      if (r.reached) placePrefix = `[ran on ${r.reached.label}'s computer]\n`;
      else if (scratchReroute)
        placePrefix =
          "[ran on this turn's scratch computer, not the shared one, because it names a private credential; its files are discarded after the turn]\n";
      const localExec = !route?.scratch && !scratchReroute && route?.reachTarget === undefined && !r.reached;
      const pressureNote =
        localExec && r.pressure && r.pressure.ioFull60 >= PRESSURE_WARN_FULL60
          ? `\n[pressure] this computer's disk is saturated (io ${r.pressure.ioFull60}%, load ${r.pressure.load1}) — sequence heavy work, move self-contained runs to scope:"scratch", or check sandbox action=status`
          : "";
      return recordResult(
        callId,
        { tool: "execute", ...resultScope, ...execMeta },
        {
          content: [
            {
              type: "text" as const,
              text: `${placePrefix}${parts}\n[exit ${r.code}${r.timedOut ? " timed-out" : ""}]${pressureNote}`,
            },
          ],
          details: r,
        },
        r.timedOut,
        undefined,
        false,
        r.reached ? { provenance: "external", source: "reached room" } : undefined,
      );
    } catch (e) {
      if (e instanceof MaskedExecutionError) {
        return recordResult(callId, { tool: "execute", ...scopeNote }, text(e.message), true);
      }
      if (e instanceof NeedsApproval) return blockOnApproval(callId, e, params.purpose);
      if (e instanceof CommandDenied) {
        return recordResult(
          callId,
          { tool: "execute", denied: true, reason: e.message },
          text(`[denied by policy] ${e.message}`),
          true,
        );
      }
      await log("tool_result", {
        tool: "execute",
        ...scopeNote,
        callId,
        isError: true,
        result: `Command execution failed: ${redactSecrets(errMessage(e))}`,
      });
      throw e;
    }
  };

  const FILE_SEND_GUIDANCE =
    "execute, files, skills and apps use the default sandbox when sandbox_id is omitted. Send files with the surface `post` action's `files` if present, else `attach` (workspace paths or {file_id}); background jobs cannot deliver files. ";

  const reachScopeDescription =
    '"scoped" (default) | "scratch" | ' +
    'a room like "#project-alpha" (a shared channel): runs on that room\'s computer, read-only by etiquette.';
  const scopedLine =
    '- "scoped" (default): this conversation\'s sandbox: its workspace files and $AGENT_API_* tokens; saved credentials only via `credentials`. Working state survives only within provider recovery limits: push code to git, save artifacts to Files.\n';
  const scratchLine =
    '- "scratch": blank per-turn computer with the same tooling, read-only org-global files and skills, this conversation\'s $AGENT_API_* capabilities and requested credentials; no workspace or cached logins; files discarded after the turn, so publish outputs to Files and verify it worked.\n';
  const reachDescription =
    "Run a shell command and return stdout/stderr/exit code. `scope` picks the computer:\n" +
    scopedLine +
    scratchLine +
    "- a room like \"#project-alpha\" (a shared channel): runs on that room's computer. Visit only — read, search, fetch; don't rearrange. It has none of this conversation's logins or tokens; say where anything you bring back came from. Before calling work lost, check the rooms under 'Other computers you can reach'.\n" +
    FILE_SEND_GUIDANCE +
    EXECUTE_TIMEOUT_GUIDANCE;
  const scopeDescription =
    "Run a shell command and return stdout/stderr/exit code. `scope` picks the computer:\n" +
    scopedLine +
    scratchLine +
    FILE_SEND_GUIDANCE +
    EXECUTE_TIMEOUT_GUIDANCE;

  const runScopedExecute = async (
    callId: string,
    params: {
      command: string;
      timeout_seconds?: number;
      purpose?: string;
      scope?: string;
      credentials?: string[];
    },
  ) => {
    const scope = (params.scope ?? "scoped").trim();
    const keyword = scope.toLowerCase();
    if (keyword === "scoped") return runExecute(callId, params, { scratch: false });
    if (keyword === "scratch") return runExecute(callId, params, { scratch: true });
    return runExecute(callId, params, { reachTarget: scope });
  };

  const runCommand = (
    callId: string,
    params: Parameters<typeof runScopedExecute>[1] & { background?: boolean; sandbox_id?: string },
  ) => (params.background ? runBackgroundExecute(callId, params) : runScopedExecute(callId, params));

  const execute = defineTool({
    name: "execute",
    label: "execute",
    description: reachExec ? reachDescription : scopeDescription,
    parameters: Type.Object({
      ...executeBaseParams,
      scope: Type.Optional(
        reachExec
          ? Type.String({ description: reachScopeDescription })
          : Type.Union([Type.Literal("scoped"), Type.Literal("scratch")], {
              description: "Which computer runs this; see the tool description.",
            }),
      ),
    }),
    execute: (callId, params) => runCommand(callId, params as Parameters<typeof runCommand>[1]),
  });

  const sandboxActions = [
    "status",
    "restart",
    ...(opts?.sandboxResources ? ["list", "create", "set_default", "retire"] : []),
  ];
  const sandboxManagement = defineTool({
    name: "sandbox",
    label: "sandbox",
    description:
      "Manage sandbox computers. list: providers, inventory, this scope's default. create: a blank sandbox (default unchanged). set_default: route commands there (null clears). status: health. restart: stop processes, recover state where supported. retire: delete (not while default or running jobs). If work needs a computer and there is no default, list, create, set_default and retry; report blocked only if creation fails. Durable outputs belong in git or Files.",
    parameters: Type.Object({
      action: Type.String({ enum: sandboxActions }),
      sandbox_id: Type.Optional(
        Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
          description: "Sandbox ID; status/restart use the default if omitted. null only for set_default.",
        }),
      ),
      backend: Type.Optional(Type.String({ description: "create: provider from list." })),
      name: Type.Optional(Type.String({ description: "create: display name." })),
      purpose: Type.String({ description: "As for execute." }),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "sandbox",
        action: params.action,
        purpose: params.purpose,
        ...(params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {}),
        ...(params.backend ? { backend: params.backend } : {}),
        ...(params.name ? { name: params.name } : {}),
      });
      try {
        if (["list", "create", "set_default", "retire"].includes(params.action)) {
          if (!tc.sandboxResources) throw new Error("sandbox inventory unavailable");
          const result = await tc.sandboxResources(
            (params.action === "set_default" ? "default" : params.action) as "list" | "create" | "default" | "retire",
            {
              backend: params.backend,
              name: params.name,
              sandboxId: params.sandbox_id,
            },
          );
          return recordResult(callId, { tool: "sandbox", action: params.action }, text(JSON.stringify(result)));
        }
        if (params.sandbox_id === null) throw new Error("null only clears a default");
        if (params.action === "restart") {
          await tc.restartComputer(params.sandbox_id);
          return recordResult(
            callId,
            { tool: "sandbox", action: "restart", restarted: true },
            text("Computer restarting. Give it a moment to boot before running the next command."),
          );
        }
        const s = await tc.computerStatus(params.sandbox_id);
        const verdict = computerVerdict(s);
        const machineLine = s.listed && s.listed !== s.machine ? `${s.machine} (listed: ${s.listed})` : s.machine;
        const pressureLine = s.pressure ? `; io pressure: ${s.pressure.ioFull60}% (load ${s.pressure.load1})` : "";
        const resourcesLine = s.resources
          ? `; cpu ${s.resources.cpuUsedPct}%, memory ${s.resources.memUsedMb}/${s.resources.memTotalMb} MiB, disk ${s.resources.diskUsedGb}/${s.resources.diskTotalGb} GiB`
          : "";
        let shellLine = s.guestResponsive ? "answering" : `NOT answering${s.probeError ? ` (${s.probeError})` : ""}`;
        if (s.lifecycleState === "paused") shellLine = "paused (not probed)";
        const recoveryLines: string[] = [];
        if (s.lifecycleState) recoveryLines.push(`lifecycle: ${s.lifecycleState}`);
        if (s.expiresAtMs !== undefined)
          recoveryLines.push(`machine expires: ${new Date(s.expiresAtMs).toISOString()}`);
        if (s.recovery) {
          recoveryLines.push(`recovery strategy: ${s.recovery.strategy}`);
          if (s.recovery.state) recoveryLines.push(`recovery state: ${s.recovery.state}`);
          if (s.recovery.checkpointId) recoveryLines.push(`checkpoint: ${s.recovery.checkpointId}`);
          if (s.recovery.checkpointAtMs !== undefined)
            recoveryLines.push(`checkpoint captured: ${new Date(s.recovery.checkpointAtMs).toISOString()}`);
          if (s.recovery.checkpointExpiresAtMs === null)
            recoveryLines.push("checkpoint expires: no provider expiry reported");
          else if (s.recovery.checkpointExpiresAtMs !== undefined)
            recoveryLines.push(`checkpoint expires: ${new Date(s.recovery.checkpointExpiresAtMs).toISOString()}`);
          if (s.recovery.error) recoveryLines.push(`recovery error: ${s.recovery.error}`);
        }
        const verdictLine =
          verdict === "wedged"
            ? " — WEDGED: a machine exists but its shell is not answering; the platform's health reporting goes stale in exactly this state, so trust the shell probe over any healthy/running claim and restart the computer; if it is still wedged after a restart or two, create a fresh sandbox, set it as the default, and retry there"
            : "";
        return recordResult(
          callId,
          { tool: "sandbox", action: "status", verdict, ...s },
          text(
            [
              `machine: ${machineLine}; shell: ${shellLine}${pressureLine}${resourcesLine}${verdictLine}`,
              ...recoveryLines,
            ].join("\n"),
          ),
        );
      } catch (e) {
        if (e instanceof NeedsApproval) return blockOnApproval(callId, e, params.purpose, { tool: "sandbox" });
        return recordResult(
          callId,
          { tool: "sandbox", action: params.action, failed: true },
          text(`[error] ${errMessage(e)}`),
          true,
        );
      }
    },
  });

  const runBackgroundExecute = async (callId: string, params: Parameters<typeof runCommand>[1]) => {
    const tc = ref.current;
    if (!tc) return text("[error] no active tool context");
    await recordCall(callId, { ...params, tool: "execute", background: true });
    if ((params.scope ?? "scoped").trim().toLowerCase() !== "scoped")
      return recordResult(
        callId,
        { tool: "execute", background: true },
        text(
          '[error] background jobs require scope:"scoped" with durable storage; use sandbox_id to select their computer.',
        ),
        true,
      );
    try {
      const r = await tc.backgroundStart(params.command, {
        purpose: params.purpose!,
        ...(params.timeout_seconds ? { ttlSeconds: params.timeout_seconds } : {}),
        ...(params.sandbox_id ? { sandboxId: params.sandbox_id } : {}),
        ...(params.credentials?.length ? { credentials: params.credentials } : {}),
      });
      const { output: _output, jobComputer, ...startMeta } = r;
      const placePrefix = jobComputer
        ? "[running on a computer reserved for this job because it names a private credential; nobody can run commands on it, and it is destroyed after the job ends]\n"
        : "";
      return recordResult(
        callId,
        { tool: "execute", background: true, ...startMeta },
        {
          content: [
            {
              type: "text" as const,
              text: `${placePrefix}started ${r.processId}${r.reattached ? " (reattached)" : ""}\n${r.output}\n[cursor ${r.cursor} | ${fmtStatus(r.status)}]`,
            },
          ],
          details: r,
        },
        false,
        undefined,
        false,
        { provenance: "external" },
      );
    } catch (e) {
      if (e instanceof NeedsApproval) return blockOnApproval(callId, e, params.purpose);
      if (e instanceof CommandDenied)
        return recordResult(
          callId,
          { tool: "execute", background: true, denied: true, reason: e.message },
          text(`[denied by policy] ${e.message}`),
          true,
        );
      throw e;
    }
  };

  const background = defineTool({
    name: "background",
    label: "background",
    description:
      "Manage a job started with execute background:true; it keeps running across turns. " +
      "poll: new output and running/exited state (pass the last cursor as since_cursor; ~64KB per read). send_input: write to stdin. stop: terminate it. list: your jobs. " +
      "watch: wake this conversation as a new turn on new output (optionally only lines matching `pattern`) and once on exit, to keep the user posted on long work; pass since_cursor and `instructions` for your future self. unwatch: disarm by monitor_id. " +
      `Jobs stop after a hard TTL (default ${bgTtlMin} min, max ${bgTtlMaxMin}); anything that finishes within ${execCeilingSec}s should just use execute. ` +
      `The job has the same environment as foreground execute ($AGENT_API_URL, $AGENT_API_TOKEN, $AGENT_CREDENTIAL_TOKEN). ${capabilityExpiry} It cannot deliver files; attach them from a live turn.\n` +
      "INTERACTIVE LOGINS (`gh auth login` etc., anything printing a URL/code then waiting) must run with background:true: relay the URL/code to the user, then watch or poll until exit; answer prompts with send_input; never run one in the foreground or stop it mid-flight. Read and follow the `interactive-login` skill first.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("poll"),
        Type.Literal("send_input"),
        Type.Literal("stop"),
        Type.Literal("list"),
        Type.Literal("watch"),
        Type.Literal("unwatch"),
      ]),
      purpose: Type.Optional(Type.String({ description: "Short job description, about 5 words." })),
      process_id: Type.Optional(Type.String({ description: "The process_id execute returned." })),
      data: Type.Optional(Type.String({ description: "send_input: stdin text; include \\n to submit a line." })),
      since_cursor: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "poll/watch: cursor from the last poll; omit for the start.",
        }),
      ),
      pattern: Type.Optional(
        Type.String({
          description: "watch: literal alternatives separated by |, optional ^/$ anchors; omit to wake on any output.",
        }),
      ),
      instructions: Type.Optional(Type.String({ description: "watch: note replayed to you on each wake." })),
      monitor_id: Type.Optional(Type.String({ description: "unwatch: the monitor id watch returned." })),
      wait_seconds: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 60,
          description: "poll: block up to this long for output or exit (default 0).",
        }),
      ),
      max_bytes: Type.Optional(Type.Integer({ minimum: 1, description: "poll: cap bytes this read (default 65536)." })),
      signal: Type.Optional(
        Type.Union(
          [Type.Literal("TERM"), Type.Literal("KILL"), Type.Literal("INT"), Type.Literal("HUP"), Type.Literal("QUIT")],
          { description: "stop: default TERM." },
        ),
      ),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "background",
        action: params.action,
        purpose: params.purpose,
        process_id: params.process_id,
        ...(params.monitor_id ? { monitor_id: params.monitor_id } : {}),
      });
      try {
        switch (params.action) {
          case "poll": {
            const r = await tc.backgroundPoll(params.process_id!, {
              ...(params.since_cursor !== undefined ? { sinceCursor: params.since_cursor } : {}),
              ...(params.max_bytes !== undefined ? { maxBytes: params.max_bytes } : {}),
              ...(params.wait_seconds !== undefined ? { waitSeconds: params.wait_seconds } : {}),
            });
            const { chunks: _chunks, ...pollMeta } = r;
            return recordResult(
              callId,
              { tool: "background", action: params.action, ...pollMeta },
              {
                content: [
                  { type: "text" as const, text: `${r.chunks}\n[cursor ${r.cursor} | ${fmtStatus(r.status)}]` },
                ],
                details: r,
              },
              false,
              undefined,
              false,
              { provenance: "external" },
            );
          }
          case "stop": {
            const r = await tc.backgroundStop(params.process_id!, params.signal);
            return recordResult(
              callId,
              { tool: "background", action: params.action, ...r },
              {
                content: [
                  { type: "text" as const, text: `signalled ${r.processId}; status now ${fmtStatus(r.status)}` },
                ],
                details: r,
              },
            );
          }
          case "watch": {
            try {
              const r = await tc.backgroundWatch(params.process_id!, {
                ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
                ...(params.pattern !== undefined ? { pattern: params.pattern } : {}),
                ...(params.since_cursor !== undefined ? { sinceCursor: params.since_cursor } : {}),
              });
              if ("completed" in r) {
                const status = `${r.registryStatus}${r.exitCode !== undefined ? ` (code ${r.exitCode})` : ""}`;
                const result = r.outputTail
                  ? `job already ${status} — no watch armed; here is the tail of its output:\n${r.outputTail}`
                  : `job already ${status} — no watch armed; it produced no output.`;
                return recordResult(
                  callId,
                  { tool: "background", action: params.action, ...r },
                  {
                    content: [{ type: "text" as const, text: result }],
                    details: r,
                  },
                  false,
                  undefined,
                  false,
                  { provenance: "external", source: "finished job output" },
                );
              }
              const trigger = params.pattern ? `new output matching /${params.pattern}/` : "new output";
              return recordResult(
                callId,
                { tool: "background", action: params.action, ...r },
                {
                  content: [
                    {
                      type: "text" as const,
                      text:
                        `${r.reattached ? "already watching" : "watching"} ${r.processId} (monitor ${r.monitorId}) — ` +
                        `${trigger} and the job's exit will wake you in this conversation (watch expires ${new Date(r.expiresAt).toISOString()}).`,
                    },
                  ],
                  details: r,
                },
              );
            } catch (e) {
              if (e instanceof NeedsApproval || e instanceof CommandDenied) throw e;
              const msg = errMessage(e);
              return recordResult(
                callId,
                { tool: "background", action: params.action, error: msg },
                text(`[watch failed] ${msg}`),
                true,
              );
            }
          }
          case "unwatch": {
            try {
              const r = await tc.backgroundUnwatch(params.monitor_id!);
              return recordResult(
                callId,
                { tool: "background", action: params.action, ...r },
                text(r.removed ? `unwatched ${r.monitorId}` : `[no such watch: ${r.monitorId}]`),
                !r.removed,
              );
            } catch (e) {
              const msg = errMessage(e);
              return recordResult(
                callId,
                { tool: "background", action: params.action, error: msg },
                text(`[unwatch failed] ${msg}`),
                true,
              );
            }
          }
          case "send_input": {
            const r = await tc.backgroundWrite(params.process_id!, params.data!);
            return recordResult(
              callId,
              { tool: "background", action: params.action, ...r },
              {
                content: [
                  { type: "text" as const, text: `wrote ${r.bytes}B to ${r.processId} stdin; ${fmtStatus(r.status)}` },
                ],
                details: r,
              },
            );
          }
          case "list": {
            const jobs = await tc.backgroundList();
            return recordResult(
              callId,
              { tool: "background", action: params.action, jobs },
              {
                content: [
                  {
                    type: "text" as const,
                    text: jobs.length
                      ? jobs
                          .map(
                            (j) =>
                              `${j.processId}  ${j.registryStatus === "reaped" ? "stopped (ttl)" : fmtStatus(j.status)}  ${new Date(j.startedAt).toISOString()}  ${j.purpose ?? j.command}${j.purpose ? `\n  ${j.command}` : ""}`,
                          )
                          .join("\n")
                      : "(no background jobs)",
                  },
                ],
                details: { jobs },
              },
            );
          }
        }
      } catch (e) {
        if (e instanceof NeedsApproval)
          return blockOnApproval(callId, e, params.purpose, { tool: "background", action: params.action });
        if (e instanceof CommandDenied) {
          return recordResult(
            callId,
            { tool: "background", action: params.action, denied: true, reason: e.message },
            text(`[denied by policy] ${e.message}`),
            true,
          );
        }
        throw e;
      }
    },
  });

  return { execute, sandboxManagement, background };
}

const operationFields: Record<string, Record<string, string[]>> = {
  sandbox: {
    status: ["sandbox_id"],
    restart: ["sandbox_id"],
    list: [],
    create: ["backend", "name"],
    set_default: ["sandbox_id"],
    retire: ["sandbox_id"],
  },
  background: {
    poll: ["process_id", "since_cursor", "wait_seconds", "max_bytes"],
    send_input: ["process_id", "data"],
    stop: ["process_id", "signal"],
    list: [],
    watch: ["process_id", "since_cursor", "pattern", "instructions"],
    unwatch: ["monitor_id"],
  },
};
export function validateSandboxTool(
  tool: ToolDefinition,
  kit: Pick<ToolKit, "recordCall" | "recordResult">,
): ToolDefinition {
  const { recordCall, recordResult } = kit;
  if (!["execute", "background", "sandbox"].includes(tool.name)) return tool;
  const properties = (tool.parameters as { properties: Record<string, TSchema> }).properties;
  const schema = Type.Object(properties, { additionalProperties: false });
  return {
    ...tool,
    parameters: schema,
    async execute(callId, params, signal, onUpdate, ctx) {
      const action = isObj(params) ? String(params.action) : "";
      const operations = operationFields[tool.name];
      const fields = operations && Object.hasOwn(operations, action) ? operations[action] : undefined;
      let required: string[];
      if (tool.name === "execute") required = ["command", "purpose"];
      else if (tool.name === "sandbox") {
        required = ["purpose"];
        if (["set_default", "retire"].includes(action)) required.push("sandbox_id");
        if (action === "create") required.push("backend");
      } else {
        required = action === "list" ? [] : ["process_id"];
        if (action === "unwatch") required = ["monitor_id"];
        if (action === "send_input") required.push("data");
      }
      const missing = required.find(
        (key) =>
          !isObj(params) ||
          params[key] === undefined ||
          (typeof params[key] === "string" && key !== "data" && !params[key].trim()),
      );
      if (
        !Check(schema, params) ||
        missing ||
        (operations &&
          (!fields || Object.keys(params).some((key) => !["action", "purpose", ...fields].includes(key)))) ||
        (tool.name === "sandbox" && params.sandbox_id === null && action !== "set_default")
      ) {
        await recordCall(callId, {
          tool: tool.name,
          ...(isObj(params) ? { purpose: params.purpose, action: params.action } : {}),
        });
        return recordResult(
          callId,
          { tool: tool.name, invalid: true },
          text(
            `[error] invalid ${tool.name} arguments: ${missing ? `requires \`${missing}\`` : "use only the advertised fields and types for this operation"}.`,
          ),
          true,
        );
      }
      return tool.execute(callId, params, signal, onUpdate, ctx);
    },
  };
}
