function nodePath(node: Node): string {
  const parent = node.parentNode;
  if (!parent) return "";
  const name = node.nodeType === 3 ? "text()" : node.nodeName.toLowerCase();
  const siblings = [...parent.childNodes].filter(
    (sibling) => sibling.nodeType === node.nodeType && sibling.nodeName === node.nodeName,
  );
  return `${nodePath(parent)}/${name}[${siblings.findIndex((sibling) => sibling === node) + 1}]`;
}

export function readTextSelection(selection: Selection | null) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const element =
    range.commonAncestorContainer.nodeType === 1
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  if (!element || element.closest('[data-devbar], input, textarea, [contenteditable]:not([contenteditable="false"])'))
    return null;
  const exact = range.toString();
  if (!exact.trim()) return null;
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(element);
  after.setStart(range.endContainer, range.endOffset);
  return {
    element,
    textSelection: {
      exact,
      prefix: before.toString().slice(-80),
      suffix: after.toString().slice(0, 80),
      start: { xpath: nodePath(range.startContainer), offset: range.startOffset },
      end: { xpath: nodePath(range.endContainer), offset: range.endOffset },
    },
  };
}
