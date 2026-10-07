export async function openDesktopBrowser(url: string): Promise<boolean> {
  const bridge = (globalThis as { window?: { qmDesktop?: { openBrowser: (url: string) => Promise<void> } } }).window
    ?.qmDesktop;
  if (!bridge) return false;
  await bridge.openBrowser(url);
  return true;
}
