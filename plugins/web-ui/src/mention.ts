const TOKEN_BODY = /^[\p{L}\p{N}_.·-]+/u;
const ASCII_NAME = /^[A-Za-z0-9_.-]+$/;
const MENTION_TOKEN = /(^|[^A-Za-z0-9@])@([^\s@]{0,40})$/;

export function mentionQuery(draft: string): string | null {
  const m = draft.match(MENTION_TOKEN);
  return m ? (m[2] ?? "") : null;
}

export function replaceMentionToken(draft: string, insert: string): string {
  return draft.replace(MENTION_TOKEN, (_all, pre: string) => `${pre}${insert}`);
}

export interface MentionSegment {
  text: string;
  mention: boolean;
}

export function splitMentions(text: string, knownNames: readonly string[]): MentionSegment[] {
  if (!text.includes("@")) return [{ text, mention: false }];
  const trimmed = [...new Set(knownNames.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!trimmed.length) return [{ text, mention: false }];
  const segments: MentionSegment[] = [];
  let last = 0;
  let i = text.indexOf("@");
  while (i !== -1) {
    const rest = text.slice(i + 1);
    const prev = i > 0 ? text[i - 1]! : "";
    const hit = /[A-Za-z0-9]/.test(prev)
      ? undefined
      : trimmed.find((name) => {
          if (rest.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return false;
          return !(ASCII_NAME.test(name) && /^[A-Za-z0-9_.-]/.test(rest.slice(name.length)));
        });
    if (hit) {
      if (i > last) segments.push({ text: text.slice(last, i), mention: false });
      segments.push({ text: `@${rest.slice(0, hit.length)}`, mention: true });
      last = i + 1 + hit.length;
      i = text.indexOf("@", last);
    } else {
      i = text.indexOf("@", i + 1);
    }
  }
  if (last < text.length) segments.push({ text: text.slice(last), mention: false });
  return segments.length ? segments : [{ text, mention: false }];
}

export function mentionTokens(text: string): string[] {
  const tokens = new Set<string>();
  let i = text.indexOf("@");
  while (i !== -1) {
    const prev = i > 0 ? text[i - 1]! : "";
    const m = text.slice(i + 1).match(TOKEN_BODY);
    if (m && m[0] && !/[A-Za-z0-9]/.test(prev)) tokens.add(m[0]);
    i = text.indexOf("@", i + 1);
  }
  return [...tokens].slice(0, 5);
}
