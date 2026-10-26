import { randomUUID } from "node:crypto";
import {
  defineHarness,
  type Harness,
  type HarnessDetectInput,
  type HarnessDetectResult,
  type HarnessTurnInput,
  type HarnessTurnResult,
} from "../../src/harness/harness.ts";
import { NonRetryableTurnError, ProviderTurnError, TitleRejected } from "../../src/core/turn-error.ts";
import { NeedsApproval } from "../../src/tools/primitives.ts";
import { toolCallApprovalKey } from "../../src/core/approval-id.ts";
import { deterministicCompactSummary, estimateHistoryTokens } from "../../src/harness/context-compaction.ts";
import { countTokens } from "../../src/util/tokens.ts";
import { isReply, isUserMessage } from "../../src/sessions/items.ts";
import { recordStoppedTurn } from "../../src/harness/harness-shared.ts";
import {
  SECURITY_SCREEN_STEP,
  SECURITY_SCREEN_SYSTEM_PROMPT,
  type ToolResultScreen,
} from "../../src/security/security-posture.ts";

const READ_ONLY_BLOCKED_PREFIXES = [
  "!preamble",
  "!speakpost ",
  "!run ",
  "!execute ",
  "!scratch ",
  "!owner ",
  "!reach ",
  "!paused-approval ",
  "!collect-approval ",
  "!collect-exec ",
  "!screened-run ",
  "!double-exec ",
  "!read ",
  "!skill ",
  "!skill-run ",
  "!write ",
  "!attach ",
  "!writeattach ",
  "!attachsilent ",
  "!reachchan ",
  "!postthread ",
  "!broadcast ",
  "!post ",
  "!post2 ",
  "!post-lost-result ",
  "!post-then-boom ",
  "!postfiles ",
  "!react ",
  "!edit ",
  "!delete ",
  "!read_thread",
  "!whats_new",
  "!search ",
  "!read_members",
  "!read_file ",
  "!set_standing_order ",
  "!get_standing_order",
];

function streamChunks(text: string): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / 3));
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function mockProviderMessages(
  history: HarnessTurnInput["history"],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.flatMap((e): Array<{ role: "user" | "assistant"; content: string }> => {
    const content = e.text ?? "";
    if (!content.trim()) return [];
    if (isUserMessage(e)) return [{ role: "user", content }];
    return isReply(e) ? [{ role: "assistant", content }] : [];
  });
}

function withCallIds(emit: HarnessTurnInput["emit"]): HarnessTurnInput["emit"] {
  const open: string[] = [];
  return (item) => {
    if (item.kind !== "ToolCall" && item.kind !== "ToolResult") return emit(item);
    let callId = item.callId;
    if (!callId) {
      callId = item.kind === "ToolCall" ? `mock-call-${randomUUID()}` : (open.shift() ?? `mock-call-${randomUUID()}`);
      if (item.kind === "ToolCall") open.push(callId);
    } else if (item.kind === "ToolCall") open.push(callId);
    else open.splice(open.indexOf(callId), open.includes(callId) ? 1 : 0);
    return emit({ ...item, callId });
  };
}

