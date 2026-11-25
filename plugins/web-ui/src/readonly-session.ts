import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import "./slack-reply";
import type { SlackReply } from "./slack-reply";
import { SlackOutbox } from "./slack-outbox";
import {
  fetchSessionApprovals,
  runApprovalTurn,
  unresolvedApprovals,
  type ApprovalDecision,
  type CoreSession,
  type PendingApproval,
} from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { transcriptModel } from "./model-options";
import { repliesAsViewer } from "./session-list";
import { appState } from "./shell";

export type ReadOnlySessionDeps = {
  slackOutbox: SlackOutbox;
  resolvingApprovals: Set<string>;
  onRedraw: () => void;
  onDelivery: (threadRef: string) => void;
  onScrollToBottom: () => void;
  onError: (message: string) => void;
};

export type ReadOnlySessionController = {
  active: () => boolean;
  session: () => CoreSession | null;
  slackReply: () => SlackReply | null;
  approvals: () => PendingApproval[];
  pendingSlackMessages: () => AgentMessage[];
  confirmSlackMessages: (messages: AgentMessage[]) => void;
  consumeFollowSend: () => boolean;
  activate: (s: CoreSession, container: HTMLElement, sameSession: boolean, messages: AgentMessage[]) => void;
  refreshApprovals: () => Promise<void>;
  approve: (decision: ApprovalDecision) => Promise<void> | null;
  clear: () => void;
};

export function createReadOnlySession(deps: ReadOnlySessionDeps): ReadOnlySessionController {
  let currentSession: CoreSession | null = null;
  let replyEl: SlackReply | null = null;
  let pendingApprovals: PendingApproval[] = [];
  let followSend = false;
  let generation = 0;

  function clear(): void {
    generation++;
    currentSession = null;
    replyEl = null;
    pendingApprovals = [];
  }

  function activate(s: CoreSession, container: HTMLElement, sameSession: boolean, messages: AgentMessage[]): void {
    generation++;
    currentSession = s;
    pendingApprovals = [];
    const priorReply = sameSession ? container.querySelector<SlackReply>("qm-slack-reply") : null;
    replyEl = repliesAsViewer(s) ? (priorReply ?? (document.createElement("qm-slack-reply") as SlackReply)) : null;
    if (replyEl) {
      replyEl.sessionId = s.id;
      replyEl.user = appState.me?.user ?? "";
      const seen = new Map<string, string>();
      for (const m of messages) {
        const { speaker, speakerId } = m as { speaker?: string; speakerId?: string };
        if (speaker && speakerId && speakerId !== replyEl.user) seen.set(speakerId, speaker);
      }
      replyEl.participants = [...seen].map(([id, name]) => ({ id, name }));
      if (!priorReply) {
        deps.slackOutbox.listen(replyEl, {
          queued: () => {
            deps.onRedraw();
            deps.onScrollToBottom();
          },
          sent: () => {
            followSend = true;
            deps.onDelivery(s.threadRef);
          },
          dropped: () => deps.onRedraw(),
        });
      }
    }
    deps.slackOutbox.confirm(s.id, messages);
  }

  async function refreshApprovals(): Promise<void> {
    const s = currentSession;
    const gen = generation;
    if (!s) return;
    const result = await fetchSessionApprovals(s.id);
    if (gen !== generation) return;
    pendingApprovals = result?.approvals ?? [];
    deps.onRedraw();
  }

  function approve(decision: ApprovalDecision): Promise<void> | null {
    const s = currentSession;
    const gen = generation;
    if (!s) return null;
    return (async () => {
      if (
        gen !== generation ||
        deps.resolvingApprovals.size ||
        !pendingApprovals.some((a) => a.requestId === decision.requestId)
      )
        return;
      deps.resolvingApprovals.add(decision.requestId);
      deps.onError("");
      deps.onRedraw();
      let completed = false;
      try {
        await runApprovalTurn(new Agent({ initialState: { model: transcriptModel() } }), decision, undefined);
        completed = true;
      } catch (error) {
        if (gen === generation) deps.onError(errMessage(error, "Could not send the approval."));
      } finally {
        if (gen === generation) {
          deps.resolvingApprovals.delete(decision.requestId);
          await refreshApprovals();
          if (completed && gen === generation) deps.onDelivery(s.threadRef);
        }
      }
    })();
  }

  return {
    active: () => currentSession !== null,
    session: () => currentSession,
    slackReply: () => replyEl,
    approvals: () => {
      pendingApprovals = unresolvedApprovals(pendingApprovals);
      return pendingApprovals;
    },
    pendingSlackMessages: () => (currentSession ? deps.slackOutbox.pending(currentSession.id) : []),
    confirmSlackMessages: (messages) => {
      if (currentSession) deps.slackOutbox.confirm(currentSession.id, messages);
    },
    consumeFollowSend: () => {
      const value = followSend;
      followSend = false;
      return value;
    },
    activate,
    refreshApprovals,
    approve,
    clear,
  };
}
