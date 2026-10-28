/** ToolContext operations that call out: background jobs, the control plane and the conversation surface. */
/** Builds the ToolContext a turn's agent tools call into: sandboxes, files, memory, surfaces, background jobs and the control plane. */
/** ToolContext operations that call out: background jobs, the control plane and the conversation surface. */
/** Builds the ToolContext a turn's agent tools call into: sandboxes, files, memory, surfaces, background jobs and the control plane. */
import { processCredentialFiles } from "../credentials/execute-files.ts";
import { executionSecretEnv } from "../security/secret-masking.ts";
import type {
  BackgroundCredentials,
  BackgroundStartResult,
  BackgroundPollResult,
  BackgroundStopResult,
  BackgroundWriteResult,
  BackgroundJobSummary,
} from "../connectors/background-exec-broker.ts";
import { swallow, withCleanup } from "../util/errors.ts";
import type { SandboxHandle } from "../sandbox/sandbox.ts";
import { type ToolContext, CONTROL_UNAVAILABLE } from "./primitives.ts";
import { type ToolContextDeps } from "./tool-context.ts";
import { scratchOnlyHandles, type sandboxAccess, type callLedger, type credentialStaging } from "./tool-context-env.ts";

/** Background jobs: start, poll, stop, input, list and watch. */
export function backgroundOps(
  deps: ToolContextDeps,
  {
    writableScopeId,
    provisionForCommand,
    authorizeExecution,
    once,
    selectCredentials,
    stageCredentials,
  }: Pick<ReturnType<typeof sandboxAccess>, "writableScopeId" | "provisionForCommand" | "authorizeExecution"> &
    Pick<ReturnType<typeof callLedger>, "once"> &
    Pick<ReturnType<typeof credentialStaging>, "selectCredentials" | "stageCredentials">,
) {
  return {
    async backgroundStart(
      command: string,
      opts: { purpose: string; ttlSeconds?: number; sandboxId?: string; credentials?: string[] },
    ): Promise<BackgroundStartResult & { jobComputer?: boolean }> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const requestedCredentials = opts.credentials ?? [];
      if (requestedCredentials.length && !writableScopeId)
        throw new Error("command credentials are available only on scoped computers");
      const requested = await selectCredentials(requestedCredentials);
      const scratchOnly = scratchOnlyHandles(requested);
      if (scratchOnly && !deps.provisionJobComputer)
        throw new Error(`background jobs here cannot use ${scratchOnly}; run the command in the foreground`);
      let handle: SandboxHandle;
      if (scratchOnly) {
        authorizeExecution(command, undefined, deps.commandPolicy());
        handle = await deps.provisionJobComputer!();
      } else {
        handle = await provisionForCommand(command, opts?.sandboxId, requestedCredentials.length > 0, () =>
          deps.provision(),
        );
      }
      return once(
        async () => {
          const staged = requested.length ? await stageCredentials(requested, handle, "background") : undefined;
          const release = async () => {
            await staged?.fileExecution?.finish();
          };
          let credentials: BackgroundCredentials | undefined;
          try {
            credentials = staged && {
              env: staged.commandEnv,
              secrets: Object.values(executionSecretEnv(staged.commandEnv, staged.secretValues)),
              ...(staged.fileExecution
                ? { files: processCredentialFiles(staged.fileExecution.plan, staged.fileCredentials) }
                : {}),
              release,
            };
          } catch (error) {
            return withCleanup(() => Promise.reject(error), release);
          }
          const started = await deps.backgroundBroker!.start(
            handle,
            command,
            opts.purpose,
            opts?.ttlSeconds ? opts.ttlSeconds * 1000 : undefined,
            credentials,
          );
          await deps.monitorBroker
            ?.watch(started.processId, { exitOnly: true })
            .catch((error: unknown) => swallow("background: exit watch", error));
          return scratchOnly ? { ...started, jobComputer: true } : started;
        },
        () => true,
      );
    },
    async backgroundPoll(
      processId: string,
      opts?: { sinceCursor?: number; maxBytes?: number; waitSeconds?: number },
    ): Promise<BackgroundPollResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = (await deps.backgroundBroker.handleFor?.(processId)) ?? (await deps.provision());
      const polled = await once(
        () =>
          deps.backgroundBroker!.poll(handle, processId, {
            ...(opts?.sinceCursor !== undefined ? { sinceCursor: opts.sinceCursor } : {}),
            ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
            ...(opts?.waitSeconds !== undefined ? { waitMs: opts.waitSeconds * 1000 } : {}),
          }),
        (r) => r.status.state === "exited",
      );
      if (polled.status.state === "exited") await deps.monitorBroker?.seenExit(processId);
      return polled;
    },
    async backgroundStop(processId: string, signal?: string): Promise<BackgroundStopResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = (await deps.backgroundBroker.handleFor?.(processId)) ?? (await deps.provision());
      const stopped = await once(
        () => deps.backgroundBroker!.stop(handle, processId, signal),
        () => true,
      );
      await deps.monitorBroker?.seenExit(processId);
      return stopped;
    },
    async backgroundWrite(processId: string, data: string): Promise<BackgroundWriteResult> {
      if (!deps.backgroundBroker) throw new Error(BACKGROUND_UNAVAILABLE_MESSAGE);
      const handle = (await deps.backgroundBroker.handleFor?.(processId)) ?? (await deps.provision());
      if (handle.resourceId && (await deps.sandboxResources?.get(handle.resourceId))?.jobOnly)
        throw new Error("a background job that uses private credentials does not accept input");
      return once(
        () => deps.backgroundBroker!.write(handle, processId, data),
        () => true,
      );
    },
    async backgroundList(): Promise<BackgroundJobSummary[]> {
      if (!deps.backgroundBroker) return [];
      return deps.backgroundBroker.list();
    },
    async backgroundWatch(processId, opts) {
      if (!deps.monitorBroker) throw new Error(WATCH_UNAVAILABLE_MESSAGE);
      return once(
        () => deps.monitorBroker!.watch(processId, opts),
        () => true,
      );
    },
    async backgroundUnwatch(monitorId) {
      if (!deps.monitorBroker) throw new Error(WATCH_UNAVAILABLE_MESSAGE);
      return once(
        () => deps.monitorBroker!.unwatch(monitorId),
        () => true,
      );
    },
  } satisfies Partial<ToolContext>;
}

