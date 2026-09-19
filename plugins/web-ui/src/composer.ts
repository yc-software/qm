import { appEditSlug } from "./app-edit";
import { getRuntimeConfig, loadRuntimeConfig, saveRuntimeConfig, subscribeRuntimeConfig } from "./runtime-config-store";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { createFileDragState } from "./file-drag";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { FolderDropError, folderToZipFile, isFolderReadError, splitDropItems, type DropEntryLike } from "./folder-drop";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Plus,
  Sparkles,
  CornerDownRight,
  FileText,
  Paperclip,
  Square,
  Star,
  X,
  Zap,
} from "lucide";
import {
  api,
  ApiError,
  editQueuedRun,
  approvalBlocksComposer,
  MAX_ATTACHMENT_BYTES,
  MAX_FILES_PER_MESSAGE,
  mintSendKey,
  oversizeAttachmentNote,
  PENDING_APPROVAL_REASON,
  queueTurn,
  tooManyFilesNote,
  uploadAttachments,
  userSendMessage,
  withdrawRun,
  type ApprovalDecision,
  type CoreAttachment,
  type PendingApproval,
  type QueuedRun,
} from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { browserRenderableImage, fieldSelect, icon, modelMark } from "./ui";
import {
  EFFORT_LEVELS,
  defaultEffortForModel,
  defaultModelValue,
  effortLabel,
  getModelOptions,
  getHarnessOptions,
  harnessSupportsEffort,
  harnessSupportsFastMode,
  harnessSupportsSteer,
  type EffortLevel,
  type ModelOption,
  type ModelOptionValue,
} from "./model-options";
import { modelSupportsFastMode } from "./pi-models";
import type { ComposerSurface, ConvCtx } from "./conv-types";
import { bumpSessionActivity, dropPendingSession, renderList } from "./sessions";
import { appState } from "./shell";
import { base64ToText, bytesToBase64, insertIntoDraft, pasteChipLabel } from "./paste-text";
import { clearDraft, newChatDraftKey, saveDraft } from "./drafts";
import { tip } from "./tooltip";
import { isPhone } from "./viewport";
import {
  LOADOUT_CAP,
  parseLoadout,
  reconcileLoadout,
  upsertLoadout,
  reorderLoadout,
  effortLevelsForHarness,
  compatibleHarnessOptions,
  loadoutModelId,
  modelLoadoutOptions,
  type LoadoutEntry,
} from "./composer-loadout";

import { burstEffortConfetti } from "./effort-confetti";

export type ComposerMenu = "effort" | "model" | "settings" | "loadout";

const LEGACY_MODEL_STORAGE_KEY = "web-ui:model";
const THREAD_PICKS_STORAGE_KEY = "web-ui:model-picks";
const THREAD_PICKS_CAP = 50;
const LOADOUT_STORAGE_KEY = "web-ui:loadout";

function loadLoadout(): LoadoutEntry[] {
  try {
    return parseLoadout(localStorage.getItem(LOADOUT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function saveLoadout(entries: LoadoutEntry[]): void {
  persistPreference(LOADOUT_STORAGE_KEY, JSON.stringify(entries.slice(0, LOADOUT_CAP)));
}

function loadThreadPicks(): Map<string, ModelOptionValue> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(THREAD_PICKS_STORAGE_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      const pairs = raw.filter(
        (p): p is [string, string] => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string",
      );
      return new Map(pairs.slice(-THREAD_PICKS_CAP));
    }
  } catch {
    void 0;
  }
  return new Map();
}

let threadModelPicks = loadThreadPicks();
function runtimeScopeKey(scopeId: string | null): string | null {
  if (scopeId) return scopeId;
  const user = appState.me?.user;
  return user ? `personal:${user}` : null;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === THREAD_PICKS_STORAGE_KEY) threadModelPicks = loadThreadPicks();
  });
}

function rememberThreadPick(threadRef: string, value: ModelOptionValue): void {
  const merged = loadThreadPicks();
  for (const [ref, pick] of threadModelPicks) if (!merged.has(ref)) merged.set(ref, pick);
  merged.delete(threadRef);
  merged.set(threadRef, value);
  while (merged.size > THREAD_PICKS_CAP) merged.delete(merged.keys().next().value as string);
  threadModelPicks = merged;
  persistPreference(THREAD_PICKS_STORAGE_KEY, JSON.stringify([...merged]));
}

function forgetThreadPick(threadRef: string): void {
  threadModelPicks = loadThreadPicks();
  threadModelPicks.delete(threadRef);
  persistPreference(THREAD_PICKS_STORAGE_KEY, JSON.stringify([...threadModelPicks]));
}

export function carryModelPick(fromThreadRef: string | null, toThreadRef: string): void {
  const pick = fromThreadRef ? threadModelPicks.get(fromThreadRef) : undefined;
  if (pick) rememberThreadPick(toThreadRef, pick);
}

function modelOptionFor(value: ModelOptionValue, scopeKey?: string | null): ModelOption | undefined {
  return getModelOptions(scopeKey).find((option) => option.value === value);
}

function persistPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    void 0;
  }
}

export interface SkillItem {
  id?: string;
  name: string;
  description: string;
  body?: string;
  scope: string;
  shadowed?: boolean;
  editable?: boolean;
  scopeId?: string;
  status?: string;
  version?: number;
  source?: "native" | "pack";
  pack?: { packId: string; commit: string; upstreamName: string };
  assetCount?: number;
  requiredCapabilities?: string[];
  createdBy?: string;
  files?: Array<{ path: string; executable?: boolean }>;
}
interface SkillMatch {
  skill: SkillItem;
  start: number;
  end: number;
}

let skillsCache: SkillItem[] | null = null;

export function clearSkillsCache(): void {
  skillsCache = null;
}

const SLASH_TOKEN = /(^|\s)\/([a-zA-Z0-9_-]*)$/;

const EFFORT_PEAK_FLOOR = EFFORT_LEVELS.findIndex((option) => option.value === "xhigh");

function effortText(level: EffortLevel | string): TemplateResult | string {
  const label = effortLabel(level as EffortLevel);
  const rank = EFFORT_LEVELS.findIndex((option) => option.value === level);
  return rank >= EFFORT_PEAK_FLOOR ? html`<span class="effort-peak">${label}</span>` : label;
}

export function slashQuery(draft: string): string | null {
  const m = SLASH_TOKEN.exec(draft);
  return m ? (m[2] ?? "") : null;
}

export function resyncModelSelection(): void {
  try {
    localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
  } catch {
    void 0;
  }
}