export function createMockHarness(): Harness {
  const shedSessions = new Set<string>();
  const boomAlwaysSessions = new Set<string>();
  const resumePostSessions = new Map<string, string>();
  const shutdownResumeSessions = new Set<string>();
  const flakyScreens = new Set<string>();
  return defineHarness(
    {
      id: "mock",
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "qm",
      capabilities: new Set(),
    },
    {
      async runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult> {
        let turn: HarnessTurnInput = { ...input, emit: withCallIds(input.emit) };
        const continued = turn.continueTurn ? turn.history.find((e) => e.seq === turn.resumeUserSeq) : undefined;
        if (continued) turn = { ...turn, input: "", environment: undefined };
        const userEntry =
          continued ??
          (await turn.emit({
            kind: "UserMessage",
            text: turn.input,
            externalId: turn.triggerTs ?? turn.entryTs ?? null,
            author: turn.runtimeActorId ?? null,
            body: turn.attachments?.length ? { attachments: turn.attachments } : {},
          }));
        const modelPrompt = [turn.input, turn.environment].filter((s) => s && s.trim()).join("\n\n");

        turn.recordModelCall({
          model: "mock",
          inputTokens: countTokens(turn.systemPrompt) + estimateHistoryTokens(turn.history) + countTokens(modelPrompt),
          entryCount: turn.history.length,
        });
        const firstLine = turn.input.split("\n")[0]?.trim() ?? "";
        const whyCmd = /<why>\s*(![^<\n]+)/.exec(turn.input)?.[1]?.trim();
        const addressedCmd = /<addressed-messages[^>]*>\s*<message[^>]*>\s*(![^<\n]+)/.exec(turn.input)?.[1]?.trim();
        const cmd = firstLine.startsWith("<") ? (whyCmd ?? addressedCmd ?? turn.input) : turn.input;
        const command0 = cmd.split("\n")[0]?.trim() ?? "";
        const cacheMiss = command0 === "!cachemiss";
        const systemPromptTokens = countTokens(turn.systemPrompt);
        const prefixTokens = cacheMiss ? Math.max(2048, systemPromptTokens) : Math.max(1, systemPromptTokens);
        const inputTokens = countTokens(modelPrompt);
        const callUsage = (step: number) => ({
          input: inputTokens,
          output: 8,
          cacheRead: cacheMiss && step === 0 ? 0 : prefixTokens,
          cacheWrite: cacheMiss && step === 0 ? prefixTokens : 0,
          totalTokens: prefixTokens + inputTokens + 8,
          costUsd: 0,
        });

        await turn.recordLlmRequest?.({
          turnSeq: userEntry.seq,
          step: 0,
          model: "mock",
          promptEnvelope: {
            model: "mock",
            system: turn.systemPrompt,
            messages: [...mockProviderMessages(turn.history), { role: "user", content: modelPrompt }],
            ...(turn.images?.length
              ? { images: turn.images.map((image) => ({ mimeType: image.mimeType, dataBase64: image.dataBase64 })) }
              : {}),
            ...(turn.documents?.length
              ? { documents: turn.documents.map(({ name, mimeType, artifactId }) => ({ name, mimeType, artifactId })) }
              : {}),
          },
          truncated: false,
          usage: callUsage(0),
        });

        let reply: string;
        let muteReply = false;
        let usedTool = false;
        let silent = false;
        const collected: Array<{
          command: string;
          reason: string;
          kind?: "approval";
          matched?: string;
          approvalKey?: string;
          grantModes?: { session: boolean; always: boolean };
          summary?: string;
        }> = [];
        let pausedOnApproval = false;
        const gateTool = (tool: string): boolean => {
          if (!turn.toolApprovalGate || turn.toolApprovalGate(tool)) return false;
          collected.push({
            command: tool,
            reason: "strict posture: this tool call requires human approval",
            kind: "approval",
            approvalKey: `tool:${tool}`,
          });
          pausedOnApproval = true;
          return true;
        };

        if (turn.readOnly && READ_ONLY_BLOCKED_PREFIXES.some((prefix) => command0.startsWith(prefix))) {
          reply = "[strict/read-only posture: that tool is unavailable]";
        } else if (command0 === "!boom") {
          throw new Error("boom: simulated turn fault");
        } else if (command0 === "!boom-always" || boomAlwaysSessions.has(turn.session.id)) {
          boomAlwaysSessions.add(turn.session.id);
          throw new Error("boom: simulated turn fault");
        } else if (resumePostSessions.has(turn.session.id)) {
          const msg = resumePostSessions.get(turn.session.id)!;
          resumePostSessions.delete(turn.session.id);
          await turn.emit({
            kind: "ToolCall",
            tool: "slack",
            body: { action: "post", bytes: msg.length },
          });
          const r = await turn.tools.post(msg);
          await turn.emit({
            kind: "ToolResult",
            tool: "post",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(posted after resume)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (shutdownResumeSessions.has(turn.session.id)) {
          shutdownResumeSessions.delete(turn.session.id);
          reply = "finished after resume";
        } else if (command0 === "!work-until-shutdown") {
          await turn.emit({ kind: "ToolCall", tool: "execute", callId: "build", body: { command: "make build" } });
          await turn.emit({ kind: "ToolResult", tool: "execute", callId: "build", body: { ok: true } });
          shutdownResumeSessions.add(turn.session.id);
          await new Promise<void>((resolve) => {
            if (!turn.cancel || turn.cancel.aborted) resolve();
            else turn.cancel.addEventListener("abort", () => resolve(), { once: true });
          });
          await recordStoppedTurn(turn, "");
          return { reply: "(stopped)", stopped: true, modelCalls: 1 };
        } else if (command0.startsWith("!post-lost-result ")) {
          const msg = cmd.slice(cmd.indexOf("!post-lost-result ") + "!post-lost-result ".length);
          await turn.emit({ kind: "ToolCall", tool: "slack", body: { action: "post", bytes: msg.length } });
          await turn.tools.post(msg);
          resumePostSessions.set(turn.session.id, `${msg} (repost)`);
          throw new Error("boom: simulated fault before the post's tool result landed");
        } else if (command0 === "!over-budget") {
          throw new ProviderTurnError("Model provider API error (budget_exceeded): ExceededBudget", {
            code: "model_budget",
            retryable: false,
            status: 429,
            raw: '429: {"message":"ExceededBudget: Team=team-a over 1d budget.","type":"budget_exceeded"}',
          });
        } else if (command0.startsWith("!post-then-boom ")) {
          const rest = cmd.slice(cmd.indexOf("!post-then-boom ") + "!post-then-boom ".length);
          const bar = rest.indexOf("|");
          const first = bar === -1 ? rest : rest.slice(0, bar);
          const second = bar === -1 ? rest : rest.slice(bar + 1);
          await turn.emit({
            kind: "ToolCall",
            tool: "slack",
            body: { action: "post", bytes: first.length },
          });
          const r = await turn.tools.post(first);
          await turn.emit({
            kind: "ToolResult",
            tool: "post",
            body: { ok: r.ok },
          });
          resumePostSessions.set(turn.session.id, second);
          throw new Error("boom: simulated fault after a completed post");
        } else if (command0 === "!work-then-boom") {
          await turn.emit({
            kind: "ToolCall",
            tool: "execute",
            body: { command: "make build" },
          });
          await turn.emit({ kind: "ToolResult", tool: "execute", body: { ok: true } });
          throw new Error("boom: simulated mid-turn fault");
        } else if (command0 === "!refuse") {
          throw new NonRetryableTurnError(
            "API integrators: you can reduce refusals for your users by configuring a fallback model",
          );
        } else if (command0 === "!silent") {
          reply = "";
        } else if (command0.startsWith("[system] You were addressed")) {
          if (shedSessions.has(turn.session.id)) {
            reply = "worklog: did the thing but never posted";
          } else {
            await turn.emit({ kind: "ToolCall", tool: "slack", body: { action: "post" } });
            const r = await turn.tools.post("nudged reply");
            await turn.emit({ kind: "ToolResult", tool: "post", body: { ok: r.ok } });
            usedTool = true;
            reply = r.ok ? "(posted after nudge)" : `[not sent] ${r.message ?? "failed"}`;
          }
        } else if (command0.startsWith("!shedmute")) {
          shedSessions.add(turn.session.id);
          reply = "worklog: did the thing but never posted";
          muteReply = true;
        } else if (command0.startsWith("!shed")) {
          shedSessions.add(turn.session.id);
          reply = "worklog: did the thing but never posted";
        } else if (command0.startsWith("!preamble-then-quiet")) {
          const preamble =
            cmd.slice(cmd.indexOf("!preamble-then-quiet") + "!preamble-then-quiet".length).trim() ||
            "Still queued — silent.";
          if (turn.onDelta) for (const chunk of streamChunks(preamble)) turn.onDelta(chunk);
          await turn.emit({ kind: "AgentMessage", variant: "narration", text: preamble });
          await turn.emit({ kind: "ToolCall", tool: "execute", body: { command: "check" } });
          await turn.emit({ kind: "ToolResult", tool: "execute", body: { ok: true } });
          usedTool = true;
          silent = turn.pollFire === true;
          reply = turn.pollFire ? "" : preamble;
        } else if (command0.startsWith("!phased-reply")) {
          await turn.onTextBlockStart?.("commentary");
          turn.onDelta?.("Checking.");
          await turn.emit({
            kind: "AgentMessage",
            variant: "narration",
            text: "Checking.",
            body: { phase: "commentary" },
          });
          await turn.onTextBlockStart?.("final_answer");
          reply = "All clear.";
        } else if (command0.startsWith("!preamble")) {
          const preamble = cmd.slice(cmd.indexOf("!preamble") + "!preamble".length).trim() || "On it — checking.";
          if (turn.onDelta) for (const chunk of streamChunks(preamble)) turn.onDelta(chunk);
          await turn.emit({ kind: "AgentMessage", variant: "narration", text: preamble });
          await turn.emit({ kind: "ToolCall", tool: "execute", body: { command: "check" } });
          await turn.emit({ kind: "ToolResult", tool: "execute", body: { ok: true } });
          usedTool = true;
          turn.onTextBlockStart?.();
          reply = `${preamble}\n\nAll clear — nothing broke.`;
        } else if (command0.startsWith("!speakpost ")) {
          const msg = cmd.slice(cmd.indexOf("!speakpost ") + "!speakpost ".length);
          if (turn.onDelta) for (const chunk of streamChunks("Answering directly.")) turn.onDelta(chunk);
          await turn.emit({ kind: "ToolCall", tool: "slack", body: { action: "post", bytes: msg.length } });
          const r = await turn.tools.post(msg);
          await turn.emit({ kind: "ToolResult", tool: "post", body: { ok: r.ok } });
          usedTool = true;
          reply = r.ok ? "(posted)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0 === "!finish-silent") {
          usedTool = true;
          silent = turn.pollFire === true || turn.surfaceTools === true;
          reply = silent ? "" : "Nothing to report; ending silently.";
          if (silent) {
            await turn.emit({ kind: "ToolCall", tool: "finish_silently" });
            await turn.emit({ kind: "ToolResult", tool: "finish_silently", body: { silent: true } });
          }
        } else if (command0 === "!finish-silent-approval") {
          usedTool = true;
          silent = turn.pollFire === true || turn.surfaceTools === true;
          reply = silent ? "" : "I couldn't finish one check, but nothing to report.";
          collected.push({ command: "gated-check", reason: "requires approval" });
        } else if (command0 === "!cachemiss") {
          reply = "re-prefilled the prefix";
        } else if (command0 === "!histcount") {
          reply = `history:${turn.history.length}`;
        } else if (command0 === "!sysprompt") {
          reply = [turn.systemPrompt, turn.environment].filter((s) => s && s.trim()).join("\n\n");
        } else if (command0 === "!wallclock") {
          reply = `wallclock:${turn.turnWallClockMs ?? 0}`;
        } else if (command0 === "!surfacename") {
          reply = `surface:${turn.surfaceName ?? "none"}`;
        } else if (command0.startsWith("!think ")) {
          const thinking = command0.slice("!think ".length);
          const step = { id: randomUUID(), index: 0 };
          for (const chunk of streamChunks(thinking)) turn.onReasoningDelta?.(step.id, step.index, chunk);
          await turn.emit({
            kind: "Reasoning",
            text: thinking,
            step: step.index,
            body: { thinkingSignature: "OPAQUE-SIG-BYTES", wire: { message: { id: step.id } } },
          });
          reply = "thought about it";
        } else if (command0.startsWith("!execute ")) {
          const params = JSON.parse(cmd.slice(cmd.indexOf("!execute ") + 9)) as {
            command: string;
            credentials?: string[];
            ownerAuth?: boolean;
            sandboxId?: string;
          };
          const result = await turn.tools.execute(params.command, {
            credentials: params.credentials,
            ownerAuth: params.ownerAuth,
            sandboxId: params.sandboxId,
          });
          await turn.emit({ kind: "ToolResult", body: { ...result } });
          turn.onProgress?.({ toolCalls: 1 });
          usedTool = true;
          reply = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
        } else if (command0.startsWith("!run ") || command0.startsWith("!scratch ") || command0.startsWith("!owner ")) {
          let tag = "!run ";
          if (command0.startsWith("!scratch ")) tag = "!scratch ";
          else if (command0.startsWith("!owner ")) tag = "!owner ";
          const inboxDir = /available in \.\/(\S+?)\/:/.exec(turn.environment ?? "")?.[1] ?? "inbox";
          const command = cmd.slice(cmd.indexOf(tag) + tag.length).replaceAll("{INBOX}", inboxDir);
          if (gateTool("execute")) {
            await turn.emit({ kind: "ToolCall", tool: "execute", body: { command, blocked: "needs_approval" } });
            usedTool = true;
            reply = "";
          } else {
            await turn.emit({ kind: "ToolCall", tool: "execute", body: { command } });
            let opts: { scratch?: boolean; ownerAuth?: boolean } | undefined;
            if (tag === "!scratch ") opts = { scratch: true };
            else if (tag === "!owner ") opts = { ownerAuth: true };
            const result = await turn.tools.execute(command, opts);
            await turn.emit({ kind: "ToolResult", body: { ...result } });
            turn.onProgress?.({ toolCalls: 1 });
            usedTool = true;
            reply = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
          }
        } else if (command0.startsWith("!screened-run ")) {
          const command = cmd.slice(cmd.indexOf("!screened-run ") + "!screened-run ".length);
          await turn.emit({ kind: "ToolCall", tool: "execute", body: { command } });
          const result = await turn.tools.execute(command);
          const output = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
          const screen = turn.screenToolResult
            ? await turn
                .screenToolResult({
                  tool: "execute",
                  result: output,
                  unscreenable: false,
                  provenance: "external",
                })
                .catch((): ToolResultScreen => ({ outcome: "unscreened" }))
            : ({ outcome: "allow" } as ToolResultScreen);
          if (screen.outcome === "quarantine") {
            const stub = "[tool output quarantined by the security screen]";
            await turn.emit({
              kind: "ToolResult",
              tool: "execute",
              text: stub,
              isError: true,
              body: { quarantined: true, quarantineReason: "screen_verdict" },
            });
            reply = stub;
          } else {
            await turn.emit({ kind: "ToolResult", body: { ...result } });
            reply = output;
          }
          turn.onProgress?.({ toolCalls: 1 });
          usedTool = true;
        } else if (command0.startsWith("!reach ")) {
          const rest = command0.slice("!reach ".length);
          const sp = rest.indexOf(" ");
          const room = sp === -1 ? rest : rest.slice(0, sp);
          const command = sp === -1 ? "" : rest.slice(sp + 1);
          await turn.emit({ kind: "ToolCall", tool: "execute", body: { command, scope: room } });
          try {
            const result = await turn.tools.execute(command, { reachTarget: room });
            await turn.emit({ kind: "ToolResult", body: { ...result } });
            reply = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
          } catch (e) {
            reply = `[reach error] ${e instanceof Error ? e.message : String(e)}`;
          }
          turn.onProgress?.({ toolCalls: 1 });
          usedTool = true;
        } else if (command0.startsWith("!paused-approval ")) {
          const command = command0.slice("!paused-approval ".length);
          await turn.emit({ kind: "ToolCall", tool: "execute", body: { command, blocked: "needs_approval" } });
          collected.push({ command, reason: "requires approval" });
          pausedOnApproval = true;
          usedTool = true;
          reply = `about to run it`;
        } else if (command0 === "!finish-silent-paused") {
          usedTool = true;
          silent = turn.pollFire === true || turn.surfaceTools === true;
          pausedOnApproval = true;
          collected.push({ command: "gated-check", reason: "requires approval" });
          reply = "";
        } else if (command0.startsWith("!collect-approval ")) {
          const command = command0.slice("!collect-approval ".length);
          await turn.emit({ kind: "ToolCall", tool: "execute", body: { command, blocked: "needs_approval" } });
          collected.push({ command, reason: "requires approval" });
          usedTool = true;
          reply = `worked around it; done`;
        } else if (command0.startsWith("!collect-exec ")) {
          const command = command0.slice("!collect-exec ".length);
          await turn.emit({ kind: "ToolCall", tool: "execute", body: { command } });
          try {
            const result = await turn.tools.execute(command);
            reply = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
          } catch (e) {
            if (!(e instanceof NeedsApproval)) throw e;
            collected.push({
              command: e.command,
              reason: e.approvalReason,
              kind: e.kind,
              matched: e.matched,
              ...(e.approvalKey ? { approvalKey: e.approvalKey } : {}),
              ...(e.grantModes ? { grantModes: e.grantModes } : {}),
            });
            reply = `[blocked] ${e.approvalReason}`;
          }
          usedTool = true;
        } else if (command0.startsWith("!double-exec ")) {
          const command = command0.slice("!double-exec ".length);
          let ran = 0;
          for (let i = 0; i < 2; i++) {
            await turn.emit({ kind: "ToolCall", tool: "execute", body: { command } });
            try {
              const result = await turn.tools.execute(command);
              await turn.emit({ kind: "ToolResult", body: { ...result } });
              ran++;
            } catch (e) {
              if (!(e instanceof NeedsApproval)) throw e;
              collected.push({
                command: e.command,
                reason: e.approvalReason,
                kind: e.kind,
                matched: e.matched,
                ...(e.approvalKey ? { approvalKey: e.approvalKey } : {}),
                ...(e.grantModes ? { grantModes: e.grantModes } : {}),
              });
            }
          }
          usedTool = true;
          reply = `ran ${ran}`;
        } else if (command0.startsWith("!declared ")) {
          const args = JSON.parse(command0.slice("!declared ".length)) as Record<string, unknown>;
          const callKey = toolCallApprovalKey("example_send", args);
          usedTool = true;
          if (turn.toolApprovalGate?.("example_send", callKey)) reply = `sent ${JSON.stringify(args)}`;
          else {
            collected.push({
              command: `example_send ${JSON.stringify(args)}`,
              reason: "this tool asks for approval before each call",
              kind: "approval",
              approvalKey: callKey,
              summary: "example_send",
              grantModes: { session: false, always: false },
            });
            pausedOnApproval = true;
            reply = "";
          }
        } else if (command0.startsWith("!read ") && gateTool("read")) {
          usedTool = true;
          reply = "";
        } else if (command0.startsWith("!read ")) {
          const path = command0.slice(6).trim();
          const { content } = await turn.tools.read(path);
          await turn.emit({ kind: "ToolResult", tool: "read", body: { path, found: content != null } });
          usedTool = true;
          reply = content ?? `(no file: ${path})`;
        } else if (command0.startsWith("!memorysearch ")) {
          const query = command0.slice("!memorysearch ".length).trim();
          const hits = await turn.tools.memorySearch(query);
          usedTool = true;
          reply = hits?.join("\n") ?? "(memory unavailable)";
        } else if (command0.startsWith("!memoryread ")) {
          const scope = command0.slice("!memoryread ".length).trim();
          reply = (await turn.tools.memoryRead(scope)) ?? "(memory unavailable)";
          usedTool = true;
        } else if (command0.startsWith("!memoryremember ")) {
          const fact = command0.slice("!memoryremember ".length).trim();
          const added = await turn.tools.memoryAdd([fact]);
          usedTool = true;
          reply = added === null ? "(memory unavailable)" : `remembered ${added}`;
        } else if (command0.startsWith("!skill-run ")) {
          const rest = command0.slice(11).trim();
          const sp = rest.indexOf(" ");
          const name = sp === -1 ? rest : rest.slice(0, sp);
          const r = await turn.tools.skill(name);
          usedTool = true;
          if (r.content == null) reply = `(no skill file: ${name}/SKILL.md)`;
          else {
            const command = rest
              .slice(sp + 1)
              .split("{dir}")
              .join(r.dir ?? "");
            const ran = await turn.tools.execute(command);
            reply = (ran.stdout || ran.stderr).trim();
          }
        } else if (command0.startsWith("!skill ")) {
          const [name, path] = command0.slice(7).trim().split(/\s+/);
          const r = await turn.tools.skill(name!, path ? { path } : undefined);
          await turn.emit({
            kind: "ToolResult",
            tool: "skill",
            body: { name, found: r.content != null, ...(r.dir ? { dir: r.dir } : {}) },
          });
          usedTool = true;
          reply =
            r.content == null
              ? `(no skill file: ${name}/${path ?? "SKILL.md"})`
              : `${r.dir ? `${r.dir}\n` : ""}${r.content}`;
        } else if (command0.startsWith("!write ")) {
          const rest = command0.slice(7);
          const sp = rest.indexOf(" ");
          const path = sp === -1 ? rest : rest.slice(0, sp);
          const data = sp === -1 ? "" : rest.slice(sp + 1);
          if (gateTool("write")) {
            usedTool = true;
            reply = "";
          } else {
            await turn.tools.write(path, data);
            usedTool = true;
            reply = `wrote ${path}`;
          }
        } else if (
          command0.startsWith("!writeattach ") ||
          command0.startsWith("!attachsilent ") ||
          command0.startsWith("!attach ")
        ) {
          const tag = ["!writeattach ", "!attachsilent ", "!attach "].find((t) => command0.startsWith(t))!;
          const writing = tag !== "!attach ";
          const rest = command0.slice(tag.length);
          const sp = rest.indexOf(" ");
          const paths = (sp === -1 ? rest : rest.slice(0, sp)).split(",").filter(Boolean);
          if (writing) {
            const data = sp === -1 ? "" : rest.slice(sp + 1);
            for (const path of paths) {
              await turn.tools.execute(`printf %s ${JSON.stringify(data)} > ${JSON.stringify(path)}`);
            }
          }
          await turn.emit({ kind: "ToolCall", tool: "attach", body: { files: paths } });
          const r = await turn.tools.attach(paths);
          await turn.emit({
            kind: "ToolResult",
            tool: "attach",
            body: r.ok ? { ok: true, files: r.files } : { ok: false },
          });
          usedTool = true;
          if (tag === "!attachsilent ") silent = turn.pollFire === true;
          reply = r.ok ? "" : `[not attached] ${r.message}`;
        } else if (command0.startsWith("!reachchan ")) {
          const rest = cmd.slice(cmd.indexOf("!reachchan ") + "!reachchan ".length);
          const sp = rest.indexOf(" ");
          const channel = sp === -1 ? rest : rest.slice(0, sp);
          const msg = sp === -1 ? "" : rest.slice(sp + 1);
          await turn.emit({
            kind: "ToolCall",
            tool: "reach",
            body: { channel, bytes: msg.length },
          });
          const r = await turn.tools.reach(msg, { channel });
          await turn.emit({
            kind: "ToolResult",
            tool: "reach",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? `(reached ${r.matched ?? channel})` : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!postthread ")) {
          const rest = cmd.slice(cmd.indexOf("!postthread ") + "!postthread ".length);
          const sp = rest.indexOf(" ");
          const threadTs = sp === -1 ? rest : rest.slice(0, sp);
          const msg = sp === -1 ? "" : rest.slice(sp + 1);
          await turn.emit({
            kind: "ToolCall",
            tool: "slack",
            body: { action: "post", ts: threadTs, bytes: msg.length },
          });
          const r = await turn.tools.post(msg, { ts: threadTs });
          await turn.emit({
            kind: "ToolResult",
            tool: "post",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(posted in thread)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!broadcast ")) {
          const msg = cmd.slice(cmd.indexOf("!broadcast ") + "!broadcast ".length);
          await turn.emit({
            kind: "ToolCall",
            tool: "slack",
            body: { action: "post", broadcast: true, bytes: msg.length },
          });
          const r = await turn.tools.post(msg, { broadcast: true });
          await turn.emit({
            kind: "ToolResult",
            tool: "post",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(broadcast to channel)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!post2 ")) {
          const rest = cmd.slice(cmd.indexOf("!post2 ") + "!post2 ".length);
          const bar = rest.indexOf("|");
          const msgs = bar === -1 ? [rest] : [rest.slice(0, bar), rest.slice(bar + 1)];
          let sent = 0;
          for (const msg of msgs) {
            await turn.emit({
              kind: "ToolCall",
              tool: "slack",
              body: { action: "post", bytes: msg.length },
            });
            const r = await turn.tools.post(msg);
            await turn.emit({
              kind: "ToolResult",
              tool: "post",
              body: { ok: r.ok },
            });
            if (r.ok) sent++;
          }
          usedTool = true;
          reply = `(posted ${sent})`;
        } else if (command0.startsWith("!post ")) {
          const msg = cmd.slice(cmd.indexOf("!post ") + "!post ".length);
          await turn.emit({
            kind: "ToolCall",
            tool: "slack",
            body: { action: "post", bytes: msg.length },
          });
          const r = await turn.tools.post(msg);
          await turn.emit({
            kind: "ToolResult",
            tool: "post",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(posted)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!postfiles ")) {
          // !postfiles <path>[,<path>...] <message>
          const rest = cmd.slice(cmd.indexOf("!postfiles ") + "!postfiles ".length);
          const sp = rest.indexOf(" ");
          const paths = (sp === -1 ? rest : rest.slice(0, sp)).split(",").filter(Boolean);
          const msg = sp === -1 ? "" : rest.slice(sp + 1);
          const r = await turn.tools.post(msg, undefined, paths);
          await turn.emit({
            kind: "ToolResult",
            tool: "post",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(posted files)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!react ")) {
          const [, ts, emoji] = command0.split(/\s+/);
          const r = await turn.tools.react({ ts: ts ?? "", emoji: emoji ?? "" });
          await turn.emit({
            kind: "ToolResult",
            tool: "react",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(reacted)" : `[not reacted] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!edit ")) {
          const rest = cmd.slice(cmd.indexOf("!edit ") + "!edit ".length);
          const sp = rest.indexOf(" ");
          const editRef = sp === -1 ? rest : rest.slice(0, sp);
          const newText = sp === -1 ? "" : rest.slice(sp + 1);
          const r = await turn.tools.edit({ ref: editRef, text: newText });
          await turn.emit({
            kind: "ToolResult",
            tool: "edit",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(edited)" : `[not edited] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!delete ")) {
          const [, delRef] = command0.split(/\s+/);
          const r = await turn.tools.delete({ ref: delRef ?? "" });
          await turn.emit({
            kind: "ToolResult",
            tool: "delete",
            body: { ok: r.ok },
          });
          usedTool = true;
          reply = r.ok ? "(deleted)" : `[not deleted] ${r.message ?? "failed"}`;
        } else if (command0 === "!read_thread" || command0.startsWith("!read_thread ")) {
          const r = await turn.tools.readThread();
          await turn.emit({
            kind: "ToolResult",
            tool: "read_thread",
            body: { ok: r.ok, count: (r.messages ?? []).length },
          });
          usedTool = true;
          reply = r.ok
            ? `read ${(r.messages ?? []).length} message(s)`
            : `[couldn't read] ${r.message ?? "unavailable"}`;
        } else if (command0 === "!whats_new") {
          const r = await turn.tools.whatsNew();
          await turn.emit({ kind: "ToolResult", tool: "whats_new", body: { ok: r.ok } });
          usedTool = true;
          reply = r.ok
            ? `whats_new here=${r.hereNew ?? 0} others=${r.activeSubConversations ?? 0}${r.coverageSince ? ` coverage=${r.coverageSince}` : ""}`
            : `[couldn't check] ${r.message ?? "unavailable"}`;
        } else if (command0.startsWith("!search ")) {
          let q = cmd.slice(cmd.indexOf("!search ") + "!search ".length);
          let source: "mirror" | "slack" | undefined;
          const sourceMatch = q.match(/^source=(mirror|slack)\s+/);
          if (sourceMatch) {
            source = sourceMatch[1] as "mirror" | "slack";
            q = q.slice(sourceMatch[0].length);
          }
          const r = await turn.tools.search(q, source ? { source } : undefined);
          await turn.emit({ kind: "ToolResult", tool: "search", body: { ok: r.ok, count: (r.hits ?? []).length } });
          usedTool = true;
          const first = (r.hits ?? [])[0];
          reply = r.ok
            ? `search(${r.source ?? "?"}) ${(r.hits ?? []).length} hit(s)${first ? ` first=${first.author ?? "?"}:${first.snippet}` : ""}${r.coverageSince ? ` coverage=${r.coverageSince}` : ""}`
            : `[couldn't search] ${r.message ?? "unavailable"}`;
        } else if (command0 === "!read_members") {
          const r = await turn.tools.readMembers();
          await turn.emit({
            kind: "ToolResult",
            tool: "read_members",
            body: { ok: r.ok, count: (r.members ?? []).length },
          });
          usedTool = true;
          reply = r.ok
            ? `members: ${(r.members ?? []).map((m) => m.displayName).join(", ")}`
            : `[couldn't read members] ${r.message ?? "unavailable"}`;
        } else if (command0.startsWith("!read_file ")) {
          const refArg = cmd.slice(cmd.indexOf("!read_file ") + "!read_file ".length).trim();
          const r = await turn.tools.readFile(refArg);
          await turn.emit({ kind: "ToolResult", tool: "read_file", body: { ok: r.ok } });
          usedTool = true;
          if (!r.ok) {
            reply = `[couldn't read file] ${r.message ?? "unavailable"}`;
          } else if (r.content !== undefined) {
            reply = `file: ${r.content}`;
          } else {
            reply = `file-pointer: ${r.sizeBytes ?? 0}B ${r.contentType ?? "binary"}`;
          }
        } else if (command0.startsWith("!set_standing_order ")) {
          const orders = cmd.slice(cmd.indexOf("!set_standing_order ") + "!set_standing_order ".length).trim();
          const r = await turn.tools.setStandingOrder(orders);
          await turn.emit({ kind: "ToolResult", tool: "set_standing_order", body: { ok: r.ok } });
          usedTool = true;
          reply = r.ok ? "standing order set" : `[couldn't set standing order] ${r.message ?? "unavailable"}`;
        } else if (command0 === "!get_standing_order") {
          const r = await turn.tools.getStandingOrder();
          await turn.emit({ kind: "ToolResult", tool: "get_standing_order", body: { ok: r.ok } });
          usedTool = true;
          reply = r.ok
            ? `standing order: ${r.orders || "(none)"}`
            : `[couldn't read standing order] ${r.message ?? "unavailable"}`;
        } else if (command0 === "!priorturns") {
          reply = turn.priorTurns?.length
            ? "priorturns:\n" +
              turn.priorTurns.map((t) => `${t.role}${t.name ? `/${t.name}` : ""}: ${t.text}`).join("\n")
            : "priorturns:none";
        } else if (command0 === "!overheard") {
          reply = turn.overheard?.length
            ? "overheard:\n" +
              turn.overheard
                .map((m) => `${m.name ?? "you"}@${m.ts}: ${m.text}${m.files?.length ? ` [${m.files.join(",")}]` : ""}`)
                .join("\n")
            : "overheard:none";
        } else {
          reply = `You said: ${modelPrompt}`;
        }
        if (usedTool) {
          await turn.recordLlmRequest?.({
            turnSeq: userEntry.seq,
            step: 1,
            model: "mock",
            promptEnvelope: {
              model: "mock",
              system: turn.systemPrompt,
              messages: [...mockProviderMessages(turn.history), { role: "user", content: modelPrompt }],
              ...(turn.images?.length
                ? { images: turn.images.map((image) => ({ mimeType: image.mimeType, dataBase64: image.dataBase64 })) }
                : {}),
              ...(turn.documents?.length
                ? {
                    documents: turn.documents.map(({ name, mimeType, artifactId }) => ({ name, mimeType, artifactId })),
                  }
                : {}),
            },
            truncated: false,
            usage: callUsage(1),
          });
        }
        if (turn.images?.length)
          reply += `\n[vision: ${turn.images.length} image(s): ${turn.images.map((i) => i.mimeType).join(", ")}]`;

        if (turn.onDelta) for (const chunk of streamChunks(reply)) turn.onDelta(chunk);

        await turn.emit({ kind: "AgentMessage", text: reply });
        const modelCalls = usedTool ? 2 : 1;
        const steps = Array.from({ length: modelCalls }, (_, step) => callUsage(step));
        const cacheUsage = steps.reduce(
          (acc, u) => ({
            cacheRead: acc.cacheRead + u.cacheRead,
            cacheWrite: acc.cacheWrite + u.cacheWrite,
            uncachedInput: acc.uncachedInput + u.input,
          }),
          { cacheRead: 0, cacheWrite: 0, uncachedInput: 0 },
        );
        const base = collected.length
          ? {
              reply,
              pendingApprovals: collected,
              ...(pausedOnApproval ? { pausedOnApproval: true as const } : {}),
              modelCalls,
            }
          : { reply, modelCalls };
        if (muteReply) base.reply = "";
        return { ...base, ...(silent ? { silent: true as const } : {}), cacheUsage };
      },

      shouldRespond(detect: HarnessDetectInput): Promise<HarnessDetectResult> {
        const msg = detect.message.trim();
        const first = msg.split("\n")[0]?.trim() ?? "";
        if (first.startsWith("!")) return Promise.resolve({ respond: true, reason: "command" });
        if (msg.endsWith("?")) return Promise.resolve({ respond: true, reason: "question" });
        if (/\b(agent|bot)\b/i.test(msg)) return Promise.resolve({ respond: true, reason: "addressed" });
        if (
          detect.reactionGuidance?.trim() &&
          /\b(thanks|thank you|thx|ty|nice|great|awesome|perfect|lgtm)\b/i.test(msg)
        ) {
          return Promise.resolve({ respond: false, reactions: ["pray"], reason: "acknowledgement" });
        }
        if (detect.threadOpener?.trim()) return Promise.resolve({ respond: true, reason: "own thread" });
        return Promise.resolve({ respond: false, reason: "not addressed" });
      },

      async compactHistory({ history }) {
        return deterministicCompactSummary(history);
      },

      oneShot(systemPrompt: string, prompt: string): Promise<string | undefined> {
        if (systemPrompt.startsWith("You extract durable facts worth remembering")) {
          const facts: string[] = [];
          for (const match of prompt.matchAll(/User said:\n([\s\S]*?)\n\nAssistant replied:/g)) {
            for (const raw of (match[1] ?? "").split(/[\n.!?]+/)) {
              const sentence = raw.trim();
              if (!sentence || sentence.startsWith("!")) continue;
              const remembered = /\bremember(?:\s+that)?\b[:,]?\s*(.+)/i.exec(sentence)?.[1];
              if (remembered) facts.push(remembered.trim());
              else if (/^(my|i'm|i am|i prefer|i work|i use|i like|call me)\b/i.test(sentence)) facts.push(sentence);
            }
          }
          return Promise.resolve(facts.length ? facts.map((fact) => `- ${fact}`).join("\n") : "NONE");
        }
        return Promise.resolve(`mock one-shot reply to: ${prompt.slice(0, 200)}`);
      },

      judge(_systemPrompt: string, prompt: string): Promise<string | undefined> {
        const asked = /!engage-asked\b[:\s]*(.*)/i.exec(prompt);
        if (asked) {
          const id = /^\[([^\]]+)\]/m.exec(prompt)?.[1];
          return Promise.resolve(
            JSON.stringify({
              act: true,
              reason: (asked[1] ?? "").trim() || "someone asked",
              ...(id ? { asked_by: id } : {}),
            }),
          );
        }
        const m = /!engage\b(?!-asked)[:\s]*(.*)/i.exec(prompt);
        if (m)
          return Promise.resolve(
            JSON.stringify({ act: true, reason: (m[1] ?? "").trim() || "standing order matched" }),
          );
        return Promise.resolve(JSON.stringify({ act: false }));
      },

      async screenSecurity({
        payload,
        modelId,
        systemPrompt = SECURITY_SCREEN_SYSTEM_PROMPT,
        signal,
        recordModelCall,
        recordLlmRequest,
      }) {
        const model = modelId ?? "mock-security";
        recordModelCall({
          model,
          inputTokens: countTokens(systemPrompt) + countTokens(payload),
          entryCount: 1,
        });
        await recordLlmRequest?.({
          turnSeq: null,
          step: SECURITY_SCREEN_STEP,
          model,
          promptEnvelope: { system: systemPrompt, messages: [{ role: "user", content: payload }] },
          truncated: false,
        });
        if (/!security-screen-hang/i.test(payload)) {
          return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
        }
        if (/!security-screen-unavailable/i.test(payload)) return Promise.resolve(undefined);
        if (/!security-screen-flaky-once/i.test(payload) && !flakyScreens.has(payload)) {
          flakyScreens.add(payload);
          return Promise.resolve(undefined);
        }
        const strict = /ignore (?:all|prior|previous) instructions|reveal (?:the )?secrets?|!security-risk/i.test(
          payload,
        );
        return Promise.resolve(
          strict ? { decision: "strict", reason: "instruction in untrusted data" } : { decision: "auto" },
        );
      },

      generateTitle(transcript: string): Promise<string | undefined> {
        if (transcript.includes("Simulate title provider exception"))
          return Promise.reject(new Error("title model overloaded"));
        if (transcript.includes("Simulate reply-shaped title"))
          return Promise.reject(new TitleRejected("reply_opener", "Sorry, I can't title this one"));
        if (transcript.includes("Simulate four-way title outage")) return Promise.resolve(undefined);
        const line = transcript
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !/^(user|assistant):$/i.test(l));
        if (!line) return Promise.resolve(undefined);
        const words = line.split(/\s+/).slice(0, 5).join(" ");
        return Promise.resolve(words ? `Chat: ${words}` : undefined);
      },

      summarizeApproval(command: string, reason: string): Promise<string | undefined> {
        if (command.includes("!summary-boom")) return Promise.reject(new Error("boom: simulated summary fault"));
        if (command.includes("!summary-hang")) return new Promise(() => {});
        if (command.includes("!summary-none")) return Promise.resolve(undefined);
        return Promise.resolve(`In plain English: ${command.split("\n")[0]!.slice(0, 80)} (${reason}).`);
      },
    },
  );
}
