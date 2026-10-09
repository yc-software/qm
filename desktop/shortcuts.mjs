export function tabStep({ type, key, code, control, meta, alt, shift, isComposing }, platform = process.platform) {
  if (type !== "keyDown" || isComposing) return 0;
  if (control && !meta && !alt) {
    if (key === "Tab") return shift ? -1 : 1;
    if (!shift && key === "PageDown") return 1;
    if (!shift && key === "PageUp") return -1;
  }
  if (platform === "darwin" && meta && alt && !control && !shift) {
    if (key === "ArrowRight") return 1;
    if (key === "ArrowLeft") return -1;
  }
  if (platform === "darwin" && meta && shift && !alt && !control) {
    if (code === "BracketRight") return 1;
    if (code === "BracketLeft") return -1;
  }
  return 0;
}
