type ShortcutEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

export function hasExactPrimaryModifier(event: ShortcutEvent, mac: boolean): boolean {
  return mac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function matchesPrimaryShortcut(event: ShortcutEvent, key: string, mac: boolean): boolean {
  return event.key.toLowerCase() === key && hasExactPrimaryModifier(event, mac);
}
