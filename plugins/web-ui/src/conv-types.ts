import type { Agent } from "@earendil-works/pi-agent-core";
import type { TemplateResult } from "lit";
import type { DensityTier } from "./density";
import type { Attachment } from "@earendil-works/pi-web-ui";
import type { ApprovalDecision, CoreSession, PendingApproval, entriesToMessages } from "./core-bridge";
import type { EffortLevel, ModelOption } from "./model-options";
import type { ComposerMenu } from "./composer";

interface PaneState {
  threadRef: string | null;
  sessionId: string | null;
  working: boolean;
}

export interface ConvHost {
  pane: boolean;
  ownsUrl: boolean;
  container(): HTMLElement | null;
  claimContainer(): HTMLElement | null;
  visible(): boolean;
  density(): DensityTier;
  onDensityChange(handler: () => void): void;
  ensureDeliveryStream(): void;
  onState?(state: PaneState): void;
  onExpand?(): void;
}

export interface ConvCtx extends ConvHost {
  chat: ChatSurface;
  composer: ComposerSurface;
}

interface ChatState {
  agent: Agent | null;
  host: HTMLElement | null;
  threadRef: string | null;
  sessionId: string | null;
  scopeId: string | null;
  contextName: string | null;
  rememberedThreadRef: string | null;
  rememberedSessionId: string | null;
  rememberedScopeId: string | null;
  rememberedContextName: string | null;
  pendingSend: string | null;
  resolvingApprovals: Set<string>;
  transcriptAnchorSeq: number | null;
  earlierCount: number;
  loadingEarlier: boolean;
}

export interface ChatSurface {
  state: ChatState;
  hasLiveRun(): boolean;
  signalLiveRun(kind: "abort" | "steer", text?: string): Promise<import("./core-bridge").SignalOutcome>;
  newChat(context?: { scopeId: string; name: string | null }): string;
  teardown(): void;
  resetChatState(): void;
  mountContinuable(
    threadRef: string,
    sessionId: string | null,
    scopeId: string | null,
    messages: ReturnType<typeof entriesToMessages>,
    contextName?: string | null,
  ): void;
  mountReadOnly(
    s: CoreSession,
    messages: ReturnType<typeof entriesToMessages>,
    earlierCount?: number,
    anchorSeq?: number | null,
  ): void;
  mountLoadingPane(): void;
  drawActiveChat(agent?: Agent | null, opts?: { forceScroll?: boolean }): void;
  setTranscriptWindow(anchorSeq: number | null, earlierCount: number): void;
  requestBackgroundPanel(sessionId: string | null, threadRef: string | null): void;
  activePendingApprovals(): PendingApproval[];
  hasUnresolvedApproval(): boolean;
  resolveCommandApproval(decision: ApprovalDecision): void;
  approvalSummaryView(a: PendingApproval, expanded?: boolean): TemplateResult;
  notePendingSessionOnSend(): void;
  syncPaneState(): void;
  onDelivery(threadRef: string): void;
  resumeIfIdle(): void;
  redraw(): void;
  dispose(): void;
}

interface ComposerState {
  draft: string;
  attachments: Attachment[];
  error: string;
  processingFiles: boolean;
  dragging: boolean;
  openMenu: ComposerMenu | null;
  slashDismissed: boolean;
  effortLevel: EffortLevel;
  fastMode: boolean | undefined;
  pasteView: { id: string; text: string; initial: string; dirty: boolean } | null;
}

export interface ComposerSurface {
  state: ComposerState;
  composerForm(agent: Agent): TemplateResult;
  resetComposer(): void;
  focusComposerEnd(): void;
  resizeComposer(): void;
  currentModelOption(): ModelOption;
  carryModelPick(fromThreadRef: string | null, toThreadRef: string): void;
  refreshRuntimeSelection(scopeId: string | null, agent?: Agent): Promise<void>;
  onDragEnter(e: DragEvent): void;
  onDragOver(e: DragEvent): void;
  onDragLeave(e: DragEvent): void;
  onDrop(e: DragEvent, agent: Agent): Promise<void>;
  closeMenus(): boolean;
  dispose(): void;
}

export interface Conversation extends ChatSurface {
  composer: ComposerSurface;
}
