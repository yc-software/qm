export function createTranscriptViewport() {
  let scroller: HTMLElement | null = null;
  let pins: HTMLElement | null = null;
  let prompt: HTMLElement | null = null;
  let stack: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let promptKey: string | undefined;
  let expanded = false;
  let lastTop = 0;
  let observer: ResizeObserver | null = null;
  let following = false;
  let frame: number | null = null;

  function setFollowing(value: boolean): void {
    following = value;
    if (scroller) scroller.style.overflowAnchor = value ? "none" : "";
  }

  function cancelFollow(): void {
    setFollowing(false);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function clearPrompt(): void {
    prompt?.classList.remove("stuck", "sticky-disabled", "pin-expanded");
    prompt?.style.removeProperty("--pin-clamp");
    const toggle = prompt?.querySelector<HTMLButtonElement>(".pin-toggle");
    if (toggle) toggle.hidden = true;
    expanded = false;
    promptKey = undefined;
  }

  function syncPrompt(): void {
    if (!scroller || !prompt || !content) return;
    prompt.style.setProperty(
      "--pin-clamp",
      `${Math.round(Math.min(320, Math.max(96, scroller.clientHeight * 0.35)))}px`,
    );
    prompt.classList.toggle("pin-expanded", expanded);
    const bubble = prompt.querySelector<HTMLElement>(".user-bubble");
    const clipped = !expanded && !!bubble && bubble.scrollHeight > bubble.clientHeight + 1;
    const toggle = prompt.querySelector<HTMLButtonElement>(".pin-toggle");
    if (toggle) {
      toggle.hidden = !clipped && !expanded;
      toggle.textContent = expanded ? "Show less" : "Show more";
      toggle.setAttribute("aria-expanded", String(expanded));
    }
  }

  function onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.nodeType !== 1) return;
    const toggle = target.closest<HTMLButtonElement>(".pin-toggle");
    if (!toggle || !prompt?.contains(toggle)) return;
    cancelFollow();
    expanded = !expanded;
    syncSticky();
  }

  function syncSticky(): void {
    if (!scroller) return;
    syncPrompt();
    const top = pins?.getBoundingClientRect().height ?? 0;
    scroller.style.setProperty("--chat-sticky-top", `${top}px`);
    const style = getComputedStyle(scroller);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const promptMargin = prompt ? parseFloat(getComputedStyle(prompt).marginBottom) || 0 : 0;
    const canStick =
      !!prompt &&
      prompt.getBoundingClientRect().height + promptMargin + top + paddingTop + paddingBottom <= scroller.clientHeight;
    prompt?.classList.toggle("sticky-disabled", !canStick);
    prompt?.classList.toggle(
      "stuck",
      canStick &&
        scroller.scrollTop > 0 &&
        prompt.getBoundingClientRect().top <=
          scroller.getBoundingClientRect().top + scroller.clientTop + paddingTop + top + 0.5,
    );
  }

  function onScroll(): void {
    if (!scroller) return;
    const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1;
    if (atBottom) setFollowing(true);
    else if (scroller.scrollTop < lastTop) cancelFollow();
    lastTop = scroller.scrollTop;
    syncSticky();
  }

  function onWheel(event: WheelEvent): void {
    if (event.deltaY < 0) cancelFollow();
  }

  function dispose(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
    observer = null;
    scroller?.removeEventListener("scroll", onScroll);
    scroller?.removeEventListener("wheel", onWheel);
    scroller?.removeEventListener("click", onClick);
    scroller?.style.removeProperty("--chat-sticky-top");
    scroller?.style.removeProperty("overflow-anchor");
    clearPrompt();
    scroller = pins = prompt = stack = content = null;
    lastTop = 0;
    following = false;
  }

  function sync(element: HTMLElement | null): void {
    let changed = false;
    if (scroller !== element) {
      changed = true;
      dispose();
      scroller = element;
      lastTop = scroller?.scrollTop ?? 0;
      setFollowing(false);
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      scroller?.addEventListener("wheel", onWheel, { passive: true });
      scroller?.addEventListener("click", onClick);
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          syncSticky();
          follow();
        });
        if (scroller) observer.observe(scroller);
      }
    }
    const nextStack = scroller?.querySelector<HTMLElement>(".message-stack") ?? null;
    if (stack !== nextStack) {
      changed = true;
      if (stack) observer?.unobserve(stack);
      stack = nextStack;
      if (stack) observer?.observe(stack);
    }
    const nextPins = scroller?.querySelector<HTMLElement>(".pinned-strip") ?? null;
    const nextPrompt = scroller?.querySelector<HTMLElement>(".message-stack .user-row:not(:has(~ .user-row))") ?? null;
    if (pins !== nextPins) {
      changed = true;
      if (pins) observer?.unobserve(pins);
      pins = nextPins;
      if (pins) observer?.observe(pins);
    }
    if (prompt !== nextPrompt || promptKey !== nextPrompt?.dataset.index) {
      changed = true;
      clearPrompt();
      if (prompt) observer?.unobserve(prompt);
      prompt = nextPrompt;
      promptKey = prompt?.dataset.index;
      if (prompt) observer?.observe(prompt);
    }
    const nextContent = prompt?.querySelector<HTMLElement>(".pin-content") ?? null;
    if (content !== nextContent) {
      changed = true;
      if (content) observer?.unobserve(content);
      content = nextContent;
      if (content) observer?.observe(content);
    }
    if (changed) syncSticky();
  }

  function follow(force = false): void {
    if (force) {
      setFollowing(true);
      lastTop = scroller?.scrollTop ?? 0;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    }
    if (!scroller || !following || frame !== null) return;
    const element = scroller;
    const priorTop = element.scrollTop;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (element !== scroller || !element.isConnected || !following) return;
      if (element.scrollTop < priorTop && element.scrollHeight - element.clientHeight - element.scrollTop > 1)
        return cancelFollow();
      element.scrollTop = element.scrollHeight;
      lastTop = scroller?.scrollTop ?? 0;
      syncSticky();
    });
  }

  return { sync, follow, dispose };
}
