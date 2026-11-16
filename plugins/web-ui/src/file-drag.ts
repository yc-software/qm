export function createFileDragState(onChange: (dragging: boolean) => void) {
  let target: EventTarget | null = null;

  function eventTarget(event: Event): EventTarget | null {
    return event.composedPath()[0] ?? event.target;
  }

  function clear(): boolean {
    if (!target) return false;
    target.removeEventListener("dragleave", leave);
    target = null;
    return true;
  }

  function reset(): void {
    if (clear()) onChange(false);
  }

  function leave(event: Event): void {
    if (eventTarget(event) === target) reset();
  }

  function enter(event: DragEvent): void {
    const next = eventTarget(event);
    if (!next || next === target) return;
    const wasDragging = clear();
    target = next;
    target.addEventListener("dragleave", leave);
    if (!wasDragging) onChange(true);
  }

  return { enter, leave, reset, dispose: clear };
}
