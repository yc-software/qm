export function applyWindowGlass(page, mode, platform = process.platform) {
  if (page.isDestroyed?.()) return;
  if (platform !== "darwin") return;
  const on = mode === "light" || mode === "dark";
  let native = false;
  if (
    on &&
    typeof page.isGlassEffectSupported === "function" &&
    page.isGlassEffectSupported() &&
    typeof page.setGlassEffect === "function"
  ) {
    try {
      page.setVibrancy?.(null);
      page.setGlassEffect({ style: mode === "dark" ? "regular" : "clear" });
      native = true;
    } catch {
      native = false;
    }
  } else if (!on && typeof page.setGlassEffect === "function") {
    try {
      page.setGlassEffect(null);
    } catch {
      void 0;
    }
  }
  if (!native && typeof page.setVibrancy === "function") {
    page.setVibrancy(on ? (mode === "dark" ? "hud" : "under-window") : null);
  }
  page.setBackgroundColor?.(on ? "#00000000" : "#f5f4f0");
}
