import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightSpecialChars, keymap } from "@codemirror/view";
import { HighlightStyle, foldGutter, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { languages } from "@codemirror/language-data";
import { search, searchKeymap } from "@codemirror/search";

export async function mountFileEditor(
  parent: HTMLElement,
  text: string,
  name: string,
  mime: string,
): Promise<() => void> {
  const language =
    LanguageDescription.matchFilename(languages, name) ??
    languages.find((entry) => entry.alias.includes(mime.replace(/^application\/(?:x-)?/, "")));
  const support = await language?.load().catch(() => undefined);
  if (!parent.isConnected) return () => {};
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": `${name} contents`, tabindex: "0" }),
        lineNumbers(),
        highlightSpecialChars(),
        foldGutter(),
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: [tags.keyword, tags.typeName], color: "var(--ultrafast-accent)" },
            { tag: [tags.string, tags.regexp], color: "var(--success)" },
            { tag: [tags.number, tags.bool, tags.atom], color: "var(--warning)" },
            { tag: [tags.propertyName, tags.function(tags.variableName)], color: "var(--markdown-link)" },
            { tag: tags.comment, color: "var(--muted-foreground)" },
          ]),
        ),
        search(),
        keymap.of(searchKeymap),
        EditorView.theme({
          "&": { height: "100%", color: "var(--foreground)", backgroundColor: "var(--background)" },
          ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "var(--font-13)" },
          ".cm-gutters": {
            backgroundColor: "var(--muted)",
            color: "var(--muted-foreground)",
            borderColor: "var(--border)",
          },
          ".cm-panels": { backgroundColor: "var(--background)", color: "var(--foreground)" },
        }),
        ...(support ? [support] : []),
      ],
    }),
  });
  return () => view.destroy();
}
