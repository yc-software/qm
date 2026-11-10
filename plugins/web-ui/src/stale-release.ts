import { conversationsBusy } from "./conversations";
import { servedReleaseChanged } from "./core-bridge";

const TEXT_ENTRY =
  "textarea, input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=reset], [type=color], [type=file])";

function editingOutsideComposers(): boolean {
  const active = document.activeElement as HTMLInputElement | null;
  if (document.querySelector('dialog[open], [aria-modal="true"]') || active?.isContentEditable) return true;
  return Boolean(active?.matches(TEXT_ENTRY) && active.value);
}

export function reloadIntoServedRelease(): boolean {
  if (!servedReleaseChanged() || document.visibilityState !== "visible") return false;
  if (editingOutsideComposers() || conversationsBusy()) return false;
  location.reload();
  return true;
}