export function createComposerSurface(ctx: ConvCtx): ComposerSurface {
  const refreshAccount = () => ctx.chat.drawActiveChat();
  window.addEventListener("model-account-changed", refreshAccount);
  const loadoutMenuId = `composer-loadout-${crypto.randomUUID()}`;
  let runtimeRequest = 0;
  let runtimeIdentity = "";
  let unsubscribeRuntime: (() => void) | undefined;
  let effortOverride: EffortLevel | undefined;
  let fastModeOverride: boolean | undefined;
  let restoredLoadout: LoadoutEntry | undefined;
  let loadoutRestored = false;
  let modelSelectionRevision = 0;
  let effortSelectionRevision = 0;
  let fastSelectionRevision = 0;

  function isUnsentNewChat(): boolean {
    return (
      ctx.chat.state.sessionId === null &&
      !(ctx.chat.state.agent?.state.messages ?? []).some((m) => !(m as { opener?: boolean }).opener)
    );
  }

  function persistDraft(): void {
    if (!ctx.chat.state.threadRef) return;
    saveDraft(ctx.chat.state.threadRef, composerState.draft);
    if (isUnsentNewChat()) saveDraft(newChatDraftKey(appState.me?.user), composerState.draft);
  }

  function clearActiveDraft(): void {
    if (ctx.chat.state.threadRef) clearDraft(ctx.chat.state.threadRef);
    if (ctx.chat.state.sessionId === null) clearDraft(newChatDraftKey(appState.me?.user));
  }

  const composerState = {
    draft: "",
    attachments: [] as Attachment[],
    error: "",
    processingFiles: false,
    dragging: false,
    openMenu: null as ComposerMenu | null,
    menuQuery: "",
    slashDismissed: false,
    get effortLevel(): EffortLevel {
      const selected = currentModelOption();
      const effort =
        effortOverride ??
        (restoredLoadout?.value === selected?.value ? restoredLoadout?.effort : undefined) ??
        (getRuntimeConfig(scopeKey())?.effective.effortLevel as EffortLevel | undefined) ??
        defaultEffortForModel(selected?.model);
      const levels = effortLevelsForHarness(selected?.harnessId ?? "");
      return levels.some((level) => level.value === effort) ? effort : "auto";
    },
    set effortLevel(value: EffortLevel) {
      ++effortSelectionRevision;
      effortOverride = value;
    },
    get fastMode(): boolean | undefined {
      const selected = currentModelOption();
      const fast =
        fastModeOverride ??
        (restoredLoadout?.value === selected?.value ? restoredLoadout?.fast : undefined) ??
        getRuntimeConfig(scopeKey())?.effective.fastMode === true;
      return (
        fast &&
        harnessSupportsFastMode(selected?.harnessId ?? "") &&
        modelSupportsFastMode(scopeKey(), selected?.model.id)
      );
    },
    set fastMode(value: boolean | undefined) {
      ++fastSelectionRevision;
      fastModeOverride = value;
    },
    pasteView: null as { id: string; text: string; initial: string; dirty: boolean } | null,
  };

  const pastedTextIds = new Set<string>();

  const queuedRuns = new Map<string, QueuedRun[]>();
  let queuedEdit: { runId: string; threadRef: string; original: string; text: string; saving: boolean } | null = null;

  function queuedRunsFor(threadRef: string | null): QueuedRun[] {
    return (threadRef ? queuedRuns.get(threadRef) : undefined) ?? [];
  }

  function setQueuedRuns(threadRef: string, runs: QueuedRun[]): void {
    if (runs.length) queuedRuns.set(threadRef, runs);
    else queuedRuns.delete(threadRef);
  }

  function forgetQueuedRun(threadRef: string, runId: string): void {
    setQueuedRuns(
      threadRef,
      queuedRunsFor(threadRef).filter((r) => r.runId !== runId),
    );
  }

  const fileDrag = createFileDragState((dragging) => {
    composerState.dragging = dragging;
    ctx.chat.drawActiveChat();
  });
  let skillsLoading = false;
  let slashActiveIndex = 0;
  function effectiveFastMode(): boolean {
    return composerState.fastMode === true;
  }

  function resetComposer(): void {
    composerState.draft = "";
    composerState.attachments = [];
    composerState.pasteView = null;
    pastedTextIds.clear();
    composerState.error = "";
    composerState.processingFiles = false;
    composerState.openMenu = null;
    slashActiveIndex = 0;
    composerState.slashDismissed = false;
  }

  function scopeKey(): string | null {
    return runtimeScopeKey(ctx.chat.state.scopeId);
  }

  function currentModelOption(): ModelOption | undefined {
    const picked = ctx.chat.state.threadRef ? threadModelPicks.get(ctx.chat.state.threadRef) : undefined;
    return modelOptionFor(picked ?? defaultModelValue(scopeKey()), scopeKey());
  }

  async function refreshRuntimeSelection(scopeId: string | null, agent?: Agent, refresh = false): Promise<void> {
    const request = ++runtimeRequest;
    const key = runtimeScopeKey(scopeId);
    const identity = `${key}:${ctx.chat.state.threadRef}`;
    const changedIdentity = identity !== runtimeIdentity;
    if (changedIdentity) {
      effortOverride = undefined;
      fastModeOverride = undefined;
      restoredLoadout = undefined;
      loadoutRestored = false;
      runtimeIdentity = identity;
    }
    unsubscribeRuntime?.();
    let defaults = getRuntimeConfig(key)?.effective;
    unsubscribeRuntime =
      key === null
        ? undefined
        : subscribeRuntimeConfig(key, () => {
            if (key !== scopeKey()) return;
            const next = getRuntimeConfig(key)?.effective;
            if (
              (["harnessId", "modelId", "effortLevel", "fastMode"] as const).some(
                (field) => defaults?.[field] !== next?.[field],
              )
            ) {
              restoredLoadout = undefined;
            }
            defaults = next;
            syncRuntimeSelection(ctx.chat.state.agent ?? undefined);
          });
    composerState.error = "";
    syncRuntimeSelection(agent);
    const config = key === null ? null : await loadRuntimeConfig(key, refresh);
    if (request !== runtimeRequest) return;
    if (!config) composerState.error = "Could not load runtime settings.";
    if (config && !loadoutRestored) {
      restoreLoadoutSelection();
      loadoutRestored = true;
    }
    syncRuntimeSelection(agent);
  }

  function restoreLoadoutSelection(): void {
    loadout = loadLoadout();
    let selected = currentModelOption();
    const threadRef = ctx.chat.state.threadRef;
    if (selected && threadRef && !threadModelPicks.has(threadRef)) {
      const preferred = modelLoadoutOptions(getModelOptions(scopeKey()), loadout, selected.harnessId).find(
        (option) => option.model.id === selected!.model.id,
      );
      if (preferred && preferred.value !== selected.value) {
        rememberThreadPick(threadRef, preferred.value);
        selected = preferred;
      }
    }
    if (!selected) return;
    const saved = loadout.find((entry) => entry.value === selected.value);
    if (!saved) return;
    const normalized = normalizeLoadoutEntry(saved, selected);
    if (threadRef && threadModelPicks.has(threadRef)) {
      effortOverride ??= normalized.effort;
      fastModeOverride ??= normalized.fast;
    } else {
      restoredLoadout = normalized;
    }
  }

  function syncRuntimeSelection(agent?: Agent): void {
    const selected = currentModelOption();
    if (agent && selected) agent.state.model = selected.model;
    ctx.chat.drawActiveChat(agent);
    if (pendingComposerFocus) focusComposerEnd();
  }

  async function changeScopeRuntime(
    change: {
      harnessId?: string;
      modelId?: string;
      effortLevel?: string;
      fastMode?: boolean;
      inherit?: boolean;
      keep?: boolean;
    },
    agent: Agent,
    preserveSelection = false,
  ): Promise<void> {
    const request = ++runtimeRequest;
    const scopeId = scopeKey();
    if (!scopeId) return;
    composerState.error = "";
    const current = preserveSelection ? currentModelOption() : undefined;
    const settings = current ? activeLoadoutEntry(current) : undefined;
    const modelRevision = modelSelectionRevision;
    const effortRevision = effortSelectionRevision;
    const fastRevision = fastSelectionRevision;
    try {
      await saveRuntimeConfig(scopeId, change);
      if (request !== runtimeRequest || scopeId !== scopeKey()) return;
      if (modelSelectionRevision === modelRevision) {
        if (current && settings) {
          if (effortSelectionRevision === effortRevision) effortOverride = settings.effort;
          if (fastSelectionRevision === fastRevision) fastModeOverride = settings.fast;
          if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, current.value);
          rememberActiveTweaks(current);
        } else if (
          !change.keep &&
          effortSelectionRevision === effortRevision &&
          fastSelectionRevision === fastRevision
        ) {
          if (ctx.chat.state.threadRef) forgetThreadPick(ctx.chat.state.threadRef);
          effortOverride = undefined;
          fastModeOverride = undefined;
          restoredLoadout = undefined;
        }
      }
      syncRuntimeSelection(agent);
      placeLoadout();
    } catch (e) {
      if (request !== runtimeRequest || scopeId !== scopeKey()) return;
      composerState.error = errMessage(e, "Could not update the scope default.");
      ctx.chat.drawActiveChat(agent);
    }
  }

  function stagedAttachment(attachment: Attachment, agent: Agent): TemplateResult {
    const remove = (showTooltip: boolean) => html`
      <button
        type="button"
        class="chip-x"
        aria-label="Remove attachment"
        ${showTooltip ? tip("Remove") : nothing}
        @click=${() => removeAttachment(attachment.id, agent)}
      >
        ${icon(X, 13)}
      </button>
    `;
    if (browserRenderableImage(attachment.mimeType) && attachment.preview?.startsWith("data:image/")) {
      return html`<span class="image-preview"
        ><img src=${attachment.preview} alt=${attachment.fileName} />${remove(false)}</span
      >`;
    }
    if (pastedTextIds.has(attachment.id)) {
      return html`<span class="file-chip">
        <button
          type="button"
          class="chip-open"
          aria-label="View pasted text"
          ${tip("View pasted text")}
          @click=${() => openPasteView(attachment.id, agent)}
        >
          ${icon(FileText, 14)}
          <span>${pasteChipLabel(attachment.extractedText?.length ?? 0)}</span>
        </button>
        ${remove(true)}
      </span>`;
    }
    return html`<span class="file-chip">
      ${icon(Paperclip, 14)}<span dir="auto">${attachment.fileName}</span>${remove(true)}
    </span>`;
  }

  function composerForm(agent: Agent, header: TemplateResult | typeof nothing = nothing): TemplateResult {
    const activeRuntimeConfig = getRuntimeConfig(scopeKey());
    const selectedModel = currentModelOption();
    if (!selectedModel) {
      const selected =
        (ctx.chat.state.threadRef ? threadModelPicks.get(ctx.chat.state.threadRef) : undefined) ??
        defaultModelValue(scopeKey());
      return html`<div class="composer-wrap">
        ${header} ${composerApprovalPanel(ctx.chat.activePendingApprovals())}
        <p role="status">
          ${composerState.error || activeRuntimeConfig?.unavailableReason || "Selected model is unavailable. Choose a replacement to continue."}
          ${selected}
        </p>
        <label
          >Replacement model
          ${fieldSelect({
            ariaLabel: "Replacement model",
            value: "",
            options: html`<option value="" selected>Select a model…</option>
              ${getModelOptions(scopeKey()).map((option) => html`<option value=${option.value}>${option.harnessLabel} · ${option.label}</option>`)}`,
            onChange: async (value) => {
              const option = modelOptionFor(value, scopeKey());
              if (!option) return;
              await changeScopeRuntime({ harnessId: option.harnessId, modelId: option.model.id }, agent);
              if (
                getRuntimeConfig(scopeKey())?.effective.harnessId === option.harnessId &&
                getRuntimeConfig(scopeKey())?.effective.modelId === option.model.id
              )
                selectModel(value, agent);
            },
          })}
        </label>
        <button type="button" @click=${() => void refreshRuntimeSelection(ctx.chat.state.scopeId, agent, true)}>
          Refresh models
        </button>
      </div>`;
    }
    const approvalPauses = ctx.chat.activePendingApprovals();
    const blockingPauses = approvalPauses.filter(approvalBlocksComposer);
    const runtimePending = activeRuntimeConfig === null;
    const inputBlocked = runtimePending || ctx.chat.state.resolvingApprovals.size > 0 || blockingPauses.length > 0;
    const attachingDisabled = inputBlocked;
    let placeholder = appEditSlug(ctx.chat.state.threadRef, appState.me?.user) ? "Describe a change…" : "Ask anything";
    if (inputBlocked) placeholder = runtimePending ? "Loading runtime…" : "Approve or deny to continue";
    else if (agent.state.isStreaming) placeholder = "Queue a message for after this turn…";
    let composerNotice: TemplateResult | typeof nothing = nothing;
    if (composerState.processingFiles) {
      composerNotice = html`<div class="composer-note">Preparing files...</div>`;
    } else if (!approvalPauses.length && runtimePending) {
      composerNotice = composerState.error
        ? html`<div class="composer-error">
            ${composerState.error}
            <button type="button" @click=${() => void refreshRuntimeSelection(ctx.chat.state.scopeId, agent, true)}>
              Retry
            </button>
          </div>`
        : html`<div class="composer-note">Loading runtime settings…</div>`;
    } else if (composerState.error) {
      composerNotice = html`<div class="composer-error">${composerState.error}</div>`;
    }

    const compact = Boolean(ctx.pane) || isPhone();
    const showRuntimeControls = !appState.me?.individualModelAuth;
    const runtimeControls = loadoutControl(agent, selectedModel, inputBlocked);
    return html`
      <form
        class="composer-wrap ${compact ? "compact" : ""}"
        @submit=${(e: Event) => submitComposer(e, agent)}
        @keydown=${(e: KeyboardEvent) => composerShortcut(e, agent, inputBlocked)}
      >
        ${header} ${slashMenu(agent)}
        ${
          activeRuntimeConfig?.upgradeAvailable
            ? html`<div class="runtime-upgrade">
                <span
                  >The org now recommends
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`, scopeKey())?.harnessLabel ?? activeRuntimeConfig.orgDefault.harnessId}
                  ·
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`, scopeKey())?.buttonLabel ?? activeRuntimeConfig.orgDefault.modelId}.</span
                >
                <button
                  type="button"
                  @click=${() => changeScopeRuntime({ harnessId: activeRuntimeConfig!.orgDefault.harnessId, modelId: activeRuntimeConfig!.orgDefault.modelId }, agent)}
                >
                  Upgrade
                </button>
                <button type="button" @click=${() => changeScopeRuntime({ keep: true }, agent)}>Keep mine</button>
                <button type="button" @click=${() => changeScopeRuntime({ inherit: true }, agent)}>
                  Inherit future defaults
                </button>
              </div>`
            : nothing
        }
        ${
          composerState.attachments.length
            ? html`
                <div class="attachment-strip">
                  ${composerState.attachments.map((attachment) => stagedAttachment(attachment, agent))}
                </div>
              `
            : nothing
        }
        ${approvalPauses.length ? composerApprovalPanel(approvalPauses) : nothing}
        ${
          blockingPauses.length
            ? nothing
            : html`
                <textarea
                  class="composer-input"
                  dir="auto"
                  rows="1"
                  placeholder=${placeholder}
                  ?disabled=${inputBlocked}
                  .value=${live(composerState.draft)}
                  @input=${(e: InputEvent) => onDraftInput(e, agent)}
                  @keydown=${(e: KeyboardEvent) => onComposerKeydown(e, agent)}
                  @paste=${(e: ClipboardEvent) => void onComposerPaste(e, agent)}
                ></textarea>
              `
        }
        <div class="composer-toolbar">
          <div class="composer-left">
            <input
              class="file-input"
              type="file"
              multiple
              hidden
              ?disabled=${attachingDisabled}
              @change=${(e: Event) => void onFilesSelected(e, agent)}
            />
            <button
              class="icon-btn composer-attach"
              type="button"
              aria-label="Attach files"
              ${tip("Attach files")}
              ?disabled=${attachingDisabled}
              @click=${() => pickFiles()}
            >
              ${icon(Paperclip, 18)}
            </button>
            ${showRuntimeControls ? runtimeControls : nothing}
          </div>
          <div class="composer-right">${sendControls(agent)}</div>
        </div>
        ${composerNotice}
      </form>
      ${pasteViewDialog(agent)}
    `;
  }

  function pasteViewDialog(agent: Agent): TemplateResult | typeof nothing {
    const view = composerState.pasteView;
    if (!view) return nothing;
    return html`
      <div
        class="project-dialog-backdrop"
        @click=${(e: MouseEvent) => e.target === e.currentTarget && closePasteView(agent)}
        @keydown=${(e: KeyboardEvent) => e.key === "Escape" && closePasteView(agent)}
      >
        <div class="project-dialog paste-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-dialog-title">
          <div class="project-dialog-head">
            <div><h2 id="paste-dialog-title">Pasted text</h2></div>
            <button
              class="chip-x"
              type="button"
              aria-label="Close"
              ${tip("Close")}
              @click=${() => closePasteView(agent)}
            >
              ${icon(X, 16)}
            </button>
          </div>
          <textarea
            class="paste-dialog-text"
            dir="auto"
            @input=${(e: InputEvent) => {
              view.text = (e.currentTarget as HTMLTextAreaElement).value;
              view.dirty = true;
            }}
          >
  ${view.initial}</textarea>
          <div class="project-dialog-actions">
            <button class="btn" type="button" @click=${() => removeAttachment(view.id, agent)}>Remove</button>
            <button class="btn" type="button" @click=${() => insertPasteIntoDraft(agent)}>Insert into message</button>
            <button class="btn primary" type="button" @click=${() => closePasteView(agent)}>Done</button>
          </div>
        </div>
      </div>
    `;
  }

  function openPasteView(id: string, agent: Agent): void {
    const attachment = composerState.attachments.find((a) => a.id === id);
    if (!attachment) return;
    const text = attachment.extractedText ?? base64ToText(attachment.content);
    composerState.pasteView = { id, text, initial: text, dirty: false };
    ctx.chat.drawActiveChat(agent);
    requestAnimationFrame(() => ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".paste-dialog-text")?.focus());
  }

  function closePasteView(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const attachment = composerState.attachments.find((a) => a.id === view.id);
    if (attachment && view.dirty) {
      const bytes = new TextEncoder().encode(view.text);
      attachment.content = bytesToBase64(bytes);
      attachment.size = bytes.length;
      attachment.extractedText = view.text;
    }
    composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  function insertPasteIntoDraft(agent: Agent): void {
    const view = composerState.pasteView;
    if (!view) return;
    const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
    const { draft, cursor } = insertIntoDraft(composerState.draft, view.text, ta ? ta.selectionStart : null);
    composerState.draft = draft;
    persistDraft();
    composerState.pasteView = null;
    removeAttachment(view.id, agent);
    resizeComposer();
    requestAnimationFrame(() => {
      const input = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!input) return;
      input.focus();
      input.setSelectionRange(cursor, cursor);
    });
  }

  function sendControls(agent: Agent): TemplateResult {
    if (!agent.state.isStreaming) {
      return html`<button
        class="send-btn"
        type="submit"
        aria-label="Send"
        ${tip("Send")}
        ?disabled=${!composerCanSend()}
      >
        ${icon(ArrowUp, 16)}
      </button>`;
    }
    return html`
      <button
        class="stop-btn"
        type="button"
        aria-label="Stop"
        ${tip("Stop")}
        ?disabled=${ctx.chat.isStopping()}
        @click=${() => stopStreaming(agent)}
      >
        ${icon(Square, 16)}
      </button>
      <button
        class="send-btn"
        type="submit"
        ${tip("Queue for after this turn")}
        aria-label="Queue for after this turn"
        ?disabled=${!composerCanSend()}
      >
        ${icon(ArrowUp, 16)}
      </button>
    `;
  }

  function queuedStrip(agent: Agent): TemplateResult | typeof nothing {
    const queued = [...queuedRunsFor(ctx.chat.state.threadRef)];
    if (queuedEdit?.threadRef === ctx.chat.state.threadRef && !queued.some((q) => q.runId === queuedEdit?.runId))
      queued.push({ runId: queuedEdit.runId, text: queuedEdit.original });
    if (!queued.length) return nothing;
    const steerable =
      agent.state.isStreaming && ctx.chat.hasLiveRun() && harnessSupportsSteer(currentModelOption()?.harnessId ?? "");
    const steerTip = (): string => {
      if (steerable) return "Steer the running task with this instead of waiting";
      return "Nothing running can take this. It will go out as its own turn";
    };
    return html`
      <div class="queued-strip" role="list" aria-label="Queued messages">
        ${queued.map((q) =>
          queuedEdit?.runId === q.runId && queuedEdit.threadRef === ctx.chat.state.threadRef
            ? html` <div class="queued-chip queued-editing" role="listitem">
                <textarea
                  class="queued-edit-input"
                  aria-label="Edit queued message"
                  rows="3"
                  .value=${live(queuedEdit.text)}
                  ?disabled=${queuedEdit.saving}
                  @input=${(event: Event) => {
                    if (queuedEdit) queuedEdit.text = (event.target as HTMLTextAreaElement).value;
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.isComposing || queuedEdit?.saving) return;
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelQueuedEdit(agent);
                    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      event.stopPropagation();
                      void saveQueuedEdit(agent);
                    }
                  }}
                ></textarea>
                <button
                  type="button"
                  class="queued-steer"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  ?disabled=${queuedEdit.saving}
                  @click=${() => void saveQueuedEdit(agent)}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="queued-steer"
                  ?disabled=${queuedEdit.saving}
                  @click=${() => cancelQueuedEdit(agent)}
                >
                  Cancel
                </button>
              </div>`
            : html`
                <div class="queued-chip" role="listitem">
                  <span class="queued-tag">Queued</span>
                  <span class="queued-text" dir="auto" ${tip(q.text || "Files, no text")}
                    >${q.text || (q.hasAttachments ? "(files)" : "")}</span
                  >
                  <button
                    type="button"
                    class="queued-steer"
                    ?disabled=${!steerable}
                    ${tip(steerTip())}
                    @click=${() => void steerQueued(agent, q)}
                  >
                    ${icon(CornerDownRight, 13)}<span>Steer</span>
                  </button>
                  <button
                    type="button"
                    class="queued-steer"
                    aria-label="Edit queued message"
                    @click=${() => {
                      const edit = (queuedEdit = {
                        runId: q.runId,
                        threadRef: ctx.chat.state.threadRef!,
                        original: q.text,
                        text: q.text,
                        saving: false,
                      });
                      ctx.chat.drawActiveChat(agent);
                      requestAnimationFrame(() => {
                        if (
                          queuedEdit !== edit ||
                          ctx.chat.state.threadRef !== edit.threadRef ||
                          ctx.chat.state.agent !== agent
                        )
                          return;
                        const input = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".queued-edit-input");
                        input?.focus();
                        input?.setSelectionRange(input.value.length, input.value.length);
                      });
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class="chip-x"
                    aria-label="Remove queued message"
                    ${tip("Remove")}
                    @click=${() => void removeQueued(agent, q)}
                  >
                    ${icon(X, 13)}
                  </button>
                </div>
              `,
        )}
      </div>
    `;
  }

  function composerApprovalPanel(approvals: PendingApproval[]): TemplateResult {
    const decide = (decision: ApprovalDecision): void => {
      if (!ctx.chat.state.resolvingApprovals.has(decision.requestId)) ctx.chat.resolveCommandApproval(decision);
    };
    return html`<div class="composer-approval-panel" role="group" aria-label="Command approval">
      ${approvals.map(
        (a) =>
          html`<div class="composer-approval">
            <div class="composer-approval-copy">${ctx.chat.approvalSummaryView(a, true)}</div>
            <div class="approval-actions">
              <button
                class="approval-btn deny"
                type="button"
                ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                @click=${() => decide({ requestId: a.requestId, approved: false })}
              >
                Deny
              </button>
              <button
                class="approval-btn"
                type="button"
                ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                @click=${() => decide({ requestId: a.requestId, approved: true, scope: "once" })}
              >
                Allow once
              </button>
              ${
                a.grantModes?.session === false
                  ? nothing
                  : html`<button
                      class="approval-btn primary"
                      type="button"
                      ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                      @click=${() => decide({ requestId: a.requestId, approved: true, scope: "session" })}
                    >
                      Allow for session
                    </button>`
              }
              ${
                a.grantModes?.always === false
                  ? nothing
                  : html`<button
                      class="approval-btn"
                      type="button"
                      ?disabled=${ctx.chat.state.resolvingApprovals.has(a.requestId)}
                      @click=${() => decide({ requestId: a.requestId, approved: true, scope: "always" })}
                    >
                      Allow always
                    </button>`
              }
            </div>
          </div>`,
      )}
    </div>`;
  }

  let loadout = loadLoadout();
  let loadoutSection: "effort" | "add" | "harness" | null = null;
  let loadoutSectionHovered = false;
  let loadoutCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let draggedModel: string | null = null;

  function activeLoadoutEntry(selected: ModelOption): LoadoutEntry {
    return {
      value: selected.value,
      effort: composerState.effortLevel,
      fast:
        harnessSupportsFastMode(selected.harnessId) &&
        modelSupportsFastMode(scopeKey(), selected.model.id) &&
        effectiveFastMode(),
    };
  }

  function normalizeLoadoutEntry(entry: LoadoutEntry, option: ModelOption): LoadoutEntry {
    const levels = effortLevelsForHarness(option.harnessId);
    const defaultEffort = defaultEffortForModel(option.model);
    const fallbackEffort = levels.some((level) => level.value === defaultEffort) ? defaultEffort : "auto";
    return {
      value: option.value,
      effort: levels.some((level) => level.value === entry.effort) ? entry.effort : fallbackEffort,
      fast:
        entry.fast && harnessSupportsFastMode(option.harnessId) && modelSupportsFastMode(scopeKey(), option.model.id),
    };
  }

  function seededLoadout(selected: ModelOption): LoadoutEntry[] {
    const latest = loadLoadout();
    if (latest.length) loadout = latest;
    const active = activeLoadoutEntry(selected);
    if (!loadout.length) {
      loadout = [active];
      const other = getModelOptions(scopeKey()).find(
        (option) => option.model.id !== selected.model.id && option.model.provider !== selected.model.provider,
      );
      if (other) loadout.push({ value: other.value, effort: defaultEffortForModel(other.model), fast: false });
    }
    return reconcileLoadout(loadout, getModelOptions(scopeKey()), active).map((entry) =>
      normalizeLoadoutEntry(entry, modelOptionFor(entry.value, scopeKey())!),
    );
  }

  function rememberActiveTweaks(selected: ModelOption): void {
    loadout = upsertLoadout(seededLoadout(selected), activeLoadoutEntry(selected));
    saveLoadout(loadout);
  }

  function applyLoadout(entry: LoadoutEntry, agent: Agent): void {
    const option = modelOptionFor(entry.value, scopeKey());
    if (!option) return;
    const previous = currentModelOption();
    if (previous) rememberActiveTweaks(previous);
    const wasOpen = composerState.openMenu === "loadout";
    selectModel(entry.value, agent);
    const normalized = normalizeLoadoutEntry(entry, option);
    composerState.effortLevel = normalized.effort;
    composerState.fastMode = normalized.fast;
    loadout = upsertLoadout(loadout, activeLoadoutEntry(option));
    saveLoadout(loadout);
    loadoutSection = null;
    composerState.openMenu = wasOpen ? "loadout" : null;
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  function composerShortcut(e: KeyboardEvent, agent: Agent, disabled: boolean): void {
    if (disabled || e.defaultPrevented || !e.metaKey) return;
    if (e.shiftKey && e.code === "KeyE") {
      e.preventDefault();
      toggleFastMode(agent);
    }
  }

  function addLoadoutEntry(option: ModelOption, agent: Agent): void {
    const current = currentModelOption();
    if (!current || seededLoadout(current).length >= LOADOUT_CAP) return;
    applyLoadout({ value: option.value, effort: defaultEffortForModel(option.model), fast: false }, agent);
    composerState.menuQuery = "";
  }

  function removeLoadoutEntry(value: string, selected: ModelOption): void {
    if (value === selected.value) return;
    const entries = seededLoadout(selected);
    const index = entries.findIndex((entry) => entry.value === value);
    loadout = entries.filter((entry) => entry.value !== value);
    saveLoadout(loadout);
    ctx.chat.drawActiveChat();
    placeLoadout();
    requestAnimationFrame(() => {
      const rows = ctx.chat.state.host?.querySelectorAll<HTMLButtonElement>(".loadout-pick");
      rows?.[Math.max(0, Math.min(index, loadout.length - 1))]?.focus();
    });
  }

  function clearLoadoutDropTargets(): void {
    ctx.chat.state.host?.querySelectorAll(".loadout-row.drop-target").forEach((row) => {
      row.classList.remove("drop-target", "drop-after");
    });
  }

  function moveLoadout(value: string, targetValue: string, selected: ModelOption): void {
    loadout = reorderLoadout(seededLoadout(selected), value, targetValue);
    saveLoadout(loadout);
    ctx.chat.drawActiveChat();
    placeLoadout();
  }

  function modelGlyph(option: ModelOption): TemplateResult {
    const provider = option.displayProvider ?? String(option.model.provider);
    const mark =
      option.harnessId === "codex"
        ? modelMark("codex", 16)
        : (modelMark(provider, 16) ?? modelMark(option.harnessId, 16));
    return html`<span class="loadout-icon" data-provider=${provider} aria-hidden="true"
      >${mark ?? icon(Sparkles, 16)}</span
    >`;
  }

  function loadoutRow(
    entry: LoadoutEntry,
    at: number,
    selected: ModelOption,
    agent: Agent,
  ): TemplateResult | typeof nothing {
    const option = modelOptionFor(entry.value, scopeKey());
    if (!option) return nothing;
    const active = entry.value === selected.value;
    const settings = active ? activeLoadoutEntry(selected) : entry;
    const isDefault = entry.value === defaultModelValue(scopeKey());
    const activeRuntimeConfig = getRuntimeConfig(scopeKey());
    const canMakeDefault =
      activeRuntimeConfig !== null &&
      (!isDefault ||
        settings.effort !== (activeRuntimeConfig.effective.effortLevel ?? defaultEffortForModel(option.model)) ||
        settings.fast !== (activeRuntimeConfig.effective.fastMode === true));
    return html` <div
      class="loadout-row ${active ? "active" : ""} ${canMakeDefault || isDefault ? "has-default-action" : ""}"
      @dragover=${(e: DragEvent) => {
        if (!draggedModel || draggedModel === entry.value) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        clearLoadoutDropTargets();
        const row = e.currentTarget as HTMLElement;
        row.classList.add("drop-target");
        row.classList.toggle(
          "drop-after",
          seededLoadout(selected).findIndex((item) => item.value === draggedModel) < at,
        );
      }}
      @dragleave=${(e: DragEvent) => {
        const row = e.currentTarget as HTMLElement;
        if (!(e.relatedTarget instanceof Node) || !row.contains(e.relatedTarget)) {
          row.classList.remove("drop-target", "drop-after");
        }
      }}
      @drop=${(e: DragEvent) => {
        if (!draggedModel) return;
        e.preventDefault();
        e.stopPropagation();
        clearLoadoutDropTargets();
        moveLoadout(draggedModel, entry.value, selected);
        draggedModel = null;
      }}
    >
      <button
        type="button"
        class="loadout-drag"
        draggable="true"
        aria-label=${`Reorder ${option.label}; use Up or Down`}
        @dragstart=${(e: DragEvent) => {
          e.stopPropagation();
          draggedModel = entry.value;
          e.dataTransfer?.setData("text/plain", entry.value);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          (e.currentTarget as HTMLElement).closest(".loadout-row")?.classList.add("dragging");
        }}
        @dragend=${(e: DragEvent) => {
          draggedModel = null;
          clearLoadoutDropTargets();
          (e.currentTarget as HTMLElement).closest(".loadout-row")?.classList.remove("dragging");
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          e.stopPropagation();
          const next = seededLoadout(selected)[at + (e.key === "ArrowUp" ? -1 : 1)];
          if (next) {
            moveLoadout(entry.value, next.value, selected);
            requestAnimationFrame(() => {
              const handles = ctx.chat.state.host?.querySelectorAll<HTMLButtonElement>(".loadout-drag");
              handles?.[at + (e.key === "ArrowUp" ? -1 : 1)]?.focus();
            });
          }
        }}
      >
        ${icon(GripVertical, 13)}
      </button>
      <button
        class="loadout-pick"
        type="button"
        role="menuitemradio"
        aria-checked=${active ? "true" : "false"}
        @click=${(event: MouseEvent) => {
          burstEffortConfetti(event, settings.effort, option.harnessId);
          applyLoadout(entry, agent);
        }}
      >
        ${modelGlyph(option)}
        <span class="loadout-model-copy">
          <span class="loadout-title">
            <span class="loadout-name">${option.label}</span>
            ${isDefault ? html`<span class="loadout-default">my default</span>` : nothing}
          </span>
          <span class="loadout-details">
            <span class="loadout-harness">${option.harnessLabel}</span>
            <span>${effortText(settings.effort)}</span>
            ${settings.fast ? html`<span class="loadout-bolt" aria-label="Fast">${icon(Zap, 10)}</span>` : nothing}
          </span>
        </span>
        <span class="loadout-end">${active ? icon(Check, 15) : nothing}</span>
      </button>
      ${
        canMakeDefault
          ? html`<button
              class="loadout-make-default"
              data-default=${isDefault ? "true" : "false"}
              type="button"
              role="menuitem"
              aria-label=${`Make ${option.label} default`}
              ${tip("Make default")}
              @click=${async (event: MouseEvent) => {
                const row = (event.currentTarget as HTMLElement).closest(".loadout-row");
                await changeScopeRuntime(
                  {
                    harnessId: option.harnessId,
                    modelId: option.model.id,
                    effortLevel: settings.effort,
                    fastMode: settings.fast,
                  },
                  agent,
                  true,
                );
                row?.querySelector<HTMLElement>(".loadout-pick")?.focus();
                placeLoadout();
              }}
            >
              ${icon(Star, 14)}
            </button>`
          : nothing
      }
      ${isDefault && !canMakeDefault ? html`<span class="loadout-default-star" role="img" aria-label="My default" ${tip("My default")}>${icon(Star, 14)}</span>` : nothing}
      ${
        !active
          ? html`<button
              class="loadout-remove"
              type="button"
              aria-label=${`Remove ${option.label} from presets`}
              ${tip("Remove from presets")}
              @click=${() => removeLoadoutEntry(entry.value, selected)}
            >
              ${icon(X, 14)}
            </button>`
          : nothing
      }
    </div>`;
  }

  function cancelLoadoutClose(): void {
    if (loadoutCloseTimer === null) return;
    clearTimeout(loadoutCloseTimer);
    loadoutCloseTimer = null;
  }

  function loadoutSubmenuHasFocus(): boolean {
    return ctx.chat.state.host?.querySelector<HTMLElement>(".loadout-submenu")?.matches(":focus-within") === true;
  }

  function queueLoadoutClose(): void {
    if (isPhone() || !loadoutSectionHovered || !loadoutSection || loadoutSubmenuHasFocus()) return;
    const section = loadoutSection;
    cancelLoadoutClose();
    loadoutCloseTimer = setTimeout(() => {
      loadoutCloseTimer = null;
      if (loadoutSection === section && !loadoutSubmenuHasFocus()) closeLoadoutSection(false);
    }, 140);
  }

  function trackLoadoutHover(e: MouseEvent): void {
    if (isPhone() || !loadoutSection) return;
    const target = e.target as HTMLElement;
    if (target.closest(".loadout-submenu") || target.closest(`[data-loadout-section="${loadoutSection}"]`))
      cancelLoadoutClose();
    else queueLoadoutClose();
  }

  function openLoadoutSection(section: "effort" | "add" | "harness", keyboard = false): void {
    cancelLoadoutClose();
    if (loadoutSection === section && !keyboard) return;
    loadoutSection = section;
    ctx.chat.drawActiveChat();
    placeLoadout();
    if (keyboard)
      requestAnimationFrame(() => {
        const menu = ctx.chat.state.host?.querySelector<HTMLElement>(".loadout-submenu");
        const target =
          menu?.querySelector<HTMLElement>('input, [aria-checked="true"]') ??
          [...(menu?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])].find(
            (button) => button.offsetParent !== null,
          );
        target?.focus();
      });
  }

  function closeLoadoutSection(refocus = true): void {
    cancelLoadoutClose();
    const previous = loadoutSection;
    loadoutSection = null;
    loadoutSectionHovered = false;
    ctx.chat.drawActiveChat();
    placeLoadout();
    if (previous && refocus)
      requestAnimationFrame(() =>
        ctx.chat.state.host?.querySelector<HTMLElement>(`[data-loadout-section="${previous}"]`)?.focus(),
      );
  }

  function loadoutSubmenu(agent: Agent, selected: ModelOption): TemplateResult | typeof nothing {
    if (!loadoutSection) return nothing;
    const effort = loadoutSection === "effort";
    const entries = seededLoadout(selected);
    const query = composerState.menuQuery.trim().toLocaleLowerCase();
    const catalog = modelLoadoutOptions(getModelOptions(scopeKey()), entries, selected.harnessId).filter(
      (option) =>
        !entries.some((entry) => loadoutModelId(entry.value) === option.model.id) &&
        (!query || `${option.harnessLabel} ${option.label}`.toLocaleLowerCase().includes(query)),
    );
    return html`<div
      class="loadout-submenu"
      role="menu"
      aria-label=${{ effort: "Effort levels", harness: "Run with", add: "Add models" }[loadoutSection]}
      @mouseenter=${() => cancelLoadoutClose()}
      @mouseleave=${() => queueLoadoutClose()}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "ArrowLeft" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeLoadoutSection();
        } else menuArrowKeys(e);
      }}
    >
      <button class="loadout-back" type="button" @click=${() => closeLoadoutSection()}>
        ${icon(ChevronDown, 13)} Back
      </button>
      ${
        effort
          ? effortLevelsForHarness(selected.harnessId).map(
              (level) =>
                html` <button
                  class="loadout-effort"
                  type="button"
                  role="menuitemradio"
                  aria-checked=${composerState.effortLevel === level.value ? "true" : "false"}
                  @click=${(event: MouseEvent) => {
                    burstEffortConfetti(event, level.value, selected.harnessId);
                    selectEffort(level.value, agent);
                    closeLoadoutSection();
                  }}
                >
                  <span>${effortText(level.value)}</span
                  >${composerState.effortLevel === level.value ? icon(Check, 15) : nothing}
                </button>`,
            )
          : nothing
      }
      ${
        loadoutSection === "harness"
          ? getHarnessOptions(scopeKey()).map((harness) => {
              const compatible = compatibleHarnessOptions(getModelOptions(scopeKey()), selected.model.id).some(
                (option) => option.harnessId === harness.value,
              );
              const reason = compatible ? "" : `${harness.label} cannot run ${selected.label}.`;
              return html`<button
                class="loadout-effort"
                type="button"
                role="menuitemradio"
                aria-checked=${harness.value === selected.harnessId ? "true" : "false"}
                aria-disabled=${compatible ? "false" : "true"}
                aria-description=${reason || nothing}
                ${tip(reason)}
                @click=${() => {
                  if (!compatible) return;
                  closeLoadoutSection();
                  selectHarness(harness.value, agent);
                }}
              >
                <span class="loadout-harness-option"
                  >${modelMark(harness.value, 15) ?? nothing}<span>${harness.label}</span></span
                >
                ${harness.value === selected.harnessId ? icon(Check, 15) : nothing}
              </button>`;
            })
          : nothing
      }
      ${
        loadoutSection === "add"
          ? html` <label class="loadout-search"
                ><span class="sr-only">Search models</span>
                <input
                  type="search"
                  placeholder="Search models…"
                  .value=${live(composerState.menuQuery)}
                  @input=${(e: InputEvent) => {
                    composerState.menuQuery = (e.currentTarget as HTMLInputElement).value;
                    ctx.chat.drawActiveChat();
                    placeLoadout();
                  }}
                />
              </label>
              ${catalog.map(
                (option) =>
                  html`<button
                    class="menu-option"
                    type="button"
                    role="menuitem"
                    aria-label=${`Add ${option.label} to presets`}
                    @click=${() => addLoadoutEntry(option, agent)}
                  >
                    ${modelGlyph(option)}<span class="menu-option-copy"
                      ><span>${option.label}</span><span class="loadout-meta">${option.harnessLabel}</span></span
                    ><span class="loadout-add-label" aria-hidden="true">Add</span>
                  </button>`,
              )}
              ${catalog.length ? nothing : html`<div class="loadout-empty">No models found</div>`}`
          : nothing
      }
    </div>`;
  }

  function loadoutHarnessControl(selected: ModelOption): TemplateResult {
    const options = getHarnessOptions(scopeKey());
    const value = html`<span class="loadout-harness-option"
      >${modelMark(selected.harnessId, 15) ?? nothing}<span>${selected.harnessLabel}</span></span
    >`;
    if (options.length < 2)
      return html`<div class="loadout-setting loadout-setting-static">
        <span class="loadout-setting-label">Run with</span><span class="loadout-setting-value">${value}</span>
      </div>`;
    return html`<div class="loadout-submenu-anchor">
      <button
        class="loadout-setting ${loadoutSection === "harness" ? "open" : ""}"
        type="button"
        role="menuitem"
        data-loadout-section="harness"
        aria-haspopup="menu"
        aria-expanded=${loadoutSection === "harness" ? "true" : "false"}
        @mouseenter=${() => {
          if (isPhone()) return;
          loadoutSectionHovered = true;
          openLoadoutSection("harness");
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            loadoutSectionHovered = false;
            openLoadoutSection("harness", true);
          }
        }}
        @click=${(e: MouseEvent) => {
          loadoutSectionHovered = e.detail !== 0 && !isPhone();
          openLoadoutSection("harness", e.detail === 0);
        }}
      >
        <span class="loadout-setting-label">Run with</span>
        <span class="loadout-setting-value">${value}<span class="loadout-end">${icon(ChevronRight, 14)}</span></span>
      </button>
    </div>`;
  }

  function loadoutControl(agent: Agent, selected: ModelOption, disabled: boolean): TemplateResult {
    const open = composerState.openMenu === "loadout";
    const entries = seededLoadout(selected);
    const modelSupportsFast = modelSupportsFastMode(scopeKey(), selected.model.id);
    const fastAvailable = harnessSupportsFastMode(selected.harnessId) && modelSupportsFast;
    const fastUnsupportedReason = modelSupportsFast ? "Not supported by this harness" : "Not supported by this model";
    const fastOn = fastAvailable && effectiveFastMode();
    return html`<div class="menu-control loadout-control" data-align="left">
      <button
        class="menu-button loadout-button"
        type="button"
        aria-label=${`Model: ${selected.label}, ${effortLabel(composerState.effortLevel)} effort${fastOn ? ", Fast" : ""}`}
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        aria-controls=${loadoutMenuId}
        ?disabled=${disabled}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            cancelLoadoutClose();
            loadoutSection = null;
            loadoutSectionHovered = false;
            composerState.openMenu = "loadout";
            ctx.chat.drawActiveChat();
            placeLoadout();
            requestAnimationFrame(() => ctx.chat.state.host?.querySelector<HTMLElement>(".loadout-pick")?.focus());
          }
        }}
        @click=${(e: Event) => {
          e.stopPropagation();
          cancelLoadoutClose();
          loadoutSection = null;
          loadoutSectionHovered = false;
          composerState.menuQuery = "";
          composerState.openMenu = open ? null : "loadout";
          ctx.chat.drawActiveChat();
          placeLoadout();
        }}
      >
        <span class="menu-label">${selected.label}</span
        ><span class="menu-suffix">${effortText(composerState.effortLevel)}</span>
        ${fastOn ? html`<span class="loadout-bolt">${icon(Zap, 13)}</span>` : nothing}${icon(ChevronDown, 13)}
      </button>
      ${
        open && !disabled
          ? html`<div
              class="menu-popover loadout-popover"
              popover="manual"
              id=${loadoutMenuId}
              role="menu"
              aria-label="Model settings"
              @click=${(e: Event) => e.stopPropagation()}
              @mouseover=${(e: MouseEvent) => trackLoadoutHover(e)}
              @mouseleave=${() => queueLoadoutClose()}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeMenus();
                  ctx.chat.drawActiveChat();
                  requestAnimationFrame(() =>
                    ctx.chat.state.host?.querySelector<HTMLElement>(".loadout-button")?.focus(),
                  );
                } else if (!(e.target as HTMLElement).closest(".loadout-submenu")) menuArrowKeys(e);
              }}
            >
              <div class="loadout-panel">
                <div class="loadout-head">Presets</div>
                <div class="loadout-list">${entries.map((entry, at) => loadoutRow(entry, at, selected, agent))}</div>
                <div
                  class="loadout-submenu-anchor"
                  ${tip(entries.length >= LOADOUT_CAP ? "Remove a preset to add another." : "")}
                >
                  <button
                    class="loadout-add ${loadoutSection === "add" ? "open" : ""}"
                    type="button"
                    role="menuitem"
                    data-loadout-section="add"
                    aria-haspopup="menu"
                    aria-expanded=${loadoutSection === "add" ? "true" : "false"}
                    ?disabled=${entries.length >= LOADOUT_CAP}
                    @mouseenter=${() => {
                      if (isPhone() || entries.length >= LOADOUT_CAP) return;
                      loadoutSectionHovered = true;
                      openLoadoutSection("add");
                    }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "ArrowRight") {
                        e.preventDefault();
                        loadoutSectionHovered = false;
                        openLoadoutSection("add", true);
                      }
                    }}
                    @click=${(e: MouseEvent) => {
                      loadoutSectionHovered = e.detail !== 0 && !isPhone();
                      openLoadoutSection("add", e.detail === 0);
                    }}
                  >
                    ${icon(Plus, 16)}<span>Add models</span><span class="loadout-end">${icon(ChevronRight, 14)}</span>
                  </button>
                </div>
                <div class="loadout-divider"></div>
                ${loadoutHarnessControl(selected)}
                ${
                  harnessSupportsEffort(selected.harnessId)
                    ? html`<div class="loadout-submenu-anchor">
                        <button
                          class="loadout-setting ${loadoutSection === "effort" ? "open" : ""}"
                          type="button"
                          role="menuitem"
                          data-loadout-section="effort"
                          aria-haspopup="menu"
                          aria-expanded=${loadoutSection === "effort" ? "true" : "false"}
                          @mouseenter=${() => {
                            if (isPhone()) return;
                            loadoutSectionHovered = true;
                            openLoadoutSection("effort");
                          }}
                          @keydown=${(e: KeyboardEvent) => {
                            if (e.key === "ArrowRight") {
                              e.preventDefault();
                              loadoutSectionHovered = false;
                              openLoadoutSection("effort", true);
                            }
                          }}
                          @click=${(e: MouseEvent) => {
                            loadoutSectionHovered = e.detail !== 0 && !isPhone();
                            openLoadoutSection("effort", e.detail === 0);
                          }}
                        >
                          <span class="loadout-setting-label">Effort</span
                          ><span class="loadout-setting-value"
                            >${effortText(composerState.effortLevel)}<span class="loadout-end"
                              >${icon(ChevronRight, 14)}</span
                            ></span
                          >
                        </button>
                      </div>`
                    : nothing
                }
                <button
                  class="loadout-setting"
                  type="button"
                  role="menuitemcheckbox"
                  aria-label="Fast"
                  aria-checked=${fastOn ? "true" : "false"}
                  ?disabled=${!fastAvailable}
                  @click=${() => toggleFastMode(agent)}
                >
                  <span class="loadout-setting-label">Fast</span>
                  <span class="loadout-setting-value">
                    <span class="loadout-shortcut">${fastAvailable ? "⌘⇧E" : fastUnsupportedReason}</span>
                    <span class="loadout-toggle ${fastOn ? "on" : ""}" aria-hidden="true">
                      <span class="loadout-knob"></span>
                    </span>
                  </span>
                </button>
              </div>
              ${getRuntimeConfig(scopeKey())?.scopeOverride ? html`<div class="loadout-foot"><button class="loadout-foot-btn" type="button" @click=${() => changeScopeRuntime({ inherit: true }, agent)}>Use org default</button></div>` : nothing}
              ${loadoutSubmenu(agent, selected)}
            </div>`
          : nothing
      }
    </div>`;
  }

  function menuArrowKeys(e: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const target = e.target as HTMLElement;
    if (target.matches("input") && !["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const menu = target.closest<HTMLElement>('[role="menu"]');
    if (!menu) return;
    const buttons = [...menu.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter(
      (button) =>
        button.closest('[role="menu"]') === menu &&
        button.offsetParent !== null &&
        !button.classList.contains("loadout-drag"),
    );
    if (!buttons.length) return;
    e.preventDefault();
    e.stopPropagation();
    const at = buttons.indexOf(target);
    let next = at + (e.key === "ArrowUp" ? -1 : 1);
    if (at < 0 && e.key === "ArrowUp") next = buttons.length - 1;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = buttons.length - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  }

  function placeLoadout(): void {
    requestAnimationFrame(() => {
      const host = ctx.chat.state.host;
      const menu = host?.querySelector<HTMLElement>(".loadout-popover");
      const trigger = host?.querySelector<HTMLElement>(".loadout-button");
      if (!menu || !trigger) return;
      if (typeof menu.showPopover === "function" && !menu.matches(":popover-open")) menu.showPopover();
      const viewport = window.visualViewport;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const right = left + (viewport?.width ?? window.innerWidth) - 24;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 24;
      const rect = trigger.getBoundingClientRect();
      const above = rect.top - top - 8;
      const below = bottom - rect.bottom - 8;
      const up = above >= below;
      menu.style.maxHeight = `${Math.max(140, up ? above : below)}px`;
      menu.style.left = `${Math.max(left, Math.min(rect.left, right - menu.offsetWidth))}px`;
      menu.style.top = `${up ? Math.max(top, rect.top - menu.offsetHeight - 8) : rect.bottom + 8}px`;
      menu.style.bottom = "auto";
      const submenu = menu.querySelector<HTMLElement>(".loadout-submenu");
      const anchor = menu.querySelector<HTMLElement>(`[data-loadout-section="${loadoutSection}"]`);
      if (!submenu || !anchor) return;
      const menuRect = menu.getBoundingClientRect();
      const width = Math.min(260, right - left);
      const roomRight = right - menuRect.right - 4;
      const roomLeft = menuRect.left - left - 4;
      const inline = Math.max(roomLeft, roomRight) < width;
      submenu.classList.toggle("inline", inline);
      if (inline) {
        submenu.style.width = "";
        submenu.style.left = "";
        submenu.style.top = "";
        submenu.style.maxHeight = `${Math.max(120, (up ? above : below) - 80)}px`;
        menu.style.top = `${up ? Math.max(top, rect.top - menu.offsetHeight - 8) : rect.bottom + 8}px`;
      } else {
        submenu.style.width = `${width}px`;
        submenu.style.maxHeight = `${bottom - top}px`;
        submenu.style.left = `${roomRight >= width ? menuRect.right + 4 : menuRect.left - width - 4}px`;
        submenu.style.top = `${Math.max(top, Math.min(anchor.getBoundingClientRect().top - 6, bottom - submenu.offsetHeight))}px`;
      }
    });
  }

  window.addEventListener("resize", placeLoadout);
  window.visualViewport?.addEventListener("resize", placeLoadout);

  function matchSkills(query: string, skills: SkillItem[]): SkillMatch[] {
    const q = query.toLowerCase();
    if (!q) return skills.map((skill) => ({ skill, start: -1, end: -1 }));
    const out: SkillMatch[] = [];
    for (const skill of skills) {
      const at = skill.name.toLowerCase().indexOf(q);
      if (at >= 0) out.push({ skill, start: at, end: at + q.length });
    }
    return out.sort((a, b) => a.start - b.start || a.skill.name.localeCompare(b.skill.name));
  }

  function currentSlashMenu(): { open: boolean; loading: boolean; matches: SkillMatch[] } {
    const query = slashQuery(composerState.draft);
    if (query === null || composerState.slashDismissed) return { open: false, loading: false, matches: [] };
    const loading = skillsLoading;
    const matches = skillsCache ? matchSkills(query, skillsCache) : [];
    return { open: loading || matches.length > 0, loading, matches };
  }

  function clampedActive(matchCount: number): number {
    return Math.max(0, Math.min(slashActiveIndex, matchCount - 1));
  }

  async function loadSkills(agent: Agent): Promise<void> {
    if (skillsLoading || skillsCache !== null) return;
    skillsLoading = true;
    ctx.chat.drawActiveChat(agent);
    try {
      const r = await api<{ skills: SkillItem[] }>("/api/skills");
      skillsCache = r.skills ?? [];
    } catch {
      skillsCache = null;
    } finally {
      skillsLoading = false;
      if (agent === ctx.chat.state.agent) ctx.chat.drawActiveChat(agent);
    }
  }

  function acceptSkill(skill: SkillItem, agent: Agent): void {
    composerState.draft = composerState.draft.replace(SLASH_TOKEN, (_m, pre: string) => `${pre}/${skill.name} `);
    persistDraft();
    slashActiveIndex = 0;
    composerState.slashDismissed = false;
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  function fillSuggestedPrompt(prompt: string, agent: Agent): void {
    if (
      agent !== ctx.chat.state.agent ||
      agent.state.isStreaming ||
      composerState.draft ||
      composerState.attachments.length ||
      composerState.processingFiles
    )
      return;
    composerState.draft = prompt;
    composerState.error = "";
    persistDraft();
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  let pendingComposerFocus = false;

  function focusComposerEnd(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (ta.disabled) {
        pendingComposerFocus = true;
        return;
      }
      pendingComposerFocus = false;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  function closeSlashMenu(agent: Agent): void {
    composerState.slashDismissed = true;
    ctx.chat.drawActiveChat(agent);
  }

  function slashMenu(agent: Agent): TemplateResult | typeof nothing {
    const slash = currentSlashMenu();
    if (!slash.open) return nothing;
    if (slash.loading && slash.matches.length === 0) {
      return html`<div class="slash-popover">
        <div class="menu-title">Skills</div>
        <div class="slash-empty">Loading skills…</div>
      </div>`;
    }
    const active = clampedActive(slash.matches.length);
    return html`
      <div class="slash-popover" role="listbox" aria-label="Skills">
        <div class="menu-title">Skills</div>
        ${slash.matches.map((m, i) => slashRow(m, i === active, agent))}
      </div>
    `;
  }

  function slashRow(m: SkillMatch, active: boolean, agent: Agent): TemplateResult {
    return html`
      <button
        type="button"
        role="option"
        aria-selected=${active ? "true" : "false"}
        class="slash-option ${active ? "active" : ""}"
        ${tip(m.skill.description)}
        @mousedown=${(e: Event) => e.preventDefault()}
        @click=${() => acceptSkill(m.skill, agent)}
      >
        <span class="slash-icon">${icon(Box, 16)}</span>
        <span class="slash-name">${highlightName(m)}</span>
        <span class="slash-desc">${m.skill.description}</span>
        <span class="slash-scope">${scopeBadge(m.skill.scope)}</span>
      </button>
    `;
  }

  function highlightName(m: SkillMatch): TemplateResult {
    const { name } = m.skill;
    if (m.start < 0 || m.end <= m.start) return html`${name}`;
    return html`${name.slice(0, m.start)}<b>${name.slice(m.start, m.end)}</b>${name.slice(m.end)}`;
  }

  function scopeBadge(scope: string): string {
    return scope ? scope.charAt(0).toUpperCase() + scope.slice(1) : "";
  }

  function submitComposer(e: Event, agent: Agent): void {
    e.preventDefault();
    void sendPrompt(agent);
  }

  function onDraftInput(e: InputEvent, agent: Agent): void {
    const wasEmpty = !composerState.draft;
    composerState.draft = (e.currentTarget as HTMLTextAreaElement).value;
    persistDraft();
    const hadError = Boolean(composerState.error);
    composerState.error = "";
    composerState.slashDismissed = false;
    slashActiveIndex = 0;
    const armed = slashQuery(composerState.draft) !== null;
    if (armed && skillsCache === null && !skillsLoading) void loadSkills(agent);
    const popoverShown = Boolean(ctx.chat.state.host?.querySelector(".slash-popover"));
    if (
      armed ||
      popoverShown ||
      hadError ||
      (Boolean(appState.me?.suggestedActivities?.length) && wasEmpty !== !composerState.draft)
    ) {
      ctx.chat.drawActiveChat(agent);
      return;
    }
    syncComposerControls(agent);
    resizeComposer();
  }

  function composerCanSend(): boolean {
    if (!currentModelOption()) return false;
    return (
      Boolean(composerState.draft.trim() || composerState.attachments.length) &&
      !composerState.processingFiles &&
      !ctx.chat.isStopping() &&
      getRuntimeConfig(scopeKey()) !== null &&
      ctx.chat.state.resolvingApprovals.size === 0 &&
      !ctx.chat.hasUnresolvedApproval()
    );
  }

  function syncComposerControls(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = !composerCanSend();
  }

  function clearComposerDom(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const input = ctx.chat.state.host.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input) {
      input.value = "";
      input.style.height = "auto";
      input.style.overflowY = "hidden";
      input.scrollTop = 0;
    }
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send) send.disabled = true;
  }

  function onComposerKeydown(e: KeyboardEvent, agent: Agent): void {
    // During IME composition (Japanese/Chinese/Korean), Enter confirms the
    // conversion — it must never send. Safari reports composition Enter with
    // keyCode 229 and may fire after compositionend, so check both.
    if (e.isComposing || e.keyCode === 229) return;
    const slash = currentSlashMenu();
    if (slash.open) {
      if (e.key === "Escape") {
        e.preventDefault();
        return closeSlashMenu(agent);
      }
      if (slash.matches.length) {
        const count = slash.matches.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          slashActiveIndex = (clampedActive(count) + 1) % count;
          return ctx.chat.drawActiveChat(agent);
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          slashActiveIndex = (clampedActive(count) - 1 + count) % count;
          return ctx.chat.drawActiveChat(agent);
        }
        if (!e.shiftKey && (e.key === "Enter" || e.key === "Tab")) {
          e.preventDefault();
          return acceptSkill(slash.matches[clampedActive(count)]!.skill, agent);
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void sendPrompt(agent);
  }

  function stopStreaming(agent: Agent): void {
    composerState.error = "";
    void ctx.chat.stopLiveRun().catch(() => {
      if (agent !== ctx.chat.state.agent) return;
      composerState.error = "Could not request stop. Try again.";
      ctx.chat.drawActiveChat(agent);
    });
  }

  let failedQueueSend: { threadRef: string; text: string; filesKey: string; idempotencyKey: string } | null = null;

  function queuedFilesKey(staged: readonly Attachment[]): string {
    return staged.map((a) => a.id).join(",");
  }

  function queueSendKey(threadRef: string, text: string, filesKey: string): string {
    return failedQueueSend?.threadRef === threadRef &&
      failedQueueSend.text === text &&
      failedQueueSend.filesKey === filesKey
      ? failedQueueSend.idempotencyKey
      : mintSendKey();
  }

  async function queueDraft(agent: Agent): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    const text = composerState.draft.trim();
    const staged = composerState.attachments;
    if ((!text && !staged.length) || !threadRef) return;
    clearActiveDraft();
    composerState.draft = "";
    composerState.attachments = [];
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    const { uploaded, skipped } = await uploadAttachments(staged);
    const stillHere = (): boolean => ctx.chat.state.threadRef === threadRef;
    if (skipped.length && stillHere()) composerState.error = skipped.map((s) => s.note).join(" ");
    const droppedIds = new Set(skipped.filter((s) => s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const transientIds = new Set(skipped.filter((s) => !s.permanent).flatMap((s) => (s.id ? [s.id] : [])));
    const sendable = staged.filter((a) => !droppedIds.has(a.id));
    if (!text && !uploaded.length) {
      if (stillHere()) restoreStagedOnFailure(text, sendable, composerState.error || "Could not queue the files.");
      return ctx.chat.drawActiveChat(agent);
    }
    if (!(await enqueueTurn(agent, threadRef, text, uploaded, queuedFilesKey(sendable)))) {
      if (stillHere()) restoreStagedOnFailure(text, sendable, composerState.error);
    } else if (transientIds.size && stillHere()) {
      restageAttachments(
        staged.filter((a) => transientIds.has(a.id)),
        composerState.error,
      );
    }
    ctx.chat.drawActiveChat(agent);
  }

  function restoreStagedOnFailure(text: string, staged: Attachment[], note: string): void {
    const typedSince = composerState.draft.trim();
    composerState.draft = !typedSince || typedSince === text ? text : `${text}\n${composerState.draft}`;
    const { kept, note: capNote } = mergeStagedAttachments(staged, composerState.attachments);
    composerState.attachments = kept;
    composerState.error = combineNote(note, capNote);
  }

  async function enqueueTurn(
    agent: Agent,
    threadRef: string,
    text: string,
    attachments: CoreAttachment[] = [],
    filesKey = "",
  ): Promise<boolean> {
    const idempotencyKey = queueSendKey(threadRef, text, filesKey);
    try {
      const queued = await queueTurn(threadRef, text, agent, ctx.chat.currentTurnOptions, idempotencyKey, attachments);
      failedQueueSend = null;
      setQueuedRuns(threadRef, [...queuedRunsFor(threadRef).filter((r) => r.runId !== queued.runId), queued]);
      bumpSessionActivity(threadRef);
      return true;
    } catch (err) {
      failedQueueSend = { threadRef, text, filesKey, idempotencyKey };
      composerState.error = errMessage(err, "Could not queue the message.");
      return false;
    }
  }

  function cancelQueuedEdit(agent: Agent): void {
    if (queuedEdit?.saving) return;
    queuedEdit = null;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    focusComposerEnd();
  }

  async function saveQueuedEdit(agent: Agent): Promise<void> {
    const edit = queuedEdit;
    if (!edit || edit.saving) return;
    edit.saving = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    try {
      await editQueuedRun(edit.runId, edit.text, edit.original);
      setQueuedRuns(
        edit.threadRef,
        queuedRunsFor(edit.threadRef).map((q) => (q.runId === edit.runId ? { ...q, text: edit.text } : q)),
      );
      if (queuedEdit === edit) {
        queuedEdit = null;
        if (ctx.chat.state.threadRef === edit.threadRef && ctx.chat.state.agent === agent) focusComposerEnd();
      }
    } catch (error) {
      if (ctx.chat.state.threadRef === edit.threadRef)
        composerState.error =
          error instanceof ApiError && error.status === 409
            ? "That message changed or already started. Your edit was not saved."
            : errMessage(error, "Could not edit the queued message.");
    } finally {
      edit.saving = false;
      if (ctx.chat.state.threadRef === edit.threadRef) ctx.chat.drawActiveChat(agent);
    }
  }

  async function removeQueued(agent: Agent, queued: QueuedRun): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    if (!threadRef) return;
    composerState.error = "";
    try {
      await withdrawRun(queued.runId);
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 409 || err.status === 404))) {
        composerState.error = errMessage(err, "Could not remove the queued message.");
        return ctx.chat.drawActiveChat(agent);
      }
    }
    forgetQueuedRun(threadRef, queued.runId);
    ctx.chat.drawActiveChat(agent);
  }

  const pendingSteers = new Set<string>();

  async function steerQueued(agent: Agent, queued: QueuedRun): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    if (!threadRef || !ctx.chat.hasLiveRun() || pendingSteers.has(queued.runId)) return;
    pendingSteers.add(queued.runId);
    composerState.error = "";
    try {
      const outcome = await ctx.chat.signalLiveRun("steer", queued.text, queued.runId);
      if (outcome.ok || outcome.replayed) {
        forgetQueuedRun(threadRef, queued.runId);
        bumpSessionActivity(threadRef);
        if (agent === ctx.chat.state.agent && threadRef === ctx.chat.state.threadRef) {
          agent.state.messages.push({
            role: "user",
            content: queued.text,
            timestamp: Date.now(),
            ...(outcome.ok ? { steered: true } : {}),
          } as unknown as AgentMessage);
        }
      } else if (outcome.reason === "queued_changed") {
        if (agent === ctx.chat.state.agent && threadRef === ctx.chat.state.threadRef)
          composerState.error = "The queued message changed. Try steering it again.";
      } else if (outcome.reason === "queued_started" || outcome.reason === "not_found") {
        forgetQueuedRun(threadRef, queued.runId);
      }
    } catch (err) {
      if (agent === ctx.chat.state.agent && threadRef === ctx.chat.state.threadRef)
        composerState.error = errMessage(err, "Could not confirm steering. Try again.");
    } finally {
      pendingSteers.delete(queued.runId);
    }
    if (agent !== ctx.chat.state.agent || threadRef !== ctx.chat.state.threadRef) return;
    ctx.chat.drawActiveChat(agent);
    ctx.chat.resumeIfIdle();
  }

  async function sendPrompt(agent: Agent): Promise<void> {
    if (!composerCanSend()) return;
    if (composerState.pasteView) closePasteView(agent);
    if (agent.state.isStreaming) return queueDraft(agent);
    const text = composerState.draft.trim();
    if (ctx.chat.state.threadRef) {
      bumpSessionActivity(ctx.chat.state.threadRef);
      ctx.chat.state.pendingSend = ctx.chat.state.threadRef;
      renderList();
    }
    const attachments = composerState.attachments;
    const sentFromThread = ctx.chat.state.threadRef;
    ctx.chat.notePendingSessionOnSend();
    clearActiveDraft();
    resetComposer();
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    try {
      if (ctx.chat.state.normalStreamFn) agent.streamFn = ctx.chat.state.normalStreamFn;
      ctx.chat.scrollToBottom();
      await agent.prompt(userSendMessage(text, attachments.length ? attachments : undefined));
      restoreBlockedSend(agent, sentFromThread, text, attachments);
      restoreFailedAttachments(agent, text, attachments);
    } catch (err) {
      ctx.chat.state.pendingSend = null;
      if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
      renderList();
      composerState.error = errMessage(err, "Could not send message.");
      ctx.chat.drawActiveChat(agent);
    }
  }

  function restoreFailedAttachments(agent: Agent, text: string, attachments: Attachment[]): void {
    const messages = agent.state.messages;
    const last = messages[messages.length - 1] as
      { role?: string; sendFailed?: string; droppedAttachmentIds?: string[] } | undefined;
    if (last?.role !== "assistant" || last.sendFailed !== "attachments" || agent !== ctx.chat.state.agent) return;
    const dropped = new Set(last.droppedAttachmentIds ?? []);
    const retryable = attachments.filter((a) => !dropped.has(a.id));
    messages.pop();
    const prompt = messages[messages.length - 1] as { role?: string } | undefined;
    if (prompt?.role === "user" || prompt?.role === "user-with-attachments") messages.pop();
    (agent.state as { errorMessage?: string }).errorMessage = undefined;
    ctx.chat.state.pendingSend = null;
    if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
    renderList();
    restoreStagedOnFailure(
      text,
      retryable,
      retryable.length
        ? "Couldn't attach the files, so the message wasn't sent. Try again."
        : "Nothing could be attached, so the message wasn't sent.",
    );
    persistDraft();
    ctx.chat.drawActiveChat(agent);
  }

  function restoreBlockedSend(
    agent: Agent,
    sentFromThread: string | null,
    text: string,
    attachments: Attachment[],
  ): void {
    const messages = agent.state.messages;
    const last = messages[messages.length - 1] as
      { role?: string; sendBlocked?: string; errorMessage?: string } | undefined;
    if (last?.role !== "assistant" || last.sendBlocked !== "pending_approval") return;
    if (agent !== ctx.chat.state.agent) {
      if (sentFromThread) saveDraft(sentFromThread, text);
      return;
    }
    messages.pop();
    const prompt = messages[messages.length - 1] as { role?: string } | undefined;
    if (prompt?.role === "user" || prompt?.role === "user-with-attachments") messages.pop();
    (agent.state as { errorMessage?: string }).errorMessage = undefined;
    ctx.chat.state.pendingSend = null;
    if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
    renderList();
    const typedSince = composerState.draft.trim();
    composerState.draft = !typedSince || typedSince === text ? text : `${text}\n${composerState.draft}`;
    const { kept, note } = mergeStagedAttachments(attachments, composerState.attachments);
    composerState.attachments = kept;
    composerState.error = combineNote(last.errorMessage || PENDING_APPROVAL_REASON, note);
    persistDraft();
    ctx.chat.drawActiveChat(agent);
  }

  const LARGE_PASTE_CHARS = 2000;

  async function onComposerPaste(e: ClipboardEvent, agent: Agent): Promise<void> {
    const data = e.clipboardData;
    if (!data) return;
    const files = Array.from(data.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length) {
      e.preventDefault();
      await addFiles(files, agent);
      return;
    }
    const text = data.getData("text/plain");
    if (text.length <= LARGE_PASTE_CHARS) return;
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0 || composerState.processingFiles)
      return;
    if (composerState.attachments.length >= MAX_FILES_PER_MESSAGE) return;
    e.preventDefault();
    const names = new Set(composerState.attachments.map((a) => a.fileName));
    let n = 1;
    while (names.has(n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`)) n++;
    const bytes = new TextEncoder().encode(text);
    const attachment: Attachment = {
      id: `paste_${Date.now()}_${Math.random()}`,
      type: "document",
      fileName: n === 1 ? "pasted-text.txt" : `pasted-text-${n}.txt`,
      mimeType: "text/plain",
      size: bytes.length,
      content: bytesToBase64(bytes),
      extractedText: text,
    };
    pastedTextIds.add(attachment.id);
    composerState.attachments = [...composerState.attachments, attachment];
    ctx.chat.drawActiveChat(agent);
  }

  async function onFilesSelected(e: Event, agent: Agent): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await addFiles(files, agent);
  }

  async function fileToBase64(file: File): Promise<string> {
    return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  }

  const IMAGE_PREVIEW_EDGE = 512;
  const IMAGE_PREVIEW_SOURCE_BYTES = 10_000_000;
  const IMAGE_PREVIEW_BYTES = 1_000_000;
  const IMAGE_PREVIEW_SOURCE_PIXELS = 16_777_216;
  let imagePreviewQueue = Promise.resolve();

  async function imageDimensions(file: File): Promise<{ width: number; height: number } | undefined> {
    const bytes = new Uint8Array(await file.slice(0, 262_144).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = file.type.toLowerCase();
    const signature = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
    if (
      (type === "image/png" || type === "image/apng") &&
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === "image/gif" && bytes.length >= 10 && (signature(0, 6) === "GIF87a" || signature(0, 6) === "GIF89a")) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (
      ["image/bmp", "image/x-ms-bmp"].includes(type) &&
      bytes.length >= 26 &&
      bytes[0] === 0x42 &&
      bytes[1] === 0x4d
    ) {
      return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
    }
    if (type === "image/webp" && bytes.length >= 30 && signature(0, 4) === "RIFF" && signature(8, 12) === "WEBP") {
      let offset = 12;
      while (offset + 8 <= bytes.length) {
        const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const size = view.getUint32(offset + 4, true);
        const data = offset + 8;
        if (chunk === "VP8X" && data + 10 <= bytes.length) {
          const width = 1 + bytes[data + 4]! + (bytes[data + 5]! << 8) + (bytes[data + 6]! << 16);
          const height = 1 + bytes[data + 7]! + (bytes[data + 8]! << 8) + (bytes[data + 9]! << 16);
          return { width, height };
        }
        if (chunk === "VP8L" && data + 5 <= bytes.length && bytes[data] === 0x2f) {
          const packed = view.getUint32(data + 1, true);
          return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8 " && data + 10 <= bytes.length) {
          return { width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff };
        }
        offset = data + size + (size % 2);
      }
    }
    if (["image/jpeg", "image/jpg", "image/pjpeg"].includes(type) && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset++] !== 0xff) return undefined;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++]!;
        const length = view.getUint16(offset);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
        }
        if (length < 2 || offset + length > bytes.length) return undefined;
        offset += length;
      }
    }
    return undefined;
  }

  async function boundedImagePreview(file: File): Promise<string | undefined> {
    if (
      !browserRenderableImage(file.type) ||
      file.size > IMAGE_PREVIEW_SOURCE_BYTES ||
      typeof createImageBitmap !== "function"
    )
      return undefined;
    let bitmap: ImageBitmap | undefined;
    try {
      const dimensions = await imageDimensions(file);
      if (
        !dimensions ||
        dimensions.width <= 0 ||
        dimensions.height <= 0 ||
        dimensions.width > IMAGE_PREVIEW_SOURCE_PIXELS / dimensions.height
      )
        return undefined;
      const scale = Math.min(1, IMAGE_PREVIEW_EDGE / dimensions.width, IMAGE_PREVIEW_EDGE / dimensions.height);
      const width = Math.max(1, Math.round(dimensions.width * scale));
      const height = Math.max(1, Math.round(dimensions.height * scale));
      bitmap = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const preview = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
      if (!preview || preview.size > IMAGE_PREVIEW_BYTES) return undefined;
      return `data:${preview.type};base64,${bytesToBase64(new Uint8Array(await preview.arrayBuffer()))}`;
    } catch {
      return undefined;
    } finally {
      bitmap?.close();
    }
  }

  async function loadAnyAttachment(file: File): Promise<Attachment> {
    const preview = imagePreviewQueue.then(() => boundedImagePreview(file));
    imagePreviewQueue = preview.then(
      () => undefined,
      () => undefined,
    );
    try {
      const { loadAttachment } = await import("@earendil-works/pi-web-ui");
      return { ...(await loadAttachment(file)), preview: await preview };
    } catch {
      return {
        id: `${file.name}_${Date.now()}_${Math.random()}`,
        type: "document",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        content: await fileToBase64(file),
        preview: await preview,
      };
    }
  }

  function restageAttachments(attachments: Attachment[], note: string): void {
    if (!attachments.length) {
      composerState.error = note;
      return;
    }
    const { kept, note: capNote } = mergeStagedAttachments(attachments, composerState.attachments);
    composerState.attachments = kept;
    composerState.error = combineNote(note, capNote);
  }

  function combineNote(existing: string, note: string | null): string {
    if (!note) return existing;
    return existing ? `${existing} ${note}` : note;
  }

  function capOverflowNote(dropped: readonly { fileName: string }[]): string | null {
    return dropped.length ? tooManyFilesNote(dropped.map((a) => a.fileName)) : null;
  }

  function mergeStagedAttachments(
    restored: Attachment[],
    current: Attachment[],
  ): { kept: Attachment[]; note: string | null } {
    const seen = new Set<string>();
    const merged: Attachment[] = [];
    for (const a of [...restored, ...current]) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      merged.push(a);
    }
    return { kept: merged.slice(0, MAX_FILES_PER_MESSAGE), note: capOverflowNote(merged.slice(MAX_FILES_PER_MESSAGE)) };
  }

  function planAdmission(files: File[], folderCount: number): { files: File[]; folders: number; note: string | null } {
    const notes: string[] = [];
    const sized: File[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) notes.push(oversizeAttachmentNote(file.name));
      else sized.push(file);
    }
    const room = Math.max(0, MAX_FILES_PER_MESSAGE - composerState.attachments.length);
    const admittedFiles = sized.slice(0, room);
    const admittedFolders = Math.min(folderCount, Math.max(0, room - admittedFiles.length));
    const overflow = [
      ...sized.slice(room).map((f) => f.name),
      ...Array.from({ length: folderCount - admittedFolders }, () => "a folder"),
    ];
    if (overflow.length) notes.push(tooManyFilesNote(overflow));
    return { files: admittedFiles, folders: admittedFolders, note: notes.length ? notes.join(" ") : null };
  }

  async function addFiles(files: File[], agent: Agent, folders: DropEntryLike[] = []): Promise<void> {
    if (
      (!files.length && !folders.length) ||
      ctx.chat.hasUnresolvedApproval() ||
      ctx.chat.state.resolvingApprovals.size > 0
    )
      return;
    if (composerState.processingFiles) {
      composerState.error = "Still preparing the previous drop. Try again in a moment.";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    composerState.processingFiles = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    const plan = planAdmission(files, folders.length);
    try {
      const zipped: File[] = [];
      for (const folder of folders.slice(0, plan.folders)) zipped.push(await folderToZipFile(folder));
      const loaded = await Promise.all([...plan.files, ...zipped].map((file) => loadAnyAttachment(file)));
      composerState.attachments = [...composerState.attachments, ...loaded];
      if (plan.note) composerState.error = plan.note;
    } catch (err) {
      let message: string;
      if (err instanceof FolderDropError) message = err.message;
      else if (isFolderReadError(err))
        message = "That drop included a folder this browser can't read. Zip it and drop the archive instead.";
      else message = errMessage(err, "Could not attach that file.");
      composerState.error = combineNote(plan.note ?? "", message);
    } finally {
      composerState.processingFiles = false;
      ctx.chat.drawActiveChat(agent);
    }
  }

  function dragHasFiles(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return types ? Array.from(types).includes("Files") : false;
  }

  function onDragEnter(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    fileDrag.enter(e);
  }

  function onDragOver(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent): void {
    fileDrag.leave(e);
  }

  async function onDrop(e: DragEvent, agent: Agent): Promise<void> {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    fileDrag.reset();
    const { files, folders } = splitDropItems(Array.from(e.dataTransfer?.items ?? []));
    if (!files.length && !folders.length) files.push(...Array.from(e.dataTransfer?.files ?? []));
    ctx.chat.drawActiveChat(agent);
    await addFiles(files, agent, folders);
  }

  function pickFiles(): void {
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0) return;
    ctx.chat.state.host?.querySelector<HTMLInputElement>(".file-input")?.click();
  }

  function removeAttachment(id: string, agent: Agent): void {
    composerState.attachments = composerState.attachments.filter((a) => a.id !== id);
    pastedTextIds.delete(id);
    if (composerState.pasteView?.id === id) composerState.pasteView = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectModel(value: string, agent: Agent): void {
    const option = getModelOptions(scopeKey()).find((candidate) => candidate.value === value);
    if (!option) return;
    ++modelSelectionRevision;
    const previousDefaultEffort = defaultEffortForModel(currentModelOption()?.model);
    if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, option.value);
    agent.state.model = option.model;
    if (composerState.effortLevel === previousDefaultEffort) {
      composerState.effortLevel = defaultEffortForModel(option.model);
    }
    composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectHarness(harnessId: string, agent: Agent): void {
    const selected = currentModelOption();
    if (!selected || selected.harnessId === harnessId) return;
    const target = compatibleHarnessOptions(getModelOptions(scopeKey()), selected.model.id).find(
      (option) => option.harnessId === harnessId,
    );
    if (!target) return;
    const active = activeLoadoutEntry(selected);
    applyLoadout({ ...active, value: target.value }, agent);
  }

  function selectEffort(level: EffortLevel, agent: Agent): void {
    const selected = currentModelOption();
    if (!selected || !effortLevelsForHarness(selected.harnessId).some((option) => option.value === level)) return;
    composerState.effortLevel = level;
    rememberActiveTweaks(selected);
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  function toggleFastMode(agent: Agent): void {
    const selected = currentModelOption();
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0) return;
    if (
      !selected ||
      !harnessSupportsFastMode(selected.harnessId) ||
      !modelSupportsFastMode(scopeKey(), selected.model.id)
    )
      return;
    composerState.fastMode = !effectiveFastMode();
    rememberActiveTweaks(selected);
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  let autosizedTa: HTMLTextAreaElement | null = null;
  let autosizedValue: string | null = null;
  let autosizeObserver: ResizeObserver | null = null;

  function resizeComposer(): void {
    requestAnimationFrame(() => {
      const ta = ctx.chat.state.host?.querySelector<HTMLTextAreaElement>(".composer-input");
      if (!ta) return;
      if (autosizedTa !== ta && typeof ResizeObserver !== "undefined") {
        autosizeObserver ??= new ResizeObserver(() => {
          autosizedValue = null;
          resizeComposer();
        });
        if (autosizedTa) autosizeObserver.unobserve(autosizedTa);
        autosizeObserver.observe(ta);
        autosizedTa = ta;
        autosizedValue = null;
      }
      if (ta.value === autosizedValue) return;
      autosizedValue = ta.value;
      const wrap = ta.closest<HTMLElement>(".composer-wrap");
      const wrapHeight = wrap?.style.height ?? "";
      if (wrap) wrap.style.height = `${wrap.getBoundingClientRect().height}px`;
      ta.style.height = "auto";
      const cap = parseFloat(getComputedStyle(ta).maxHeight) || 180;
      const content = ta.scrollHeight;
      ta.style.height = `${Math.min(cap, Math.max(ctx.pane ? 0 : 48, content))}px`;
      if (wrap) wrap.style.height = wrapHeight;
      if (content > cap) {
        ta.style.overflowY = "auto";
      } else {
        ta.style.overflowY = "hidden";
        ta.scrollTop = 0;
      }
    });
  }

  function closeMenus(): boolean {
    let changed = false;
    if (composerState.openMenu) {
      cancelLoadoutClose();
      loadoutSection = null;
      loadoutSectionHovered = false;
      composerState.openMenu = null;
      changed = true;
    }
    if (!composerState.slashDismissed && slashQuery(composerState.draft) !== null) {
      composerState.slashDismissed = true;
      changed = true;
    }
    return changed;
  }

  function dispose(): void {
    window.removeEventListener("model-account-changed", refreshAccount);
    cancelLoadoutClose();
    unsubscribeRuntime?.();
    ++runtimeRequest;
    fileDrag.dispose();
    autosizeObserver?.disconnect();
    autosizeObserver = null;
    autosizedTa = null;
    window.removeEventListener("resize", placeLoadout);
    window.visualViewport?.removeEventListener("resize", placeLoadout);
  }

  return {
    state: composerState,
    restageAttachments,
    composerForm,
    composerApprovalPanel,
    queuedStrip,
    queuedRunsFor,
    setQueuedRuns,
    resetComposer,
    focusComposerEnd,
    fillSuggestedPrompt,
    sendSuggestedPrompt: async (prompt: string, agent: Agent): Promise<void> => {
      if (
        agent !== ctx.chat.state.agent ||
        agent.state.isStreaming ||
        composerState.draft ||
        composerState.attachments.length ||
        composerState.processingFiles
      )
        return;
      fillSuggestedPrompt(prompt, agent);
      await sendPrompt(agent);
    },
    resizeComposer,
    currentModelOption,
    carryModelPick,
    refreshRuntimeSelection,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    closeMenus,
    dispose,
  };
}
