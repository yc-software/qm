import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { FolderDropError, folderToZipFile, isFolderReadError, splitDropItems, type DropEntryLike } from "./folder-drop";
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import {
  ArrowUp,
  Box,
  Brain,
  Check,
  ChevronDown,
  CornerDownRight,
  FileText,
  Paperclip,
  SlidersHorizontal,
  Square,
  X,
  Zap,
  type IconNode,
} from "lucide";
import {
  api,
  ApiError,
  fetchRuntimeConfig,
  queueTurn,
  updateRuntimeConfig,
  withdrawRun,
  type ApprovalDecision,
  type PendingApproval,
  type QueuedRun,
  type RuntimeConfig,
} from "./core-bridge";
import { errMessage, swallow } from "../../chassis/src/errors";
import { icon } from "./ui";
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

export type ComposerMenu = "effort" | "harness" | "model" | "settings";

const LEGACY_MODEL_STORAGE_KEY = "web-ui:model";
const THREAD_PICKS_STORAGE_KEY = "web-ui:model-picks";
const THREAD_PICKS_CAP = 50;
const FAST_MODE_STORAGE_KEY = "web-ui:fast-mode";
const EFFORT_STORAGE_KEY = "web-ui:effort";

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

export function carryModelPick(fromThreadRef: string | null, toThreadRef: string): void {
  const pick = fromThreadRef ? threadModelPicks.get(fromThreadRef) : undefined;
  if (pick) rememberThreadPick(toThreadRef, pick);
}

