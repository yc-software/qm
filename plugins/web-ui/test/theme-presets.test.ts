import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THEME_PRESET,
  normalizeThemePreset,
  applyProjectTheme,
  THEME_PRESETS,
  THEME_PRESET_STORAGE_KEY,
} from "../src/theme-presets.ts";

test("offers six named theme presets", () => {
  assert.deepEqual(
    THEME_PRESETS.map(({ id, label }) => ({ id, label })),
    [
      { id: "graphite", label: "Graphite" },
      { id: "sinora", label: "Sinora" },
      { id: "grove", label: "Grove" },
      { id: "ocean", label: "Ocean" },
      { id: "ember", label: "Ember" },
      { id: "orchid", label: "Orchid" },
    ],
  );
  assert.equal(DEFAULT_THEME_PRESET, "graphite");
  assert.equal(normalizeThemePreset("neon"), "graphite");
  assert.equal(THEME_PRESET_STORAGE_KEY, "webui:theme-preset");
});

test("project mode overrides and then restores the personal appearance", () => {
  const values = new Map<string, string>([
    ["theme", "light"],
    [THEME_PRESET_STORAGE_KEY, "grove"],
  ]);
  let dark = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        dataset: {} as Record<string, string>,
        classList: {
          toggle: (_name: string, enabled: boolean) => {
            dark = enabled;
          },
        },
      },
    },
  });
  applyProjectTheme("ocean", "dark");
  assert.equal(document.documentElement.dataset.themePreset, "ocean");
  assert.equal(document.documentElement.dataset.projectThemeMode, "dark");
  assert.equal(dark, true);
  applyProjectTheme(null);
  assert.equal(document.documentElement.dataset.themePreset, "grove");
  assert.equal(document.documentElement.dataset.projectThemeMode, undefined);
  assert.equal(dark, false);
});

test("project mode reasserts itself after another theme listener changes the root class", () => {
  let dark = false;
  let observer: (() => void) | undefined;
  Object.defineProperty(globalThis, "MutationObserver", {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        observer = callback;
      }
      observe(): void {}
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "light", setItem: () => undefined },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        dataset: {} as Record<string, string>,
        classList: {
          contains: () => dark,
          toggle: (_name: string, enabled: boolean) => {
            dark = enabled;
          },
        },
      },
    },
  });
  applyProjectTheme("ocean", "dark");
  dark = false;
  observer?.();
  assert.equal(dark, true);
});
