import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
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
  Settings,
  Plus,
  Sparkles,
  CornerDownRight,
  FileText,
  Paperclip,
  Square,
  X,
  Zap,
} from "lucide";
import {
  api,
  ApiError,
  approvalBlocksComposer,
  fetchRuntimeConfig,
  latestTranscriptSeq,
  MAX_ATTACHMENT_BYTES,
  MAX_FILES_PER_MESSAGE,
  mintSendKey,
  oversizeAttachmentNote,
  PENDING_APPROVAL_REASON,
  queueTurn,
  tooManyFilesNote,
  updateRuntimeConfig,
  uploadAttachments,
  userSendMessage,
  verifySteerDelivered,
  withdrawRun,
  type ApprovalDecision,
  type CoreAttachment,
  type PendingApproval,
  type QueuedRun,
  type RuntimeConfig,
} from "./core-bridge";
import { errMessage, swallow } from "../../chassis/src/errors";
import { fieldSelect, icon, modelMark } from "./ui";
import {
  EFFORT_LEVELS,
  applyRuntimeOptions,
  defaultEffortForModel,
  defaultModelValue,
  effortLabel,
  getHarnessOptions,
  getModelOptions,
  getModelOptionsForHarness,
  harnessSupportsEffort,
  harnessSupportsFastMode,
  harnessSupportsSteer,
  type EffortLevel,
  type ModelOption,
  type ModelOptionValue,
} from "./model-options";
import { modelSupportsFastMode, setFastModeModelIds } from "./pi-models";
import type { ComposerSurface, ConvCtx } from "./conv-types";
import { bumpSessionActivity, dropPendingSession, renderList } from "./sessions";
import { appState } from "./shell";
import { base64ToText, bytesToBase64, insertIntoDraft, pasteChipLabel } from "./paste-text";
import { clearDraft, newChatDraftKey, saveDraft } from "./drafts";
import { tip } from "./tooltip";
import { isPhone } from "./viewport";
import {
  parseLoadout,
  reconcileLoadout,
  upsertLoadout,
  reorderLoadout,
  effortLevelsForHarness,
  harnessTarget,
  type LoadoutEntry,
} from "./composer-loadout";

export type ComposerMenu = "effort" | "harness" | "model" | "settings" | "loadout";

const LEGACY_MODEL_STORAGE_KEY = "web-ui:model";
const THREAD_PICKS_STORAGE_KEY = "web-ui:model-picks";
const THREAD_PICKS_CAP = 50;
const FAST_MODE_STORAGE_KEY = "web-ui:fast-mode";
const EFFORT_STORAGE_KEY = "web-ui:effort";
const LOADOUT_STORAGE_KEY = "web-ui:loadout";
const LOADOUT_CAP = 5;

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
let seededRuntime: { scopeId: string | null; config: RuntimeConfig } | null = null;

export function seedRuntimeConfig(scopeId: string | null, config: RuntimeConfig): void {
  seededRuntime = { scopeId: runtimeScopeKey(scopeId), config };
}

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

