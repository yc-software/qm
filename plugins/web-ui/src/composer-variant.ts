export const COMPOSER_VARIANTS = [
  { id: "bui", label: "QM" },
  { id: "scira", label: "Scira" },
  { id: "openwebui", label: "Open WebUI" },
  { id: "librechat", label: "LibreChat" },
  { id: "cline", label: "Cline" },
  { id: "kilo", label: "Kilo Code" },
  { id: "assistantui", label: "assistant-ui" },
  { id: "vovk", label: "Vovk" },
  { id: "dqnamo", label: "dqnamo" },
  { id: "beui", label: "beUI" },
  { id: "headless", label: "chat-input" },
  { id: "modal", label: "Modal" },
] as const;

export type ComposerVariant = (typeof COMPOSER_VARIANTS)[number]["id"];

const STORAGE_KEY = "web-ui:composer-variant";

function isVariant(value: unknown): value is ComposerVariant {
  return COMPOSER_VARIANTS.some((v) => v.id === value);
}

function readInitial(): ComposerVariant {
  if (typeof location === "undefined") return "bui";
  const fromUrl = new URL(location.href).searchParams.get("composer");
  if (isVariant(fromUrl)) {
    persist(fromUrl);
    return fromUrl;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isVariant(stored)) return stored;
  } catch {
    void 0;
  }
  return "bui";
}

function persist(variant: ComposerVariant): void {
  try {
    if (variant === "bui") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, variant);
  } catch {
    void 0;
  }
}

let current: ComposerVariant = readInitial();

export function composerVariant(): ComposerVariant {
  return current;
}

export function setComposerVariant(variant: ComposerVariant): void {
  current = variant;
  persist(variant);
}
