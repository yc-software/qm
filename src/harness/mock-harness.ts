import {
  defineHarness,
  type Harness,
  type HarnessDetectInput,
  type HarnessDetectResult,
  type HarnessTurnInput,
  type HarnessTurnResult,
} from "./harness.ts";
import { classifyScopeLabel } from "../classify/scope-classifier.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { NeedsApproval } from "../tools/primitives.ts";
import { deterministicCompactSummary, estimateHistoryTokens } from "./context-compaction.ts";
import { countTokens } from "../util/tokens.ts";
import { SECURITY_SCREEN_SYSTEM_PROMPT } from "../security/security-posture.ts";

const READ_ONLY_BLOCKED_PREFIXES = [
  "!preamble",
  "!speakpost ",
  "!run ",
  "!scratch ",
  "!owner ",
  "!reach ",
  "!paused-approval ",
  "!collect-approval ",
  "!collect-exec ",
  "!double-exec ",
  "!read ",
  "!write ",
  "!writequiet ",
  "!reachchan ",
  "!postthread ",
  "!broadcast ",
  "!post ",
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

function textPayload(payload: unknown): string {
  const text = (payload as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

function mockProviderMessages(
  history: HarnessTurnInput["history"],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history.flatMap((e) => {
    if (e.type !== "user" && e.type !== "assistant") return [];
    const content = textPayload(e.payload);
    return content.trim() ? [{ role: e.type, content }] : [];
  });
}

export function createMockHarness(): Harness {
  const shedSessions = new Set<string>();
  const boomAlwaysSessions = new Set<string>();
  const flakyScreens = new Set<string>();
  return defineHarness(
    {
      id: "mock",
      controlTransport: "mock",
      toolTransport: "mock",
      transcriptFormat: "qm",
      capabilities: new Set(),
    },
    {
      async runTurn(turn: HarnessTurnInput): Promise<HarnessTurnResult> {
        const userEntry = await turn.emit({
          type: "user",
          payload: {
            text: turn.input,
            ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          },
          scopeLabel: turn.scopeLabel,
        });
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
          request: {
            model: "mock",
            system: turn.systemPrompt,
            messages: [...mockProviderMessages(turn.history), { role: "user", content: modelPrompt }],
            ...(turn.images?.length
              ? { images: turn.images.map((image) => ({ mimeType: image.mimeType, dataBase64: image.dataBase64 })) }
              : {}),
            ...(turn.tapeMode ? { tapeMode: turn.tapeMode } : {}),
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
        } else if (command0 === "!work-then-boom") {
          await turn.emit({
            type: "tool_call",
            payload: { tool: "execute", command: "make build" },
            scopeLabel: turn.scopeLabel,
          });
          await turn.emit({ type: "tool_result", payload: { tool: "execute", ok: true }, scopeLabel: turn.scopeLabel });
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
            await turn.emit({
              type: "tool_call",
              payload: { tool: "slack", action: "post" },
              scopeLabel: turn.scopeLabel,
            });
            const r = await turn.tools.post("nudged reply");
            await turn.emit({ type: "tool_result", payload: { tool: "post", ok: r.ok }, scopeLabel: turn.scopeLabel });
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
        } else if (command0.startsWith("!preamble")) {
          const preamble = cmd.slice(cmd.indexOf("!preamble") + "!preamble".length).trim() || "On it — checking.";
          if (turn.onDelta) for (const chunk of streamChunks(preamble)) turn.onDelta(chunk);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "execute", command: "check" },
            scopeLabel: turn.scopeLabel,
          });
          await turn.emit({ type: "tool_result", payload: { tool: "execute", ok: true }, scopeLabel: turn.scopeLabel });
          usedTool = true;
          turn.onTextBlockStart?.();
          reply = `${preamble}\n\nAll clear — nothing broke.`;
        } else if (command0.startsWith("!speakpost ")) {
          const msg = cmd.slice(cmd.indexOf("!speakpost ") + "!speakpost ".length);
          if (turn.onDelta) for (const chunk of streamChunks("Answering directly.")) turn.onDelta(chunk);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "slack", action: "post", bytes: msg.length },
            scopeLabel: turn.scopeLabel,
          });
          const r = await turn.tools.post(msg);
          await turn.emit({ type: "tool_result", payload: { tool: "post", ok: r.ok }, scopeLabel: turn.scopeLabel });
          usedTool = true;
          reply = r.ok ? "(posted)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!staysilent")) {
          const reason = cmd.slice(cmd.indexOf("!staysilent") + "!staysilent".length).trim() || "nothing to add";
          await turn.emit({ type: "tool_call", payload: { tool: "stay_silent" }, scopeLabel: turn.scopeLabel });
          const r = await turn.tools.staySilent(reason);
          await turn.emit({
            type: "tool_result",
            payload: { tool: "stay_silent", ok: r.ok },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.message;
        } else if (command0 === "!finish-silent") {
          usedTool = true;
          silent = turn.pollFire === true;
          reply = turn.pollFire ? "" : "Nothing to report; ending silently.";
        } else if (command0 === "!finish-silent-approval") {
          usedTool = true;
          silent = turn.pollFire === true;
          reply = turn.pollFire ? "" : "I couldn't finish one check, but nothing to report.";
          collected.push({ command: "gated-check", reason: "requires approval" });
        } else if (command0 === "!cachemiss") {
          reply = "re-prefilled the prefix";
        } else if (command0 === "!histcount") {
          reply = `history:${turn.history.length}`;
        } else if (command0 === "!sysprompt") {
          reply = turn.systemPrompt;
        } else if (command0 === "!wallclock") {
          reply = `wallclock:${turn.turnWallClockMs ?? 0}`;
        } else if (command0.startsWith("!askagent ")) {
          const rest = command0.slice("!askagent ".length).trim();
          const sp = rest.indexOf(" ");
          const target = sp === -1 ? rest : rest.slice(0, sp);
          const task = sp === -1 ? "help with this request" : rest.slice(sp + 1).trim();
          reply = `I'll ask their personal agent.\n\n[[ask-agent: ${target} | ${task}]]`;
        } else if (command0.startsWith("!think ")) {
          await turn.emit({
            type: "thinking",
            payload: { thinking: command0.slice("!think ".length), thinkingSignature: "OPAQUE-SIG-BYTES" },
            scopeLabel: turn.scopeLabel,
          });
          reply = "thought about it";
        } else if (command0.startsWith("!run ") || command0.startsWith("!scratch ") || command0.startsWith("!owner ")) {
          let tag = "!run ";
          if (command0.startsWith("!scratch ")) tag = "!scratch ";
          else if (command0.startsWith("!owner ")) tag = "!owner ";
          const command = cmd.slice(cmd.indexOf(tag) + tag.length);
          if (gateTool("execute")) {
            await turn.emit({
              type: "tool_call",
              payload: { tool: "execute", command, blocked: "needs_approval" },
              scopeLabel: turn.scopeLabel,
            });
            usedTool = true;
            reply = "";
          } else {
            await turn.emit({ type: "tool_call", payload: { tool: "execute", command }, scopeLabel: turn.scopeLabel });
            let opts: { scratch?: boolean; ownerAuth?: boolean } | undefined;
            if (tag === "!scratch ") opts = { scratch: true };
            else if (tag === "!owner ") opts = { ownerAuth: true };
            const result = await turn.tools.execute(command, opts);
            await turn.emit({ type: "tool_result", payload: result, scopeLabel: turn.scopeLabel });
            turn.onProgress?.({ toolCalls: 1 });
            usedTool = true;
            reply = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
          }
        } else if (command0.startsWith("!reach ")) {
          const rest = command0.slice("!reach ".length);
          const sp = rest.indexOf(" ");
          const room = sp === -1 ? rest : rest.slice(0, sp);
          const command = sp === -1 ? "" : rest.slice(sp + 1);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "execute", command, scope: room },
            scopeLabel: turn.scopeLabel,
          });
          try {
            const result = await turn.tools.execute(command, { reachTarget: room });
            await turn.emit({ type: "tool_result", payload: { ...result }, scopeLabel: turn.scopeLabel });
            reply = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
          } catch (e) {
            reply = `[reach error] ${e instanceof Error ? e.message : String(e)}`;
          }
          turn.onProgress?.({ toolCalls: 1 });
          usedTool = true;
        } else if (command0.startsWith("!paused-approval ")) {
          const command = command0.slice("!paused-approval ".length);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "execute", command, blocked: "needs_approval" },
            scopeLabel: turn.scopeLabel,
          });
          collected.push({ command, reason: "requires approval" });
          pausedOnApproval = true;
          usedTool = true;
          reply = `about to run it`;
        } else if (command0 === "!finish-silent-paused") {
          usedTool = true;
          silent = turn.pollFire === true;
          pausedOnApproval = true;
          collected.push({ command: "gated-check", reason: "requires approval" });
          reply = "";
        } else if (command0.startsWith("!collect-approval ")) {
          const command = command0.slice("!collect-approval ".length);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "execute", command, blocked: "needs_approval" },
            scopeLabel: turn.scopeLabel,
          });
          collected.push({ command, reason: "requires approval" });
          usedTool = true;
          reply = `worked around it; done`;
        } else if (command0.startsWith("!collect-exec ")) {
          const command = command0.slice("!collect-exec ".length);
          await turn.emit({ type: "tool_call", payload: { tool: "execute", command }, scopeLabel: turn.scopeLabel });
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
            });
            reply = `[blocked] ${e.approvalReason}`;
          }
          usedTool = true;
        } else if (command0.startsWith("!double-exec ")) {
          const command = command0.slice("!double-exec ".length);
          let ran = 0;
          for (let i = 0; i < 2; i++) {
            await turn.emit({ type: "tool_call", payload: { tool: "execute", command }, scopeLabel: turn.scopeLabel });
            try {
              const result = await turn.tools.execute(command);
              await turn.emit({ type: "tool_result", payload: result, scopeLabel: turn.scopeLabel });
              ran++;
            } catch (e) {
              if (!(e instanceof NeedsApproval)) throw e;
              collected.push({
                command: e.command,
                reason: e.approvalReason,
                kind: e.kind,
                matched: e.matched,
                ...(e.approvalKey ? { approvalKey: e.approvalKey } : {}),
              });
            }
          }
          usedTool = true;
          reply = `ran ${ran}`;
        } else if (command0.startsWith("!read ") && gateTool("read")) {
          usedTool = true;
          reply = "";
        } else if (command0.startsWith("!read ")) {
          const path = command0.slice(6).trim();
          const { content, sourceScopeId } = await turn.tools.read(path);
          await turn.emit({
            type: "tool_result",
            payload: { tool: "read", path, found: content != null },
            scopeLabel: classifyScopeLabel({
              type: "tool_result",
              sessionScopeId: turn.scopeLabel,
              orgScopeId: turn.orgScopeId,
              sourceScopeId,
            }),
          });
          usedTool = true;
          reply = content ?? `(no file: ${path})`;
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
        } else if (command0.startsWith("!writequiet ")) {
          const rest = command0.slice("!writequiet ".length);
          const sp = rest.indexOf(" ");
          const name = (sp === -1 ? rest : rest.slice(0, sp)).replace(/^outbox\//, "");
          const data = sp === -1 ? "" : rest.slice(sp + 1);
          await turn.tools.execute(
            `mkdir -p "$AGENT_OUTBOX" && printf %s ${JSON.stringify(data)} > "$AGENT_OUTBOX/"${JSON.stringify(name)}`,
          );
          usedTool = true;
          reply = "";
        } else if (command0.startsWith("!reachchan ")) {
          const rest = cmd.slice(cmd.indexOf("!reachchan ") + "!reachchan ".length);
          const sp = rest.indexOf(" ");
          const channel = sp === -1 ? rest : rest.slice(0, sp);
          const msg = sp === -1 ? "" : rest.slice(sp + 1);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "reach", channel, bytes: msg.length },
            scopeLabel: turn.scopeLabel,
          });
          const r = await turn.tools.reach(msg, { channel });
          await turn.emit({
            type: "tool_result",
            payload: { tool: "reach", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok ? `(reached ${r.matched ?? channel})` : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!postthread ")) {
          const rest = cmd.slice(cmd.indexOf("!postthread ") + "!postthread ".length);
          const sp = rest.indexOf(" ");
          const threadTs = sp === -1 ? rest : rest.slice(0, sp);
          const msg = sp === -1 ? "" : rest.slice(sp + 1);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "slack", action: "post", ts: threadTs, bytes: msg.length },
            scopeLabel: turn.scopeLabel,
          });
          const r = await turn.tools.post(msg, { ts: threadTs });
          await turn.emit({
            type: "tool_result",
            payload: { tool: "post", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok ? "(posted in thread)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!broadcast ")) {
          const msg = cmd.slice(cmd.indexOf("!broadcast ") + "!broadcast ".length);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "slack", action: "post", broadcast: true, bytes: msg.length },
            scopeLabel: turn.scopeLabel,
          });
          const r = await turn.tools.post(msg, { broadcast: true });
          await turn.emit({
            type: "tool_result",
            payload: { tool: "post", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok ? "(broadcast to channel)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!post ")) {
          const msg = cmd.slice(cmd.indexOf("!post ") + "!post ".length);
          await turn.emit({
            type: "tool_call",
            payload: { tool: "slack", action: "post", bytes: msg.length },
            scopeLabel: turn.scopeLabel,
          });
          const r = await turn.tools.post(msg);
          await turn.emit({
            type: "tool_result",
            payload: { tool: "post", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok ? "(posted)" : `[not sent] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!react ")) {
          const [, ts, emoji] = command0.split(/\s+/);
          const r = await turn.tools.react({ ts: ts ?? "", emoji: emoji ?? "" });
          await turn.emit({
            type: "tool_result",
            payload: { tool: "react", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            scopeLabel: turn.scopeLabel,
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
            type: "tool_result",
            payload: { tool: "edit", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok ? "(edited)" : `[not edited] ${r.message ?? "failed"}`;
        } else if (command0.startsWith("!delete ")) {
          const [, delRef] = command0.split(/\s+/);
          const r = await turn.tools.delete({ ref: delRef ?? "" });
          await turn.emit({
            type: "tool_result",
            payload: { tool: "delete", ok: r.ok, ...(r.deliveryId ? { deliveryId: r.deliveryId } : {}) },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok ? "(deleted)" : `[not deleted] ${r.message ?? "failed"}`;
        } else if (command0 === "!read_thread" || command0.startsWith("!read_thread ")) {
          const r = await turn.tools.readThread();
          await turn.emit({
            type: "tool_result",
            payload: { tool: "read_thread", ok: r.ok, count: (r.messages ?? []).length },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok
            ? `read ${(r.messages ?? []).length} message(s)`
            : `[couldn't read] ${r.message ?? "unavailable"}`;
        } else if (command0 === "!whats_new") {
          const r = await turn.tools.whatsNew();
          await turn.emit({
            type: "tool_result",
            payload: { tool: "whats_new", ok: r.ok },
            scopeLabel: turn.scopeLabel,
          });
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
          await turn.emit({
            type: "tool_result",
            payload: { tool: "search", ok: r.ok, count: (r.hits ?? []).length },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          const first = (r.hits ?? [])[0];
          reply = r.ok
            ? `search(${r.source ?? "?"}) ${(r.hits ?? []).length} hit(s)${first ? ` first=${first.author ?? "?"}:${first.snippet}` : ""}${r.coverageSince ? ` coverage=${r.coverageSince}` : ""}`
            : `[couldn't search] ${r.message ?? "unavailable"}`;
        } else if (command0 === "!read_members") {
          const r = await turn.tools.readMembers();
          await turn.emit({
            type: "tool_result",
            payload: { tool: "read_members", ok: r.ok, count: (r.members ?? []).length },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok
            ? `members: ${(r.members ?? []).map((m) => m.displayName).join(", ")}`
            : `[couldn't read members] ${r.message ?? "unavailable"}`;
        } else if (command0.startsWith("!read_file ")) {
          const refArg = cmd.slice(cmd.indexOf("!read_file ") + "!read_file ".length).trim();
          const r = await turn.tools.readFile(refArg);
          await turn.emit({
            type: "tool_result",
            payload: { tool: "read_file", ok: r.ok },
            scopeLabel: turn.scopeLabel,
          });
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
          await turn.emit({
            type: "tool_result",
            payload: { tool: "set_standing_order", ok: r.ok },
            scopeLabel: turn.scopeLabel,
          });
          usedTool = true;
          reply = r.ok ? "standing order set" : `[couldn't set standing order] ${r.message ?? "unavailable"}`;
        } else if (command0 === "!get_standing_order") {
          const r = await turn.tools.getStandingOrder();
          await turn.emit({
            type: "tool_result",
            payload: { tool: "get_standing_order", ok: r.ok },
            scopeLabel: turn.scopeLabel,
          });
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
            request: {
              model: "mock",
              system: turn.systemPrompt,
              messages: [...mockProviderMessages(turn.history), { role: "user", content: modelPrompt }],
              ...(turn.images?.length
                ? { images: turn.images.map((image) => ({ mimeType: image.mimeType, dataBase64: image.dataBase64 })) }
                : {}),
              ...(turn.tapeMode ? { tapeMode: turn.tapeMode } : {}),
            },
            truncated: false,
            usage: callUsage(1),
          });
        }
        if (turn.images?.length)
          reply += `\n[vision: ${turn.images.length} image(s): ${turn.images.map((i) => i.mimeType).join(", ")}]`;

        if (turn.onDelta) for (const chunk of streamChunks(reply)) turn.onDelta(chunk);

        await turn.emit({ type: "assistant", payload: { text: reply }, scopeLabel: turn.scopeLabel });
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

      async screenSecurity({ payload, signal, recordModelCall, recordLlmRequest }) {
        const model = "mock-security";
        recordModelCall({
          model,
          inputTokens: countTokens(SECURITY_SCREEN_SYSTEM_PROMPT) + countTokens(payload),
          entryCount: 1,
        });
        await recordLlmRequest?.({
          turnSeq: null,
          step: -1,
          model,
          request: { system: SECURITY_SCREEN_SYSTEM_PROMPT, messages: [{ role: "user", content: payload }] },
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
