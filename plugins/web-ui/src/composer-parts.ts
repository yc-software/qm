import type { TemplateResult, nothing } from "lit";
import type { IconNode } from "lucide";
import type { ComposerVariant } from "./composer-variant";
import type { ModelOption } from "./model-options";

export type Tpl = TemplateResult | typeof nothing;

export interface ComposerParts {
  variant: ComposerVariant;
  header: Tpl;
  slashMenu: Tpl;
  upgradeNotice: Tpl;
  attachments: Tpl;
  approvals: Tpl;
  notice: Tpl;
  textarea: Tpl;
  fileInput: TemplateResult;
  pasteDialog: Tpl;
  defaultButtons: Tpl;
  sendControls: TemplateResult;
  settingsMenu: TemplateResult;
  menuControl(args: {
    kind: string;
    glyph?: IconNode;
    label: string;
    suffix?: string;
    title: string;
    selected: string;
    options: Array<{ value: string; label: string; groupLabel?: string }>;
    searchable?: boolean;
    disabled?: boolean;
    align?: "left" | "right";
    onSelect: (value: string) => void;
  }): TemplateResult;
  placeholder: string;
  draft: string;
  inputBlocked: boolean;
  attachingDisabled: boolean;
  compact: boolean;
  onSubmit(e: Event): void;
  pickFiles(): void;
  insertText(text: string): void;
  send: { canSend: boolean; canQueue: boolean; streaming: boolean; stop(): void };
  models: {
    all: ModelOption[];
    selected: ModelOption;
    select(value: string): void;
    harnesses: Array<{ value: string; label: string }>;
    selectHarness(harnessId: string): void;
    supportsFast(modelId: string): boolean;
  };
  effort: {
    available: boolean;
    level: string;
    label: string;
    levels: ReadonlyArray<{ value: string; label: string }>;
    select(level: string): void;
  };
  fast: { supported: boolean; available: boolean; on: boolean; toggle(): void };
  menu: {
    open: string | null;
    toggle(e: Event, kind: string): void;
    close(): void;
    query: string;
    setQuery(query: string, kind: string): void;
  };
}

export interface ComposerVariantModule {
  render(parts: ComposerParts): TemplateResult;
  topbar?(parts: ComposerParts): Tpl;
}