/** Control-plane calls: crons, webhooks, instructions and sharing. */
export function controlOps(deps: ToolContextDeps, { controlOp }: Pick<ReturnType<typeof callLedger>, "controlOp">) {
  return {
    cronCreate: (req) =>
      controlOp(
        (c, cl) => c.createCron(req, cl),
        (r) => r.ok,
      ),
    cronList: () => controlOp((c, cl) => c.listCrons(cl)),
    cronGet: (id) => controlOp((c, cl) => c.getCron(id, cl)),
    cronRuns: (id, req) => controlOp((c, cl) => c.getCronRuns(id, req ?? {}, cl)),
    cronPatch: (id, req) =>
      controlOp(
        (c, cl) => c.patchCron(id, req, cl),
        (r) => r.ok,
      ),
    cronNote: (id, note) =>
      controlOp(
        (c, cl) => c.noteCron(id, note, cl),
        (r) => r.ok,
      ),
    cronDelete: (id) =>
      controlOp(
        (c, cl) => c.deleteCron(id, cl),
        (r) => r.ok,
      ),
    cronSetEnabled: (id, enabled) =>
      controlOp(
        (c, cl) => c.setCronEnabled(id, enabled, cl),
        (r) => r.ok,
      ),
    cronRun: (id) =>
      controlOp(
        (c, cl) => c.runCron(id, cl),
        (r) => r.ok,
      ),
    webhookCreate: (req) =>
      controlOp(
        (c, cl) => c.createWebhook(req, cl, deps.webhookPublicUrl),
        (r) => r.ok,
      ),
    webhookList: () => controlOp((c, cl) => c.listWebhooks(cl)),
    webhookDisable: (id) =>
      controlOp(
        (c, cl) => c.disableWebhook(id, cl),
        (r) => r.ok,
      ),
    webhookUpdate: (id, action) =>
      controlOp(
        (c, cl) => c.updateWebhook(id, { action }, cl),
        (r) => r.ok,
      ),
    instructionsRead() {
      if (!deps.control || !deps.controlClaims) return CONTROL_UNAVAILABLE;
      return deps.control.readInstructions(deps.controlClaims);
    },
    instructionsWrite: (content, expectedVersion) =>
      controlOp(
        async (c, cl) => c.writeInstructions(content, cl, expectedVersion),
        (r) => r.ok,
      ),
    shareArtifact: (req) =>
      controlOp(
        (c, cl) => c.shareArtifact(req, cl),
        (r) => r.ok,
      ),
  } satisfies Partial<ToolContext>;
}

/** Surface calls: post, reach, react, edit, read and attach. */
export function surfaceOps(deps: ToolContextDeps, { surfaceOp }: Pick<ReturnType<typeof callLedger>, "surfaceOp">) {
  return {
    post: (text, opts, files, sandboxId) =>
      surfaceOp(
        (s) => s.post(text, opts, files, sandboxId),
        (r) => r.ok,
      ),
    reach: (text, target, files, sandboxId) =>
      surfaceOp(
        (s) => s.reach(text, target, files, sandboxId),
        (r) => r.ok,
      ),
    react: (input) =>
      surfaceOp(
        (s) => s.react(input),
        (r) => r.ok,
      ),
    edit: (input) =>
      surfaceOp(
        (s) => s.edit(input),
        (r) => r.ok,
      ),
    delete: (input) =>
      surfaceOp(
        (s) => s.delete(input),
        (r) => r.ok,
      ),
    readThread: (opts) => surfaceOp((s) => s.readThread(opts)),
    whatsNew: (opts) => surfaceOp((s) => s.whatsNew(opts)),
    search: (query, opts) => surfaceOp((s) => s.search(query, opts)),
    readMembers: () => surfaceOp((s) => s.readMembers()),
    readFile: (ref, offset) => surfaceOp((s) => s.readFile(ref, offset)),
    getChannelBehavior: () => surfaceOp((s) => s.getChannelBehavior()),
    setChannelBehavior: (bots, ambientEnabled) => surfaceOp((s) => s.setChannelBehavior(bots, ambientEnabled)),
    attach: (files, sandboxId) =>
      deps.attach
        ? deps.attach(files, sandboxId)
        : Promise.resolve({ ok: false as const, message: ATTACH_UNAVAILABLE_MESSAGE }),
  } satisfies Partial<ToolContext>;
}

const ATTACH_UNAVAILABLE_MESSAGE =
  "files can't be attached from this turn — name the file in the surface `post` action's `files` instead";

const BACKGROUND_UNAVAILABLE_MESSAGE =
  "Background execution isn't available on this computer — run the command with `execute` (up to 300s) instead.";
const WATCH_UNAVAILABLE_MESSAGE =
  "Watching background jobs isn't available on this computer — `background poll` the job from a later turn instead.";