function modelOptionFor(value: ModelOptionValue, scopeKey?: string | null): ModelOption {
  const options = getModelOptions(scopeKey);
  return (
    options.find((option) => option.value === value) ??
    options.find((option) => option.value === defaultModelValue()) ??
    options[0]
  );
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
    slashDismissed: false,
    effortLevel: loadStoredEffort(defaultEffortForModel(modelOptionFor(defaultModelValue()).model)),
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
  let fastModeCharging = false;
  let orgFastModeDefault = false;
  let fastModeChargeTimer: ReturnType<typeof setTimeout> | null = null;

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

  function currentModelOption(): ModelOption {
    const picked = ctx.chat.state.threadRef ? threadModelPicks.get(ctx.chat.state.threadRef) : undefined;
    return modelOptionFor(picked ?? defaultModelValue(scopeKey()), scopeKey());
  }

  async function refreshRuntimeSelection(scopeId: string | null, agent?: Agent): Promise<void> {
    const request = ++runtimeRequest;
    const scopeKey = runtimeScopeKey(scopeId);
    const seeded = scopeKey !== null && seededRuntime?.scopeId === scopeKey ? seededRuntime.config : null;
    if (seeded) {
      applySelectedRuntime(seeded, agent);
      return;
    }
    activeRuntimeConfig = null;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    const config = await fetchRuntimeConfig(scopeId);
    if (request !== runtimeRequest) return;
    if (!config) {
      composerState.error = "Could not load runtime settings.";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    applySelectedRuntime(config, agent);
  }

  function applySelectedRuntime(config: RuntimeConfig, agent?: Agent): void {
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
    composerState.effortLevel =
      (config.effective.effortLevel as EffortLevel | undefined) ?? defaultEffortForModel(currentModelOption().model);
    composerState.fastMode =
      config.effective.fastMode === true && modelSupportsFastMode(scopeKey(), config.effective.modelId);
    if (agent && (!ctx.chat.state.threadRef || !threadModelPicks.has(ctx.chat.state.threadRef)))
      agent.state.model = currentModelOption().model;
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
      applySelectedRuntime(config, agent);
    } catch (e) {
      if (request !== runtimeRequest || scopeId !== ctx.chat.state.scopeId) return;
      composerState.error = errMessage(e, "Could not update the scope default.");
    }
    ctx.chat.drawActiveChat(agent);
  }

  function composerForm(agent: Agent): TemplateResult {
    const selectedModel = currentModelOption();
    const effortAvailable = harnessSupportsEffort(selectedModel.harnessId);
    const fastSupported = harnessSupportsFastMode(selectedModel.harnessId);
    const fastAvailable = fastSupported && modelSupportsFastMode(scopeKey(), selectedModel.model.id);
    const fastOn = fastAvailable && effectiveFastMode();
    const fastCharging = fastModeCharging && fastOn;
    let fastTitle = "Fast mode is only available on Opus models";
    if (fastAvailable) fastTitle = fastOn ? "Fast mode active" : "Fast mode";
    const approvalPauses = ctx.chat.activePendingApprovals();
    const runtimePending = activeRuntimeConfig === null;
    const effectiveEffort =
      (activeRuntimeConfig?.effective.effortLevel as EffortLevel | undefined) ??
      defaultEffortForModel(selectedModel.model);
    const effectiveFast = activeRuntimeConfig?.effective.fastMode === true && fastAvailable;
    const runtimeToggled =
      !runtimePending &&
      (selectedModel.value !== defaultModelValue(scopeKey()) ||
        composerState.effortLevel !== effectiveEffort ||
        fastOn !== effectiveFast);
    const inputBlocked = runtimePending || ctx.chat.state.resolvingApprovals.size > 0 || approvalPauses.length > 0;
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
    return html`
      <form class="composer-wrap" @submit=${(e: Event) => submitComposer(e, agent)}>
        ${slashMenu(agent)}
        ${
          activeRuntimeConfig?.upgradeAvailable
            ? html`<div class="runtime-upgrade">
                <span
                  >The org now recommends
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`).harnessLabel}
                  ·
                  ${modelOptionFor(`${activeRuntimeConfig.orgDefault.harnessId}:${activeRuntimeConfig.orgDefault.modelId}`).buttonLabel}.</span
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
                                  title="View pasted text"
                                  @click=${() => openPasteView(a.id, agent)}
                                >
                                  ${icon(FileText, 14)}
                                  <span>${pasteChipLabel(a.extractedText?.length ?? 0)}</span>
                                </button>
                              `
                            : html`${icon(Paperclip, 14)}<span>${a.fileName}</span>`
                        }
                        <button
                          type="button"
                          class="chip-x"
                          title="Remove"
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
        ${queuedStrip(agent)}
        ${
          approvalPauses.length
            ? composerApprovalPanel(approvalPauses)
            : html`
                <textarea
                  class="composer-input"
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
              title="Attach files"
              ?disabled=${attachingDisabled}
              @click=${() => pickFiles()}
            >
              ${icon(Paperclip, 18)}
            </button>
            ${
              ctx.pane
                ? nothing
                : html`
                    ${
                      effortAvailable
                        ? menuControl({
                            kind: "effort",
                            glyph: Brain,
                            label: effortLabel(composerState.effortLevel),
                            title: "Effort",
                            selected: composerState.effortLevel,
                            options: EFFORT_LEVELS,
                            disabled: inputBlocked,
                            onSelect: (value: string) => selectEffort(value as EffortLevel, agent),
                          })
                        : nothing
                    }
                    ${
                      fastSupported
                        ? html`<button
                            class="fast-toggle ${fastOn ? "active" : ""} ${fastCharging ? "charging" : ""} ${fastAvailable ? "" : "unavailable"}"
                            type="button"
                            title=${fastTitle}
                            aria-label=${fastTitle}
                            aria-pressed=${fastOn ? "true" : "false"}
                            aria-disabled=${fastAvailable ? "false" : "true"}
                            ?disabled=${inputBlocked}
                            @click=${() => toggleFastMode(agent)}
                          >
                            ${icon(Zap, 15)}
                            <span class="fast-label">Fast</span>
                          </button>`
                        : nothing
                    }
                  `
            }
          </div>
          <div class="composer-right">
            ${
              ctx.pane
                ? settingsControl(agent, selectedModel, inputBlocked)
                : html`
                    ${
                      runtimeToggled
                        ? html`<button
                            class="runtime-default-btn"
                            type="button"
                            aria-label="Make default"
                            data-mobile-label="Default"
                            title="Use this harness, model, effort, and fast setting as the default for this scope"
                            ?disabled=${inputBlocked}
                            @click=${() => changeScopeRuntime({ harnessId: selectedModel.harnessId, modelId: selectedModel.model.id, effortLevel: composerState.effortLevel, fastMode: fastOn }, agent)}
                          >
                            Make default
                          </button>`
                        : nothing
                    }
                    ${
                      runtimeToggled && activeRuntimeConfig?.scopeOverride
                        ? html`<button
                            class="runtime-default-btn"
                            type="button"
                            aria-label="Use org default"
                            data-mobile-label="Org default"
                            ?disabled=${inputBlocked}
                            @click=${() => changeScopeRuntime({ inherit: true }, agent)}
                          >
                            Use org default
                          </button>`
                        : nothing
                    }
                    ${menuControl({
                      kind: "model",
                      label: selectedModel.buttonLabel,
                      title: "Model",
                      selected: selectedModel.value,
                      align: "right",
                      options: getModelOptionsForHarness(selectedModel.harnessId, scopeKey()).map((option) => ({
                        value: option.value,
                        label: option.label,
                      })),
                      disabled: inputBlocked,
                      onSelect: (value: string) => selectModel(value, agent),
                    })}
                    ${menuControl({
                      kind: "harness",
                      label: selectedModel.harnessLabel,
                      title: "Harness",
                      selected: selectedModel.harnessId,
                      align: "right",
                      options: getHarnessOptions(scopeKey()),
                      disabled: inputBlocked,
                      onSelect: (value: string) => selectHarness(value, agent),
                    })}
                  `
            }
            ${sendControls(agent)}
          </div>
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
            <button class="chip-x" type="button" aria-label="Close" title="Close" @click=${() => closePasteView(agent)}>
              ${icon(X, 16)}
            </button>
          </div>
          <textarea
            class="paste-dialog-text"
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
      return html`<button class="send-btn" type="submit" title="Send" ?disabled=${!composerCanSend()}>
        ${icon(ArrowUp, 17)}
      </button>`;
    }
    const canQueue = Boolean(composerState.draft.trim());
    return html`
      <button class="stop-btn" type="button" title="Stop" aria-label="Stop" @click=${() => stopStreaming(agent)}>
        ${icon(Square, 16)}
      </button>
      <button
        class="send-btn"
        type="submit"
        title="Queue for after this turn"
        aria-label="Queue for after this turn"
        ?disabled=${!canQueue}
      >
        ${icon(ArrowUp, 17)}
      </button>
    `;
  }

  function queuedStrip(agent: Agent): TemplateResult | typeof nothing {
    const queued = queuedRunsFor(ctx.chat.state.threadRef);
    if (!queued.length) return nothing;
    const steerable =
      agent.state.isStreaming && ctx.chat.hasLiveRun() && harnessSupportsSteer(currentModelOption().harnessId);
    return html`
      <div class="queued-strip" role="list" aria-label="Queued messages">
        ${queued.map(
          (q) => html`
            <div class="queued-chip" role="listitem">
              <span class="queued-tag">Queued</span>
              <span class="queued-text" title=${q.text}>${q.text}</span>
              <button
                type="button"
                class="queued-steer"
                ?disabled=${!steerable}
                title=${
                  steerable
                    ? "Steer the running task with this instead of waiting"
                    : "Nothing running can take this — it will go out as its own turn"
                }
                @click=${() => void steerQueued(agent, q)}
              >
                ${icon(CornerDownRight, 13)}<span>Steer</span>
              </button>
              <button
                type="button"
                class="chip-x"
                title="Remove"
                aria-label="Remove queued message"
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
    const busy = ctx.chat.state.resolvingApprovals.size > 0;
    const decide = (decision: ApprovalDecision): void => {
      if (!busy) ctx.chat.resolveCommandApproval(decision);
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
                ?disabled=${busy}
                @click=${() => decide({ requestId: a.requestId, approved: false })}
              >
                Deny
              </button>
              <button
                class="approval-btn"
                type="button"
                ?disabled=${busy}
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
                      ?disabled=${busy}
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
                      ?disabled=${busy}
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

  function settingsControl(agent: Agent, selected: ModelOption, disabled: boolean): TemplateResult {
    const open = composerState.openMenu === "settings";
    const fastAvailable =
      harnessSupportsFastMode(selected.harnessId) && modelSupportsFastMode(scopeKey(), selected.model.id);
    const fastOn = fastAvailable && effectiveFastMode();
    const summary = `${selected.buttonLabel} · ${effortLabel(composerState.effortLevel)}${fastOn ? " · Fast" : ""}`;
    return html`
      <div class="menu-control settings-control ${open ? "open" : ""}" data-align="right">
        <button
          class="menu-button settings-button"
          type="button"
          title="Session settings — ${summary}"
          aria-label="Session settings — ${summary}"
          aria-haspopup="menu"
          aria-expanded=${open ? "true" : "false"}
          aria-controls="composer-settings-menu"
          ?disabled=${disabled}
          @click=${(e: Event) => toggleComposerMenu(e, "settings")}
        >
          ${icon(SlidersHorizontal, 16)}
        </button>
        ${
          open && !disabled
            ? html`
                <div
                  class="menu-popover settings-popover"
                  id="composer-settings-menu"
                  role="menu"
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  <div class="menu-title">Model</div>
                  ${getModelOptionsForHarness(selected.harnessId, scopeKey()).map(
                    (option) => html`
                      <button
                        class="menu-option ${option.value === selected.value ? "active" : ""}"
                        type="button"
                        role="menuitemradio"
                        aria-checked=${option.value === selected.value ? "true" : "false"}
                        @click=${() => selectModel(option.value, agent)}
                      >
                        <span class="menu-option-copy">
                          <span class="menu-option-label">${option.label}</span>
                        </span>
                        ${option.value === selected.value ? icon(Check, 15) : nothing}
                      </button>
                    `,
                  )}
                  <div class="menu-title">Harness</div>
                  <div class="settings-seg" role="group" aria-label="Harness">
                    ${getHarnessOptions(scopeKey()).map(
                      (option) => html`
                        <button
                          class="settings-chip ${option.value === selected.harnessId ? "active" : ""}"
                          type="button"
                          aria-pressed=${option.value === selected.harnessId ? "true" : "false"}
                          @click=${() => selectHarness(option.value, agent)}
                        >
                          ${option.label}
                        </button>
                      `,
                    )}
                  </div>
                  ${
                    harnessSupportsEffort(selected.harnessId)
                      ? html`
                          <div class="menu-title">Effort</div>
                          <div class="settings-seg" role="group" aria-label="Effort">
                            ${EFFORT_LEVELS.map(
                              (option) => html`
                                <button
                                  class="settings-chip ${option.value === composerState.effortLevel ? "active" : ""}"
                                  type="button"
                                  aria-pressed=${option.value === composerState.effortLevel ? "true" : "false"}
                                  @click=${() => selectEffort(option.value, agent)}
                                >
                                  ${option.label}
                                </button>
                              `,
                            )}
                          </div>
                        `
                      : nothing
                  }
                  ${
                    fastAvailable
                      ? html`
                          <button
                            class="menu-option ${fastOn ? "active" : ""}"
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked=${fastOn ? "true" : "false"}
                            @click=${() => toggleFastMode(agent)}
                          >
                            <span class="menu-option-copy">
                              <span class="menu-option-label">${icon(Zap, 13)} Fast mode</span>
                            </span>
                            ${fastOn ? icon(Check, 15) : nothing}
                          </button>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  function menuControl(args: {
    kind: ComposerMenu;
    glyph?: IconNode;
    label: string;
    title: string;
    selected: string;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
    align?: "left" | "right";
    onSelect: (value: string) => void;
  }): TemplateResult {
    const open = composerState.openMenu === args.kind;
    const menuId = `composer-${args.kind}-menu`;
    let controlClass = "";
    if (args.kind === "model") controlClass = "model-control";
    else if (args.kind === "harness") controlClass = "harness-control";
    return html`
      <div class="menu-control ${controlClass}" data-align=${args.align ?? "left"}>
        <button
          class="menu-button"
          type="button"
          title=${args.title}
          aria-haspopup="menu"
          aria-expanded=${open ? "true" : "false"}
          aria-controls=${menuId}
          ?disabled=${args.disabled}
          @click=${(e: Event) => toggleComposerMenu(e, args.kind)}
        >
          ${args.glyph ? icon(args.glyph, 16) : nothing}
          <span class="menu-label">${args.label}</span>
          ${icon(ChevronDown, 14)}
        </button>
        ${
          open && !args.disabled
            ? html`
                <div class="menu-popover" id=${menuId} role="menu" @click=${(e: Event) => e.stopPropagation()}>
                  <div class="menu-title">${args.title}</div>
                  ${args.options.map(
                    (option) => html`
                      <button
                        class="menu-option ${option.value === args.selected ? "active" : ""}"
                        type="button"
                        role="menuitemradio"
                        aria-checked=${option.value === args.selected ? "true" : "false"}
                        @click=${() => args.onSelect(option.value)}
                      >
                        <span class="menu-option-copy">
                          <span class="menu-option-label">${option.label}</span>
                        </span>
                        ${option.value === args.selected ? icon(Check, 15) : nothing}
                      </button>
                    `,
                  )}
                </div>
              `
            : nothing
        }
      </div>
    `;
  }

  function toggleComposerMenu(e: Event, kind: ComposerMenu): void {
    e.stopPropagation();
    composerState.openMenu = composerState.openMenu === kind ? null : kind;
    ctx.chat.drawActiveChat();
  }

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
        title=${m.skill.description}
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
    if (send) send.disabled = agent.state.isStreaming ? !composerState.draft.trim() : !composerCanSend();
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
    void ctx.chat.signalLiveRun("abort").catch((e) => swallow("web-ui: abort signal", e));
    agent.abort();
  }

  async function queueDraft(agent: Agent): Promise<void> {
    const threadRef = ctx.chat.state.threadRef;
    const text = composerState.draft.trim();
    if (!text || !threadRef) return;
    clearActiveDraft();
    composerState.draft = "";
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    if (!(await enqueueTurn(agent, threadRef, text))) composerState.draft = text;
    ctx.chat.drawActiveChat(agent);
  }

  async function enqueueTurn(agent: Agent, threadRef: string, text: string): Promise<boolean> {
    try {
      const queued = await queueTurn(threadRef, text, agent, ctx.chat.currentTurnOptions);
      setQueuedRuns(threadRef, [...queuedRunsFor(threadRef), queued]);
      bumpSessionActivity(threadRef);
      return true;
    } catch (err) {
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
    if (!threadRef) return;
    if (!ctx.chat.hasLiveRun()) {
      composerState.error = "That turn already finished — this message will run as its own turn.";
      return ctx.chat.drawActiveChat(agent);
    }
    composerState.error = "";
    try {
      if (!(await withdrawRun(queued.runId))) return ctx.chat.drawActiveChat(agent);
    } catch (err) {
      const started = err instanceof ApiError && err.status === 409;
      const gone = err instanceof ApiError && err.status === 404;
      if (started) composerState.error = "That message already started — it's the running turn now.";
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

    try {
      const outcome = await ctx.chat.signalLiveRun("steer", queued.text);
      if (!outcome.ok) recoverEndedRunSteer(agent, queued.text, outcome);
    } catch (err) {
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
          "Could not deliver the message — the running task ended mid-send. It is back in the composer.";
        ctx.chat.drawActiveChat(agent);
      }
      return;
    }
    if (composerState.draft === text) void sendPrompt(agent);
  }

  async function sendPrompt(agent: Agent): Promise<void> {
    if (composerState.processingFiles) return;
    if (!activeRuntimeConfig && !agent.state.isStreaming) return;
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
    ctx.chat.notePendingSessionOnSend();
    clearActiveDraft();
    resetComposer();
    ctx.chat.drawActiveChat(agent);
    clearComposerDom(agent);
    try {
      if (attachments.length) {
        await agent.prompt({ role: "user-with-attachments", content: text, attachments, timestamp: Date.now() });
      } else {
        await agent.prompt(text);
      }
    } catch (err) {
      ctx.chat.state.pendingSend = null;
      if (ctx.chat.state.threadRef && ctx.chat.state.sessionId === null) dropPendingSession(ctx.chat.state.threadRef);
      renderList();
      composerState.error = errMessage(err, "Could not send message.");
      ctx.chat.drawActiveChat(agent);
    }
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

  async function addFiles(files: File[], agent: Agent, folders: DropEntryLike[] = []): Promise<void> {
    if (
      (!files.length && !folders.length) ||
      ctx.chat.hasUnresolvedApproval() ||
      ctx.chat.state.resolvingApprovals.size > 0
    )
      return;
    if (composerState.processingFiles) {
      composerState.error = "Still preparing the previous drop — try again in a moment.";
      ctx.chat.drawActiveChat(agent);
      return;
    }
    composerState.processingFiles = true;
    composerState.error = "";
    ctx.chat.drawActiveChat(agent);
    try {
      const zipped: File[] = [];
      for (const folder of folders) zipped.push(await folderToZipFile(folder));
      const loaded = await Promise.all([...files, ...zipped].map((file) => loadAnyAttachment(file)));
      composerState.attachments = [...composerState.attachments, ...loaded];
    } catch (err) {
      if (err instanceof FolderDropError) composerState.error = err.message;
      else if (isFolderReadError(err))
        composerState.error =
          "That drop included a folder this browser can't read — zip it and drop the archive instead.";
      else composerState.error = errMessage(err, "Could not attach that file.");
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
    const previousDefaultEffort = defaultEffortForModel(currentModelOption().model);
    if (ctx.chat.state.threadRef) rememberThreadPick(ctx.chat.state.threadRef, option.value);
    agent.state.model = option.model;
    if (composerState.effortLevel === previousDefaultEffort) {
      composerState.effortLevel = defaultEffortForModel(option.model);
      persistPreference(EFFORT_STORAGE_KEY, composerState.effortLevel);
    }
    if (composerState.openMenu !== "settings") composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function selectHarness(harnessId: string, agent: Agent): void {
    const current = currentModelOption();
    const options = getModelOptionsForHarness(harnessId, scopeKey());
    const option = options.find((candidate) => candidate.model.id === current.model.id) ?? options[0];
    if (option) selectModel(option.value, agent);
  }

  function selectEffort(level: EffortLevel, agent: Agent): void {
    composerState.effortLevel = level;
    persistPreference(EFFORT_STORAGE_KEY, level);
    if (composerState.openMenu !== "settings") composerState.openMenu = null;
    ctx.chat.drawActiveChat(agent);
  }

  function toggleFastMode(agent: Agent): void {
    if (ctx.chat.hasUnresolvedApproval() || ctx.chat.state.resolvingApprovals.size > 0) return;
    if (!modelSupportsFastMode(scopeKey(), currentModelOption().model.id)) return;
    composerState.fastMode = !effectiveFastMode();
    persistPreference(FAST_MODE_STORAGE_KEY, composerState.fastMode ? "1" : "0");
    if (fastModeChargeTimer) {
      clearTimeout(fastModeChargeTimer);
      fastModeChargeTimer = null;
    }
    fastModeCharging = composerState.fastMode === true;
    ctx.chat.drawActiveChat(agent);
    if (fastModeCharging) {
      fastModeChargeTimer = setTimeout(() => {
        fastModeCharging = false;
        fastModeChargeTimer = null;
        if (agent === ctx.chat.state.agent) ctx.chat.drawActiveChat(agent);
      }, 760);
    }
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
      ta.style.height = "auto";
      const cap = parseFloat(getComputedStyle(ta).maxHeight) || 180;
      const content = ta.scrollHeight;
      ta.style.height = `${Math.min(cap, Math.max(ctx.pane ? 0 : 48, content))}px`;
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
    if (fastModeChargeTimer !== null) clearTimeout(fastModeChargeTimer);
  }

  return {
    state: composerState,
    composerForm,
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
