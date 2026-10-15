function frameMetadata() {
  const records = [];
  const byNode = new Map();
  const stack = [{ element: globalThis.document.documentElement, parent: null }];
  while (stack.length) {
    const { element, parent } = stack.pop();
    const control = ["input", "textarea"].includes(element.localName);
    const rich = Boolean(element.isContentEditable || parent?.rich);
    const linked = element.hasAttribute("aria-labelledby");
    const flat = rich || control || element.localName === "slot";
    const bad = flat || linked;
    const record = {
      element,
      parent,
      control,
      rich,
      linked,
      flat,
      bad,
      badCount: Number(bad),
      flatCount: Number(flat),
      labelCount: Number(linked),
      start: records.length,
      end: records.length,
    };
    records.push(record);
    byNode.set(element, record);
    const children = [...element.children, ...(element.shadowRoot?.children || [])];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ element: children[i], parent: record });
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (!record.parent) continue;
    record.parent.badCount += record.badCount;
    record.parent.flatCount += record.flatCount;
    record.parent.labelCount += record.labelCount;
    record.parent.end = Math.max(record.parent.end, record.end);
  }
  const result = [];
  for (const record of records) {
    const { element, control, rich } = record;
    const ref = element._ariaRef?.ref;
    if (!ref) continue;
    function safeLabel(label, ignoreTarget = false) {
      const source = byNode.get(label);
      if (!source || label === element) return false;
      const ignored =
        ignoreTarget && source.start <= record.start && record.start <= source.end ? Number(record.bad) : 0;
      return source.badCount === ignored;
    }
    const labelIds = (element.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter(Boolean);
    const staticLabels =
      labelIds.length && labelIds.every((id) => safeLabel(element.getRootNode().getElementById?.(id)));
    const nativeLabels = Array.from(element.labels || []);
    const nativeLabelsSafe = nativeLabels.every((label) => safeLabel(label, true));
    const ariaLabel = element.getAttribute("aria-label");
    result.push([
      ref,
      {
        editable: control || rich,
        unsafeLabel: Boolean(labelIds.length ? !staticLabels : !ariaLabel && !nativeLabelsSafe),
        labeled: Boolean(
          labelIds.length
            ? staticLabels
            : ariaLabel ||
                (control &&
                  !["button", "submit", "reset"].includes(element.type) &&
                  (nativeLabels.length
                    ? nativeLabelsSafe
                    : element.getAttribute("title") || element.getAttribute("placeholder"))),
        ),
        editableDescendant: record.flatCount > Number(record.flat),
        labelDescendant: record.labelCount > Number(record.linked),
      },
    ]);
  }
  return result;
}

async function snapshotMetadata(page, options) {
  const sessions = [];
  try {
    for (const target of [page, ...page.frames().filter((frame) => frame !== page.mainFrame())]) {
      try {
        sessions.push(await page.context().newCDPSession(target));
      } catch (error) {
        if (!String(error.message).includes("does not have a separate CDP session")) throw error;
      }
    }
    const trees = [];
    for (const session of sessions) trees.push({ session, tree: (await session.send("Page.getFrameTree")).frameTree });
    const roots = new Set(trees.map(({ tree }) => tree.frame.id));
    const seen = new Set();
    const metadata = new Map();
    for (const { session, tree } of trees) {
      const pending = [tree];
      while (pending.length) {
        options.signal?.throwIfAborted();
        const current = pending.pop();
        const frameId = current.frame.id;
        if (seen.has(frameId)) continue;
        seen.add(frameId);
        pending.push(...(current.childFrames || []).filter((child) => !roots.has(child.frame.id)));
        const { executionContextId } = await session.send("Page.createIsolatedWorld", {
          frameId,
          worldName: `__playwright_utility_world_${page._guid}`,
        });
        const response = await session.send("Runtime.evaluate", {
          contextId: executionContextId,
          expression: `(${frameMetadata.toString()})()`,
          returnByValue: true,
          timeout: options.timeout ?? 5000,
        });
        if (response.exceptionDetails || !Array.isArray(response.result?.value))
          throw new Error("Invalid snapshot metadata");
        for (const [ref, value] of response.result.value) {
          if (metadata.has(ref)) throw new Error("Duplicate snapshot reference");
          metadata.set(ref, value);
        }
      }
    }
    return metadata;
  } finally {
    for (const session of sessions) await session.detach().catch(() => {});
  }
}

export async function domSnapshot(page, options = {}) {
  const snapshot = await page.ariaSnapshotJSON({ ...options, mode: "ai" });
  let metadata;
  try {
    metadata = await snapshotMetadata(page, options);
    const pending = [...snapshot];
    while (pending.length) {
      const node = pending.pop();
      if (node.ref && (node.name || node.text || node.children?.length) && !metadata.has(node.ref))
        throw new Error("Missing snapshot reference");
      pending.push(...(node.children || []));
    }
  } catch {
    throw new Error("Snapshot redaction failed: a referenced element could not be verified");
  }
  function redact(node, inherited = false, ambiguousLabel = false) {
    if (typeof node === "string") return inherited && node ? "<redacted>" : node;
    if (Array.isArray(node)) return node.map((child) => redact(child, inherited, ambiguousLabel));
    if (!node || typeof node !== "object") return node;
    const info = metadata.get(node.ref);
    const editable = inherited || info?.editable;
    const result = { ...node };
    if (
      node.name &&
      ((!node.ref && ambiguousLabel) || info?.unsafeLabel || (editable && (inherited || !info?.labeled)))
    )
      result.name = "<redacted>";
    if (node.text && (editable || info?.editableDescendant)) result.text = "<redacted>";
    if (node.url && editable) result.url = "<redacted>";
    if (node.children)
      result.children = node.children.map((child) =>
        redact(
          child,
          editable || (typeof child === "string" && info?.editableDescendant),
          node.ref ? info?.labelDescendant : ambiguousLabel,
        ),
      );
    return result;
  }
  return JSON.stringify(redact(snapshot), null, 2);
}
