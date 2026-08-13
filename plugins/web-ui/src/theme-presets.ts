export const THEME_PRESETS = [
  { id: "graphite", label: "Graphite", colors: ["#f5f6f7", "#3f6f8f", "#202428"] },
  { id: "sinora", label: "Sinora", colors: ["#faf8f5", "#9b8fe8", "#7db87c"] },
  { id: "grove", label: "Grove", colors: ["#f5f4ef", "#477a62", "#b5844a"] },
  { id: "ocean", label: "Ocean", colors: ["#f2f7fa", "#287c9d", "#56a6b7"] },
  { id: "ember", label: "Ember", colors: ["#fbf6f1", "#b85f3c", "#d49a58"] },
  { id: "orchid", label: "Orchid", colors: ["#f8f5fa", "#8056a6", "#ba75a5"] },
] as const;

export type ThemePreset = (typeof THEME_PRESETS)[number]["id"];
export type ThemeMode = "light" | "dark";

export const THEME_PRESET_STORAGE_KEY = "webui:theme-preset";
export const DEFAULT_THEME_PRESET: ThemePreset = "graphite";
let projectThemeActive = false;
let projectThemeModeActive = false;
let projectThemeMode: ThemeMode | null = null;
let projectThemeObserver: MutationObserver | null = null;

function enforceProjectThemeMode(): void {
  if (!projectThemeMode) return;
  const shouldBeDark = projectThemeMode === "dark";
  if (document.documentElement.classList.contains("dark") !== shouldBeDark)
    document.documentElement.classList.toggle("dark", shouldBeDark);
}

function observeProjectThemeMode(): void {
  if (projectThemeObserver || typeof MutationObserver === "undefined") return;
  projectThemeObserver = new MutationObserver(enforceProjectThemeMode);
  projectThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

export function normalizeThemePreset(value: string | null): ThemePreset {
  return THEME_PRESETS.some((preset) => preset.id === value) ? (value as ThemePreset) : DEFAULT_THEME_PRESET;
}

export function loadThemePreset(): ThemePreset {
  try {
    return normalizeThemePreset(localStorage.getItem(THEME_PRESET_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PRESET;
  }
}

export function applyThemePreset(preset: ThemePreset, persist = true): void {
  if (persist) {
    try {
      localStorage.setItem(THEME_PRESET_STORAGE_KEY, preset);
    } catch {
      void 0;
    }
    if (projectThemeActive) return;
  }
  document.documentElement.dataset.themePreset = preset;
}

function personalThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    void 0;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyProjectTheme(preset?: ThemePreset | null, mode?: ThemeMode | null): void {
  projectThemeActive = preset !== null;
  applyThemePreset(preset === null ? loadThemePreset() : (preset ?? DEFAULT_THEME_PRESET), false);
  projectThemeModeActive = mode != null;
  projectThemeMode = mode ?? null;
  if (mode) document.documentElement.dataset.projectThemeMode = mode;
  else delete document.documentElement.dataset.projectThemeMode;
  const effective = mode === null || mode === undefined ? personalThemeMode() : mode;
  document.documentElement.classList.toggle("dark", effective === "dark");
  if (projectThemeModeActive) observeProjectThemeMode();
}

export function projectThemeModeIsActive(): boolean {
  return projectThemeModeActive;
}