function loadStoredFastMode(): boolean | undefined {
  try {
    const stored = localStorage.getItem(FAST_MODE_STORAGE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
  } catch {
    void 0;
  }
  return undefined;
}

function loadStoredEffort(fallback: EffortLevel): EffortLevel {
  try {
    const stored = localStorage.getItem(EFFORT_STORAGE_KEY);
    if (stored && EFFORT_LEVELS.some((option) => option.value === stored)) return stored as EffortLevel;
  } catch {
    void 0;
  }
  return fallback;
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

function effortText(level: EffortLevel | string): TemplateResult | string {
  const label = effortLabel(level as EffortLevel);
  return level === "xhigh" ? html`<span class="effort-peak">${label}</span>` : label;
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
  const loadoutMenuId = `composer-loadout-${crypto.randomUUID()}`;
  let activeRuntimeConfig: RuntimeConfig | null = null;
  let runtimeRequest = 0;

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
    effortLevel: loadStoredEffort(defaultEffortForModel(modelOptionFor(defaultModelValue())?.model)),
    fastMode: loadStoredFastMode(),
    pasteView: null as { id: string; text: string; initial: string; dirty: boolean } | null,
  };

  const pastedTextIds = new Set<string>();

  const queuedRuns = new Map<string, QueuedRun[]>();

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

  let dragDepth = 0;
  let skillsLoading = false;
  let slashActiveIndex = 0;
  let orgFastModeDefault = false;
  function effectiveFastMode(): boolean {
    return composerState.fastMode ?? orgFastModeDefault;
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

  async function refreshRuntimeSelection(scopeId: string | null, agent?: Agent): Promise<void> {
    const request = ++runtimeRequest;
    const scopeKey = runtimeScopeKey(scopeId);
    const seeded = scopeKey !== null && seededRuntime?.scopeId === scopeKey ? seededRuntime.config : null;
    if (seeded) {
      seededRuntime = null;
      applySelectedRuntime(seeded, agent);
      return;
    }
    activeRuntimeConfig = null;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    const config = await fetchRuntimeConfig(scopeId);
    if (request !== runtimeRequest) return;
    if (!config) {
      applyRuntimeOptions(scopeKey, [], {}, { harnessId: "", modelId: "" });
      composerState.error = "Could not load runtime settings.";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    applySelectedRuntime(config, agent);
  }

  function applySelectedRuntime(config: RuntimeConfig, agent?: Agent, restoreSaved = true): void {
    activeRuntimeConfig = config;
    composerState.error = "";
    setFastModeModelIds(scopeKey(), config.fastModeModelIds);
    orgFastModeDefault = config.interactiveFastMode === true;
    applyRuntimeOptions(
      scopeKey(),
      config.approvedHarnesses,
      config.modelsByHarness,
      config.effective,
      config.modelCatalog,
    );
    const selected = currentModelOption();
    loadout = loadLoadout();
    const saved = restoreSaved ? loadout.find((entry) => entry.value === selected?.value) : undefined;
    const effort = saved?.effort ?? (config.effective.effortLevel as EffortLevel | undefined);
    composerState.effortLevel =
      effort && effortLevelsForHarness(selected?.harnessId ?? "").some((level) => level.value === effort)
        ? effort
        : defaultEffortForModel(selected?.model);
    composerState.fastMode =
      (saved?.fast ?? config.effective.fastMode) === true &&
      harnessSupportsFastMode(selected?.harnessId ?? "") &&
      modelSupportsFastMode(scopeKey(), selected?.model.id);
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
  ): Promise<void> {
    const request = ++runtimeRequest;
    const scopeId = ctx.chat.state.scopeId;
    try {
      const config = await updateRuntimeConfig(scopeId, change);
      if (request !== runtimeRequest || scopeId !== ctx.chat.state.scopeId) return;
      seededRuntime = null;
      if (ctx.chat.state.threadRef) {
        if (change.inherit) forgetThreadPick(ctx.chat.state.threadRef);
        else rememberThreadPick(ctx.chat.state.threadRef, `${config.effective.harnessId}:${config.effective.modelId}`);
      }
      applySelectedRuntime(config, agent, false);
      const selected = currentModelOption();
      if (selected) rememberActiveTweaks(selected);
    } catch (e) {
      if (request !== runtimeRequest || scopeId !== ctx.chat.state.scopeId) return;
      composerState.error = errMessage(e, "Could not update the scope default.");
    }
    ctx.chat.drawActiveChat(agent);
  }

  function composerForm(agent: Agent, header: TemplateResult | typeof nothing = nothing): TemplateResult {
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
                activeRuntimeConfig?.effective.harnessId === option.harnessId &&
                activeRuntimeConfig.effective.modelId === option.model.id
              )
                selectModel(value, agent);
            },
          })}
        </label>
        <button type="button" @click=${() => void refreshRuntimeSelection(ctx.chat.state.scopeId, agent)}>
          Refresh models
        </button>
      </div>`;
    }
    const approvalPauses = ctx.chat.activePendingApprovals();
    const blockingPauses = approvalPauses.filter(approvalBlocksComposer);
    const runtimePending = activeRuntimeConfig === null;
    const inputBlocked = runtimePending || ctx.chat.state.resolvingApprovals.size > 0 || blockingPauses.length > 0;
    const attachingDisabled = inputBlocked;
    let placeholder = "Ask anything";
    if (inputBlocked) placeholder = runtimePending ? "Loading runtime…" : "Approve or deny to continue";
    else if (agent.state.isStreaming) placeholder = "Queue a message for after this turn…";
    let composerNotice: TemplateResult | typeof nothing = nothing;
    if (composerState.processingFiles) {
      composerNotice = html`<div class="composer-note">Preparing files...</div>`;
    } else if (!approvalPauses.length && runtimePending) {
      composerNotice = composerState.error
        ? html`<div class="composer-error">
            ${composerState.error}
            <button type="button" @click=${() => void refreshRuntimeSelection(ctx.chat.state.scopeId, agent)}>
              Retry
            </button>
          </div>`
        : html`<div class="composer-note">Loading runtime settings…</div>`;
    } else if (composerState.error) {
      composerNotice = html`<div class="composer-error">${composerState.error}</div>`;
    }

    const compact = Boolean(ctx.pane) || isPhone();
    const showRuntimeControls = !appState.me?.individualModelAuth;
    const runtimeControls = html`${harnessControl(agent, selectedModel, inputBlocked)}${loadoutControl(agent, selectedModel, inputBlocked)}`;
    return html`
      <form
        class="composer-wrap ${compact ? "compact" : ""}"
        @submit=${(e: Event) => submitComposer(e, agent)}
        @keydown=${(e: KeyboardEvent) => composerShortcut(e, agent, selectedModel, inputBlocked)}
      >
        ${header} ${slashMenu(agent)}
        ${
          activeRuntimeConfig?.upgradeAvailable
            ? html`<div class="runtime-upgrade">
                <span
                  >The org now recommends
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`)?.harnessLabel ?? activeRuntimeConfig.orgDefault.harnessId}
                  ·
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`)?.buttonLabel ?? activeRuntimeConfig.orgDefault.modelId}.</span
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
                  ${composerState.attachments.map(
                    (a) => html`
                      <span class="file-chip">
                        ${
                          pastedTextIds.has(a.id)
                            ? html`
                                <button
                                  type="button"
                                  class="chip-open"
                                  aria-label="View pasted text"
                                  ${tip("View pasted text")}
                                  @click=${() => openPasteView(a.id, agent)}
                                >
                                  ${icon(FileText, 14)}
                                  <span>${pasteChipLabel(a.extractedText?.length ?? 0)}</span>
                                </button>
                              `
                            : html`${icon(Paperclip, 14)}<span dir="auto">${a.fileName}</span>`
                        }
                        <button
                          type="button"
                          class="chip-x"
                          aria-label="Remove attachment"
                          ${tip("Remove")}
                          @click=${() => removeAttachment(a.id, agent)}
                        >
                          ${icon(X, 13)}
                        </button>
                      </span>
                    `,
                  )}
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
              class="icon-btn"
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
    const canQueue = Boolean(composerState.draft.trim() || composerState.attachments.length);
    return html`
      <button class="stop-btn" type="button" aria-label="Stop" ${tip("Stop")} @click=${() => stopStreaming(agent)}>
        ${icon(Square, 16)}
      </button>
      <button
        class="send-btn"
        type="submit"
        ${tip("Queue for after this turn")}
        aria-label="Queue for after this turn"
        ?disabled=${!canQueue}
      >
        ${icon(ArrowUp, 16)}
      </button>
    `;
  }

  function queuedStrip(agent: Agent): TemplateResult | typeof nothing {
    const queued = queuedRunsFor(ctx.chat.state.threadRef);
    if (!queued.length) return nothing;
    const steerable =
      agent.state.isStreaming && ctx.chat.hasLiveRun() && harnessSupportsSteer(currentModelOption()?.harnessId ?? "");
    const steerTip = (q: QueuedRun): string => {
      if (q.hasAttachments) return "This message carries files, which can't fold into a running task";
      if (steerable) return "Steer the running task with this instead of waiting";
      return "Nothing running can take this. It will go out as its own turn";
    };
    return html`
      <div class="queued-strip" role="list" aria-label="Queued messages">
        ${queued.map(
          (q) => html`
            <div class="queued-chip" role="listitem">
              <span class="queued-tag">Queued</span>
              <span class="queued-text" dir="auto" ${tip(q.text || "Files, no text")}
                >${q.text || (q.hasAttachments ? "(files)" : "")}</span
              >
              <button
                type="button"
                class="queued-steer"
                ?disabled=${!steerable || q.hasAttachments}
                ${tip(steerTip(q))}
                @click=${() => void steerQueued(agent, q)}
              >
                ${icon(CornerDownRight, 13)}<span>Steer</span>
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
  let loadoutSection: "effort" | "add" | null = null;
  let loadoutEditing = false;
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

  function seededLoadout(selected: ModelOption): LoadoutEntry[] {
    const latest = loadLoadout();
    if (latest.length) loadout = latest;
    const active = activeLoadoutEntry(selected);
    if (!loadout.length) {
      loadout = [active];
      const other = getModelOptions(scopeKey()).find((option) => option.harnessId !== selected.harnessId);
      if (other) loadout.push({ value: other.value, effort: defaultEffortForModel(other.model), fast: false });
    }
    return reconcileLoadout(loadout, getModelOptions(scopeKey()), active);
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
    composerState.effortLevel = effortLevelsForHarness(option.harnessId).some((level) => level.value === entry.effort)
      ? entry.effort
      : defaultEffortForModel(option.model);
    composerState.fastMode =
      entry.fast && harnessSupportsFastMode(option.harnessId) && modelSupportsFastMode(scopeKey(), option.model.id);
    persistPreference(EFFORT_STORAGE_KEY, composerState.effortLevel);
    persistPreference(FAST_MODE_STORAGE_KEY, composerState.fastMode ? "1" : "0");
    loadout = upsertLoadout(loadout, activeLoadoutEntry(option));
    saveLoadout(loadout);
    loadoutSection = null;
    composerState.openMenu = wasOpen ? "loadout" : null;
    ctx.chat.drawActiveChat(agent);
    placeLoadout();
  }

  function cycleEffort(agent: Agent, selected: ModelOption): void {
    const levels = effortLevelsForHarness(selected.harnessId);
    const at = levels.findIndex((level) => level.value === composerState.effortLevel);
    const next = levels[(at + 1) % levels.length];
    if (next) selectEffort(next.value, agent);
  }

  function composerShortcut(e: KeyboardEvent, agent: Agent, selected: ModelOption, disabled: boolean): void {
    if (disabled || e.defaultPrevented || !e.metaKey) return;
    const digit = Number.parseInt(e.key, 10);
    if (e.ctrlKey && !e.shiftKey && digit >= 1 && digit <= LOADOUT_CAP) {
      const entry = seededLoadout(selected)[digit - 1];
      if (!entry) return;
      e.preventDefault();
      applyLoadout(entry, agent);
    } else if (e.shiftKey && e.code === "KeyE") {
      e.preventDefault();
      toggleFastMode(agent);
    } else if (e.shiftKey && e.code === "Slash") {
      e.preventDefault();
      cycleEffort(agent, selected);
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
    loadout = seededLoadout(selected).filter((entry) => entry.value !== value);
    saveLoadout(loadout);
    ctx.chat.drawActiveChat();
    placeLoadout();
  }

  function moveLoadout(value: string, targetValue: string, selected: ModelOption): void {
    loadout = reorderLoadout(seededLoadout(selected), value, targetValue);
    saveLoadout(loadout);
    ctx.chat.drawActiveChat();
    placeLoadout();
  }

  function modelGlyph(option: ModelOption): TemplateResult {
    const provider = String(option.model.provider);
    const mark = modelMark(provider, 16) ?? modelMark(option.harnessId, 16);
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
    return html` <div
      class="loadout-row ${active ? "active" : ""}"
      @dragover=${(e: DragEvent) => {
        if (!draggedModel || draggedModel === entry.value) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        (e.currentTarget as HTMLElement).classList.add("drop-target");
      }}
      @dragleave=${(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-target")}
      @drop=${(e: DragEvent) => {
        if (!draggedModel) return;
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).classList.remove("drop-target");
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
        @click=${() => applyLoadout(entry, agent)}
      >
        ${modelGlyph(option)}
        <span class="loadout-name">${option.label}</span>
        <span class="loadout-meta">${effortText(settings.effort)}</span>
        ${settings.fast ? html`<span class="loadout-bolt" aria-label="Fast">${icon(Zap, 13)}</span>` : nothing}
        <span class="loadout-end"
          >${active ? icon(Check, 15) : html`<span class="loadout-shortcut">⌃⌘${at + 1}</span>`}</span
        >
      </button>
      ${
        loadoutEditing
          ? html`<button
              class="loadout-remove"
              type="button"
              aria-label=${`Remove ${option.label}`}
              ?disabled=${active}
              @click=${() => removeLoadoutEntry(entry.value, selected)}
            >
              ${icon(X, 14)}
            </button>`
          : nothing
      }
    </div>`;
  }

  function openLoadoutSection(section: "effort" | "add", keyboard = false): void {
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

  function closeLoadoutSection(): void {
    const previous = loadoutSection;
    loadoutSection = null;
    ctx.chat.drawActiveChat();
    placeLoadout();
    if (previous)
      requestAnimationFrame(() =>
        ctx.chat.state.host?.querySelector<HTMLElement>(`[data-loadout-section="${previous}"]`)?.focus(),
      );
  }

  function loadoutSubmenu(agent: Agent, selected: ModelOption): TemplateResult | typeof nothing {
    if (!loadoutSection) return nothing;
    const effort = loadoutSection === "effort";
    const entries = seededLoadout(selected);
    const query = composerState.menuQuery.trim().toLocaleLowerCase();
    const catalog = getModelOptions(scopeKey()).filter(
      (option) =>
        !entries.some((entry) => entry.value === option.value) &&
        (!query || `${option.harnessLabel} ${option.label}`.toLocaleLowerCase().includes(query)),
    );
    return html`<div
      class="loadout-submenu"
      role="menu"
      aria-label=${effort ? "Effort levels" : "Add models"}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "ArrowLeft" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          const previous = loadoutSection;
          closeLoadoutSection();
          requestAnimationFrame(() =>
            ctx.chat.state.host?.querySelector<HTMLElement>(`[data-loadout-section="${previous}"]`)?.focus(),
          );
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
                  @click=${() => {
                    selectEffort(level.value, agent);
                    closeLoadoutSection();
                  }}
                >
                  <span>${effortText(level.value)}</span
                  >${composerState.effortLevel === level.value ? icon(Check, 15) : nothing}
                </button>`,
            )
          : html` <label class="loadout-search"
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
                    @click=${() => addLoadoutEntry(option, agent)}
                  >
                    ${modelGlyph(option)}<span class="menu-option-copy"
                      ><span>${option.label}</span><span class="loadout-meta">${option.harnessLabel}</span></span
                    >${icon(Plus, 13)}
                  </button>`,
              )}
              ${catalog.length ? nothing : html`<div class="loadout-empty">No models found</div>`}`
      }
    </div>`;
  }

  function harnessControl(agent: Agent, selected: ModelOption, disabled: boolean): TemplateResult | typeof nothing {
    const harnesses = getHarnessOptions(scopeKey());
    if (harnesses.length < 2) return nothing;
    const open = composerState.openMenu === "harness";
    return html`<div class="menu-control harness-control" data-align="left">
      <button
        class="menu-button harness-button"
        type="button"
        aria-label=${`Harness: ${selected.harnessLabel}`}
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        ?disabled=${disabled}
        ${tip("Harness")}
        @click=${(e: Event) => {
          e.stopPropagation();
          composerState.openMenu = open ? null : "harness";
          ctx.chat.drawActiveChat(agent);
        }}
      >
        ${modelMark(selected.harnessId, 15) ?? nothing}<span class="menu-label">${selected.harnessLabel}</span
        >${icon(ChevronDown, 13)}
      </button>
      ${
        open
          ? html`<div class="menu-popover harness-popover" role="menu" @click=${(e: Event) => e.stopPropagation()}>
              ${harnesses.map(
                (harness) =>
                  html`<button
                    class="menu-option ${harness.value === selected.harnessId ? "active" : ""}"
                    type="button"
                    role="menuitemradio"
                    aria-checked=${harness.value === selected.harnessId ? "true" : "false"}
                    @click=${() => selectHarness(harness.value, agent)}
                  >
                    <span class="harness-option-copy"
                      >${modelMark(harness.value, 15) ?? html`<span class="harness-mark-slot"></span>`}<span
                        >${harness.label}</span
                      ></span
                    >
                    ${harness.value === selected.harnessId ? icon(Check, 15) : nothing}
                  </button>`,
              )}
            </div>`
          : nothing
      }
    </div>`;
  }

  function loadoutControl(agent: Agent, selected: ModelOption, disabled: boolean): TemplateResult {
    const open = composerState.openMenu === "loadout";
    const entries = seededLoadout(selected);
    const fastAvailable =
      harnessSupportsFastMode(selected.harnessId) && modelSupportsFastMode(scopeKey(), selected.model.id);
    const fastOn = fastAvailable && effectiveFastMode();
    const effective =
      (activeRuntimeConfig?.effective.effortLevel as EffortLevel | undefined) ?? defaultEffortForModel(selected.model);
    const runtimeToggled =
      activeRuntimeConfig !== null &&
      (selected.value !== defaultModelValue(scopeKey()) ||
        composerState.effortLevel !== effective ||
        fastOn !== (activeRuntimeConfig.effective.fastMode === true && fastAvailable));
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
            composerState.openMenu = "loadout";
            ctx.chat.drawActiveChat();
            placeLoadout();
            requestAnimationFrame(() => ctx.chat.state.host?.querySelector<HTMLElement>(".loadout-pick")?.focus());
          }
        }}
        @click=${(e: Event) => {
          e.stopPropagation();
          loadoutSection = null;
          loadoutEditing = false;
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
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  composerState.openMenu = null;
                  ctx.chat.drawActiveChat();
                  requestAnimationFrame(() =>
                    ctx.chat.state.host?.querySelector<HTMLElement>(".loadout-button")?.focus(),
                  );
                } else if (!(e.target as HTMLElement).closest(".loadout-submenu")) menuArrowKeys(e);
              }}
            >
              <div class="loadout-panel">
                <div class="loadout-list">${entries.map((entry, at) => loadoutRow(entry, at, selected, agent))}</div>
                <div class="loadout-submenu-anchor">
                  <button
                    class="loadout-add ${loadoutSection === "add" ? "open" : ""}"
                    type="button"
                    role="menuitem"
                    data-loadout-section="add"
                    aria-haspopup="menu"
                    aria-expanded=${loadoutSection === "add" ? "true" : "false"}
                    ?disabled=${entries.length >= LOADOUT_CAP}
                    @mouseenter=${() => {
                      if (!isPhone() && entries.length < LOADOUT_CAP) openLoadoutSection("add");
                    }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "ArrowRight") {
                        e.preventDefault();
                        openLoadoutSection("add", true);
                      }
                    }}
                    @click=${() => {
                      if (loadoutSection === "add") closeLoadoutSection();
                      else openLoadoutSection("add", true);
                    }}
                  >
                    ${icon(Plus, 16)}<span>Add models</span><span class="loadout-end">${icon(ChevronRight, 14)}</span>
                  </button>
                </div>
                ${loadoutEditing && entries.length >= LOADOUT_CAP ? html`<div class="loadout-empty">Remove a model to add another.</div>` : nothing}
                <div class="loadout-divider"></div>
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
                            if (!isPhone()) openLoadoutSection("effort");
                          }}
                          @keydown=${(e: KeyboardEvent) => {
                            if (e.key === "ArrowRight") {
                              e.preventDefault();
                              openLoadoutSection("effort", true);
                            }
                          }}
                          @click=${() => openLoadoutSection("effort", true)}
                        >
                          <span class="loadout-setting-label">Effort</span
                          ><span class="loadout-setting-value"
                            >${effortText(composerState.effortLevel)}${icon(ChevronRight, 14)}</span
                          >
                        </button>
                      </div>`
                    : nothing
                }
                ${
                  fastAvailable
                    ? html`<button
                        class="loadout-setting"
                        type="button"
                        role="menuitemcheckbox"
                        aria-label="Fast"
                        aria-checked=${fastOn ? "true" : "false"}
                        @click=${() => toggleFastMode(agent)}
                      >
                        <span class="loadout-setting-label">Fast</span
                        ><span class="loadout-setting-value"
                          ><span class="loadout-shortcut">⌘⇧E</span>
                          <span class="loadout-toggle ${fastOn ? "on" : ""}" aria-hidden="true"
                            ><span class="loadout-knob"></span
                          ></span>
                        </span>
                      </button>`
                    : nothing
                }
              </div>
              <div class="loadout-foot">
                <button
                  class="loadout-foot-btn"
                  type="button"
                  @click=${() => {
                    loadoutEditing = !loadoutEditing;
                    loadoutSection = null;
                    ctx.chat.drawActiveChat();
                    placeLoadout();
                  }}
                >
                  ${icon(Settings, 13)}${loadoutEditing ? "Done" : "Edit"}
                </button>
                ${harnessSupportsEffort(selected.harnessId) ? html`<button class="loadout-foot-cycle" type="button" @click=${() => cycleEffort(agent, selected)}><kbd class="loadout-kbd">⌘⇧/</kbd> Cycle effort</button>` : nothing}
              </div>
              ${
                loadoutEditing
                  ? html`<div class="loadout-edit-actions">
                      <span>Drag to reorder, or use ↑ ↓ on a handle.</span>
                      ${runtimeToggled ? html`<button type="button" @click=${() => changeScopeRuntime({ harnessId: selected.harnessId, modelId: selected.model.id, effortLevel: composerState.effortLevel, fastMode: fastOn }, agent)}>Make default</button>` : nothing}
                      ${activeRuntimeConfig?.scopeOverride ? html`<button type="button" @click=${() => changeScopeRuntime({ inherit: true }, agent)}>Use org default</button>` : nothing}
                    </div>`
                  : nothing
              }
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
      const inline = isPhone() || Math.max(roomLeft, roomRight) < width;
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
      ta.focus();
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
    composerState.draft = (e.currentTarget as HTMLTextAreaElement).value;
    persistDraft();
    const hadError = Boolean(composerState.error);
    composerState.error = "";
    composerState.slashDismissed = false;
    slashActiveIndex = 0;
    const armed = slashQuery(composerState.draft) !== null;
    if (armed && skillsCache === null && !skillsLoading) void loadSkills(agent);
    const popoverShown = Boolean(ctx.chat.state.host?.querySelector(".slash-popover"));
    if (armed || popoverShown || hadError) {
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
      activeRuntimeConfig !== null &&
      ctx.chat.state.resolvingApprovals.size === 0 &&
      !ctx.chat.hasUnresolvedApproval()
    );
  }

  function syncComposerControls(agent: Agent): void {
    if (!ctx.chat.state.host || agent !== ctx.chat.state.agent) return;
    const send = ctx.chat.state.host.querySelector<HTMLButtonElement>(".send-btn");
    if (send)
      send.disabled = agent.state.isStreaming
        ? !composerState.draft.trim() && !composerState.attachments.length
        : !composerCanSend();
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
    void ctx.chat.stopLiveRun().catch((e) => swallow("web-ui: abort signal", e));
    agent.abort();
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

  async function steerQueued(agent: Agent, queued: QueuedRun): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    if (!threadRef || queued.hasAttachments) return;
    if (!ctx.chat.hasLiveRun()) {
      composerState.error = "That turn already finished. This message will run as its own turn.";
      return ctx.chat.drawActiveChat(agent);
    }
    composerState.error = "";
    try {
      if (!(await withdrawRun(queued.runId))) return ctx.chat.drawActiveChat(agent);
    } catch (err) {
      const started = err instanceof ApiError && err.status === 409;
      const gone = err instanceof ApiError && err.status === 404;
      if (started) composerState.error = "That message already started. It's the running turn now.";
      else if (gone) composerState.error = "That message was already removed in another tab.";
      else composerState.error = errMessage(err, "Could not steer with that message.");
      if (started || gone) forgetQueuedRun(threadRef, queued.runId);
      return ctx.chat.drawActiveChat(agent);
    }
    forgetQueuedRun(threadRef, queued.runId);
    bumpSessionActivity(threadRef);
    agent.state.messages.push({
      role: "user",
      content: queued.text,
      timestamp: Date.now(),
      steered: true,
    } as unknown as AgentMessage);
    ctx.chat.drawActiveChat(agent);

    const sentAt = Date.now();
    const steerSessionId = ctx.chat.state.sessionId;
    const sinceSeq = steerSessionId
      ? await latestTranscriptSeq(steerSessionId).catch((e: unknown) => {
          swallow("web-ui: steer baseline", e);
          return undefined;
        })
      : undefined;
    try {
      const outcome = await ctx.chat.signalLiveRun("steer", queued.text);
      if (!outcome.ok) recoverEndedRunSteer(agent, queued.text, outcome);
    } catch (err) {
      if (steerSessionId && (await verifySteerDelivered(steerSessionId, queued.text, sentAt, undefined, sinceSeq))) {
        composerState.error = "";
        return ctx.chat.drawActiveChat(agent);
      }
      composerState.error = errMessage(err, "Could not steer the running task.");
      const last = agent.state.messages[agent.state.messages.length - 1] as
        { role?: string; content?: unknown } | undefined;
      if (last?.role === "user" && last.content === queued.text) agent.state.messages.pop();
      if (!(await enqueueTurn(agent, threadRef, queued.text))) composerState.draft = queued.text;
      ctx.chat.drawActiveChat(agent);
    }
  }

  // The run ended before the steer landed (the client believed it was still live).
  // Core either replayed the text as a fresh turn (`replayed`) or never stored it.
  // Either way the message must not silently vanish: detach from the stale stream,
  // then attach to the replay run — or resend the text as an ordinary prompt.
  function recoverEndedRunSteer(agent: Agent, text: string, outcome: { replayed?: boolean }): void {
    agent.abort();
    if (outcome.replayed) {
      const last = agent.state.messages[agent.state.messages.length - 1] as
        { role?: string; content?: unknown; steered?: boolean } | undefined;
      // It is now an ordinary user turn in the transcript, not a mid-run steer.
      if (last?.role === "user" && last.content === text && last.steered) delete last.steered;
      ctx.chat.drawActiveChat(agent);
      attachWhenIdle(agent, 0);
      return;
    }
    const last = agent.state.messages[agent.state.messages.length - 1] as
      { role?: string; content?: unknown } | undefined;
    if (last?.role === "user" && last.content === text) agent.state.messages.pop();
    composerState.draft = text;
    ctx.chat.drawActiveChat(agent);
    resendWhenIdle(agent, text, 0);
  }

  function attachWhenIdle(agent: Agent, attempt: number): void {
    if (agent !== ctx.chat.state.agent) return;
    if (agent.state.isStreaming) {
      if (attempt < 20) window.setTimeout(() => attachWhenIdle(agent, attempt + 1), 250);
      return;
    }
    ctx.chat.resumeIfIdle();
  }

  function resendWhenIdle(agent: Agent, text: string, attempt: number): void {
    if (agent !== ctx.chat.state.agent) return;
    if (agent.state.isStreaming) {
      if (attempt < 20) window.setTimeout(() => resendWhenIdle(agent, text, attempt + 1), 250);
      else {
        composerState.error =
          "Could not deliver the message. The running task ended mid-send. It is back in the composer.";
        ctx.chat.drawActiveChat(agent);
      }
      return;
    }
    if (composerState.draft === text) void sendPrompt(agent);
  }

  async function sendPrompt(agent: Agent): Promise<void> {
    if (!currentModelOption()) return;
    if (composerState.processingFiles) return;
    if (!activeRuntimeConfig) return;
    if (composerState.pasteView) closePasteView(agent);
    if (ctx.chat.state.resolvingApprovals.size > 0) return;
    if (ctx.chat.hasUnresolvedApproval()) return;
    if (agent.state.isStreaming) return queueDraft(agent);
    const text = composerState.draft.trim();
    if (!text && composerState.attachments.length === 0) return;
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

  async function loadAnyAttachment(file: File): Promise<Attachment> {
    try {
      const { loadAttachment } = await import("@earendil-works/pi-web-ui");
      return await loadAttachment(file);
    } catch {
      return {
        id: `${file.name}_${Date.now()}_${Math.random()}`,
        type: "document",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        content: await fileToBase64(file),
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
    dragDepth += 1;
    if (!composerState.dragging) {
      composerState.dragging = true;
      ctx.chat.drawActiveChat();
    }
  }

  function onDragOver(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && composerState.dragging) {
      composerState.dragging = false;
      ctx.chat.drawActiveChat();
    }
  }

  async function onDrop(e: DragEvent, agent: Agent): Promise<void> {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    composerState.dragging = false;
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
    const previousDefaultEffort = defaultEffortForModel(currentModelOption()?.model);
    if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, option.value);
    agent.state.model = option.model;
    if (composerState.effortLevel === previousDefaultEffort) {
      composerState.effortLevel = defaultEffortForModel(option.model);
      persistPreference(EFFORT_STORAGE_KEY, composerState.effortLevel);
    }
    composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectHarness(harnessId: string, agent: Agent): void {
    const selected = currentModelOption();
    if (!selected || selected.harnessId === harnessId) {
      composerState.openMenu = null;
      ctx.chat.drawActiveChat(agent);
      return;
    }
    const target = harnessTarget(getModelOptionsForHarness(harnessId, scopeKey()), selected.model.id, loadout);
    if (!target) return;
    selectModel(target.value, agent);
    if (!effortLevelsForHarness(harnessId).some((level) => level.value === composerState.effortLevel)) {
      composerState.effortLevel = defaultEffortForModel(target.model);
      persistPreference(EFFORT_STORAGE_KEY, composerState.effortLevel);
    }
    if (!harnessSupportsFastMode(harnessId) || !modelSupportsFastMode(scopeKey(), target.model.id)) {
      composerState.fastMode = false;
      persistPreference(FAST_MODE_STORAGE_KEY, "0");
    }
    composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectEffort(level: EffortLevel, agent: Agent): void {
    const selected = currentModelOption();
    if (!selected || !effortLevelsForHarness(selected.harnessId).some((option) => option.value === level)) return;
    composerState.effortLevel = level;
    persistPreference(EFFORT_STORAGE_KEY, level);
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
    persistPreference(FAST_MODE_STORAGE_KEY, composerState.fastMode ? "1" : "0");
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
    queuedStrip,
    queuedRunsFor,
    setQueuedRuns,
    resetComposer,
    focusComposerEnd,
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
