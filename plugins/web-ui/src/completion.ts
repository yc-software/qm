import { html, nothing, render, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { Megaphone } from "lucide";
import { EMOJI_ROWS, rowForName, type EmojiRow } from "./emoji-picker";
import { icon } from "./icons";
import type { MentionBook } from "./mentions";
import { person, searchPeople, type Person } from "./people";
import { avatarTpl } from "./ui";
import "./completion.css";

export interface CompletionRow {
  key: string;
  lead: TemplateResult | string;
  name: string;
  match?: readonly [number, number];
  detail?: string;
  tag?: string;
  hint?: string;
}

export interface CompletionSection<Row extends CompletionRow = CompletionRow> {
  title?: string;
  rows: Row[];
}

export function completionRows<Row extends CompletionRow>(options: {
  id: string;
  sections: CompletionSection<Row>[];
  active: number;
  pick: (row: Row) => void;
  point?: (index: number) => void;
}): TemplateResult {
  let index = -1;
  return html`${options.sections.map(
    (section) =>
      html`${
        section.title ? html`<div class="completion-title" role="presentation">${section.title}</div>` : nothing
      }${section.rows.map((row) => {
        const mine = ++index;
        const active = mine === options.active;
        const [from, to] = row.match ?? [0, 0];
        return html`<button
          type="button"
          role="option"
          tabindex="-1"
          id=${`${options.id}-${mine}`}
          class="completion-row ${active ? "active" : ""}"
          title=${row.hint ?? nothing}
          aria-selected=${active ? "true" : "false"}
          @mousedown=${(event: MouseEvent) => event.preventDefault()}
          @mousemove=${() => options.point?.(mine)}
          @click=${() => options.pick(row)}
        >
          <span class="completion-lead">${row.lead}</span>
          <span class="completion-name"
            >${row.name.slice(0, from)}<b>${row.name.slice(from, to)}</b>${row.name.slice(to)}</span
          >
          ${row.detail ? html`<span class="completion-detail">${row.detail}</span>` : nothing}
          ${row.tag ? html`<span class="completion-tag">${row.tag}</span>` : nothing}
          <kbd class="completion-enter" aria-hidden="true">↵</kbd>
        </button>`;
      })}`,
  )}`;
}

type Token = { kind: "emoji" | "people"; start: number; end: number; query: string; complete: boolean };

const BEFORE = " \n\t([{\"'";
const EMOJI_NAME = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-";
const PERSON_NAME = /[\p{L}\p{N}._'-]/u;

function emojiToken(
  value: string,
  caret: number,
): { start: number; end: number; query: string; complete: boolean } | null {
  if (value[caret - 1] === ":" && (caret === 1 || BEFORE.includes(value[caret - 2]!)))
    return { start: caret - 1, end: caret, query: "", complete: false };
  const complete = value[caret - 1] === ":";
  const end = complete ? caret - 1 : caret;
  let start = end;
  while (start > 0 && EMOJI_NAME.includes(value[start - 1]!)) start--;
  if (start === end || value[start - 1] !== ":") return null;
  start--;
  if (start > 0 && !BEFORE.includes(value[start - 1]!)) return null;
  return { start, end: caret, query: value.slice(start + 1, end), complete };
}

function mentionToken(value: string, caret: number): { start: number; end: number; query: string } | null {
  let start = caret;
  while (start > 0 && PERSON_NAME.test(value[start - 1]!)) start--;
  if (value[start - 1] !== "@") return null;
  start--;
  if (start > 0 && !BEFORE.includes(value[start - 1]!)) return null;
  return { start, end: caret, query: value.slice(start + 1, caret) };
}

const SEARCH_PAUSE_MS = 150;
const RECENT_KEY = "qm-emoji-recent";
const STARTERS = ["+1", "pray", "smile", "tada", "heart", "eyes", "white_check_mark", "fire"];
const POPULAR = new Set([
  ...STARTERS,
  "-1",
  "joy",
  "sob",
  "grin",
  "wave",
  "clap",
  "rocket",
  "100",
  "thinking_face",
  "raised_hands",
  "muscle",
  "ok_hand",
  "sweat_smile",
  "slightly_smiling_face",
  "heart_eyes",
  "sunglasses",
  "sparkles",
  "star",
  "bulb",
  "warning",
  "x",
  "question",
  "point_up",
  "point_right",
  "point_down",
  "saluting_face",
  "melting_face",
  "skull",
  "handshake",
  "bug",
  "zap",
  "boom",
  "coffee",
  "pizza",
  "taco",
  "cry",
  "laughing",
  "rolling_on_the_floor_laughing",
  "upside_down_face",
  "face_with_rolling_eyes",
  "shrug",
  "tired_face",
  "hourglass",
  "calendar",
  "memo",
  "link",
  "lock",
  "ship",
]);

function recentEmoji(): EmojiRow[] {
  let names: string[] = [];
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    if (Array.isArray(stored)) names = stored.filter((name): name is string => typeof name === "string");
  } catch {
    names = [];
  }
  const rows = [...names, ...STARTERS].map(rowForName).filter((row): row is EmojiRow => row !== null);
  return [...new Set(rows)].slice(0, 8);
}

function rememberEmoji(row: EmojiRow): void {
  try {
    const names = recentEmoji()
      .map((recent) => recent.n)
      .filter((name) => name !== row.n);
    localStorage.setItem(RECENT_KEY, JSON.stringify([row.n, ...names].slice(0, 8)));
  } catch {
    return;
  }
}

type EmojiChoice = CompletionRow & { emoji: EmojiRow };

function emojiChoice(row: EmojiRow, name: string, at: number, length: number): EmojiChoice {
  const others = [row.n, ...row.a].filter((other) => other !== name).slice(0, 2);
  return {
    key: row.n,
    emoji: row,
    lead: row.c,
    name: `:${name}:`,
    match: [at + 1, at + 1 + length],
    ...(others.length ? { detail: others.join(", ") } : {}),
  };
}

function matchScore(exact: boolean, at: number, alias: boolean, wordStart: boolean): number {
  if (exact) return 0;
  if (at === 0) return alias ? 4 : 3;
  return wordStart ? 6 : 7;
}

function popularityBoost(score: number, recent: boolean, popular: boolean): number {
  if (!score || score > 4) return 0;
  if (recent) return 2;
  return popular ? 1 : 0;
}

function emojiChoices(query: string, limit: number): EmojiChoice[] {
  const needle = query.toLowerCase().replaceAll("-", "_");
  if (!needle) return recentEmoji().map((row) => emojiChoice(row, row.n, 0, 0));
  const recent = new Set(recentEmoji().map((row) => row.n));
  const scored: Array<{ choice: EmojiChoice; score: number; order: number }> = [];
  EMOJI_ROWS.forEach((row, order) => {
    let best: { name: string; at: number; score: number } | null = null;
    [row.n, ...row.a].forEach((name, alias) => {
      const at = name.toLowerCase().replaceAll("-", "_").indexOf(needle);
      if (at < 0) return;
      const exact = at === 0 && name.length === needle.length;
      const score = matchScore(exact, at, alias > 0, name[at - 1] === "_");
      if (!best || score < best.score) best = { name, at, score };
    });
    if (best) {
      const { name, at, score } = best as { name: string; at: number; score: number };
      const boost = popularityBoost(score, recent.has(row.n), POPULAR.has(row.n));
      scored.push({ choice: emojiChoice(row, name, at, needle.length), score: score - boost, order });
    }
  });
  return scored
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.choice);
}

export interface Mentionable {
  principalId: string;
  name: string;
}

export interface MentionOptions {
  book: MentionBook;
  viewer?: string;
  participants?: () => readonly Mentionable[];
  broadcasts?: boolean;
  app?: string;
}

type PersonChoice = CompletionRow & { insert: string; wire?: string };

function nameMatch(name: string, needle: string): number {
  const lower = name.toLowerCase();
  if (lower.startsWith(needle)) return 0;
  for (const gap of [" ", ".", "-", "_"]) {
    const at = lower.indexOf(gap + needle);
    if (at >= 0) return at + 1;
  }
  return -1;
}

function personChoice(who: Person, needle: string, viewer: string | undefined): PersonChoice | null {
  const at = nameMatch(who.displayName, needle);
  const [local = "", domain = ""] = who.principalId.includes("@") ? who.principalId.split("@") : [];
  if (at < 0 && nameMatch(local, needle) !== 0) return null;
  let detail = "";
  if (local && !who.isBot) {
    if (domain !== viewer?.split("@")[1]) detail = who.principalId;
    else if (local.toLowerCase() !== who.displayName.toLowerCase()) detail = local;
  }
  let tag = "";
  if (who.isBot) tag = "App";
  else if (who.principalId === viewer) tag = "You";
  else if (who.type && who.type !== "internal") tag = "Guest";
  return {
    key: who.principalId,
    lead: avatarTpl({ key: who.principalId, name: who.displayName, avatarUrl: who.avatarUrl, quiet: true }),
    name: who.displayName,
    match: at < 0 ? [0, 0] : [at, at + needle.length],
    ...(detail ? { detail } : {}),
    ...(tag ? { tag } : {}),
    insert: `@${who.displayName}`,
    ...(who.slackId ? { wire: `<@${who.slackId}>` } : {}),
  };
}

const BROADCASTS = [
  { name: "here", detail: "Everyone online in this channel" },
  { name: "channel", detail: "Everyone in this channel" },
];

function broadcastChoices(needle: string): PersonChoice[] {
  if (!needle) return [];
  return BROADCASTS.filter((entry) => entry.name.startsWith(needle)).map((entry) => ({
    key: `!${entry.name}`,
    lead: html`<span class="completion-glyph">${icon(Megaphone, 14)}</span>`,
    name: `@${entry.name}`,
    match: [1, 1 + needle.length] as const,
    detail: entry.detail,
    insert: `@${entry.name}`,
    wire: `<!${entry.name}>`,
  }));
}

function tokenLeft(input: HTMLTextAreaElement, index: number): number {
  const view = input.ownerDocument.defaultView;
  if (!view) return 0;
  const style = view.getComputedStyle(input);
  const probe = input.ownerDocument.createElement("div");
  probe.className = "completion-probe";
  probe.style.font = style.font;
  probe.style.letterSpacing = style.letterSpacing;
  probe.style.padding = style.padding;
  probe.style.width = `${input.clientWidth}px`;
  probe.textContent = input.value.slice(0, index);
  const marker = input.ownerDocument.createElement("span");
  marker.textContent = "@";
  probe.append(marker);
  input.insertAdjacentElement("afterend", probe);
  const left = marker.offsetLeft;
  probe.remove();
  return input.offsetLeft + left;
}

class Completion extends AsyncDirective {
  private input!: HTMLTextAreaElement;
  private options: MentionOptions | undefined;
  private popup: HTMLDivElement | null = null;
  private backdrop: HTMLDivElement | null = null;
  private observer: ResizeObserver | null = null;
  private token: Token | null = null;
  private sections: CompletionSection[] = [];
  private rows: CompletionRow[] = [];
  private active = 0;
  private browsed = false;
  private search = 0;
  private settled = false;
  private id = `completion-${crypto.randomUUID()}`;

  render(_value: string, _options?: MentionOptions) {
    return nothing;
  }

  override update(part: ElementPart, [value, options]: [string, MentionOptions?]) {
    this.options = options;
    if (!this.input) {
      this.input = part.element as HTMLTextAreaElement;
      this.listen();
    }
    if (this.token && value !== this.input.value) this.close();
    if (options) queueMicrotask(() => this.paint());
    return nothing;
  }

  private listen() {
    this.input.addEventListener("input", this.onInput, true);
    this.input.addEventListener("keydown", this.onKeydown, true);
    this.input.addEventListener("click", this.close);
    this.input.addEventListener("blur", this.close);
    this.input.addEventListener("scroll", this.paint);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.paint());
      this.observer.observe(this.input);
    }
  }

  private close = () => {
    if (this.popup) {
      render(nothing, this.popup);
      this.popup.remove();
      this.popup = null;
    }
    this.token = null;
    this.sections = [];
    this.rows = [];
    this.search++;
    this.input.removeAttribute("aria-controls");
    this.input.removeAttribute("aria-activedescendant");
    this.input.removeAttribute("aria-autocomplete");
  };

  private paint = () => {
    const marks = this.isConnected && this.options ? this.options.book.scan(this.input.value) : [];
    if (!marks.length) {
      this.backdrop?.remove();
      this.backdrop = null;
      return;
    }
    if (!this.backdrop) {
      this.backdrop = document.createElement("div");
      this.backdrop.className = "composer-mentions";
      this.backdrop.setAttribute("aria-hidden", "true");
      this.input.insertAdjacentElement("beforebegin", this.backdrop);
    }
    const style = this.input.ownerDocument.defaultView!.getComputedStyle(this.input);
    const box = this.backdrop.style;
    box.font = style.font;
    box.letterSpacing = style.letterSpacing;
    box.padding = style.padding;
    box.left = `${this.input.offsetLeft}px`;
    box.top = `${this.input.offsetTop}px`;
    box.width = `${this.input.clientWidth}px`;
    box.height = `${this.input.clientHeight}px`;
    const value = this.input.value;
    const parts: Array<string | TemplateResult> = [];
    let cursor = 0;
    for (const mark of marks) {
      parts.push(value.slice(cursor, mark.start), html`<mark>${value.slice(mark.start, mark.end)}</mark>`);
      cursor = mark.end;
    }
    parts.push(`${value.slice(cursor)}\u200b`);
    render(parts, this.backdrop);
    this.backdrop.scrollTop = this.input.scrollTop;
  };

  private onInput = (event: Event) => {
    this.close();
    this.paint();
    if (this.settled) {
      this.settled = false;
      return;
    }
    if ((event as InputEvent).isComposing || this.input.selectionStart !== this.input.selectionEnd) return;
    const caret = this.input.selectionStart;
    const mention = this.options ? mentionToken(this.input.value, caret) : null;
    if (mention) {
      this.token = { kind: "people", ...mention, complete: false };
      this.findPeople();
      return;
    }
    const emoji = emojiToken(this.input.value, caret);
    if (!emoji) return;
    this.token = { kind: "emoji", ...emoji };
    if (emoji.complete) {
      const row = rowForName(emoji.query);
      if (row && (event as InputEvent).inputType === "insertText") {
        const value = this.input.value;
        setTimeout(() => {
          if (this.isConnected && this.input.value === value && this.input.selectionStart === caret)
            this.replace(row.c);
        });
      }
      return;
    }
    const choices = emojiChoices(emoji.query, 8);
    this.show([{ ...(emoji.query ? {} : { title: "Frequently used" }), rows: choices }]);
  };

  private findPeople() {
    const options = this.options!;
    const needle = this.token!.query.toLowerCase();
    const seen = new Set<string>();
    const choose = (who: Person | null | undefined): PersonChoice | null => {
      if (!who || seen.has(who.principalId)) return null;
      const choice = personChoice(who, needle, options.viewer);
      if (choice) seen.add(who.principalId);
      return choice;
    };
    const thread = (options.participants?.() ?? [])
      .filter((member) => member.principalId !== options.viewer)
      .map((member) =>
        choose(person(member.principalId) ?? { principalId: member.principalId, displayName: member.name }),
      )
      .filter((choice): choice is PersonChoice => choice !== null);
    const broadcasts = options.broadcasts ? broadcastChoices(needle) : [];
    const draw = (app: PersonChoice | null, others: PersonChoice[]) => {
      const here = [...(app ? [app] : []), ...thread];
      const more = others;
      const sections: CompletionSection[] = [];
      if (here.length) sections.push({ title: "In this thread", rows: here });
      if (more.length) sections.push({ title: here.length ? "More people" : "People", rows: more });
      if (broadcasts.length) sections.push({ title: "Notify", rows: broadcasts });
      this.show(sections, needle ? "" : "Type a name to find people");
    };
    draw(null, []);
    const search = ++this.search;
    const token = this.token;
    setTimeout(() => {
      if (search !== this.search || token !== this.token) return;
      void Promise.all([options.app ? searchPeople(options.app) : [], needle ? searchPeople(needle) : []]).then(
        ([apps, found]) => {
          if (search !== this.search || token !== this.token) return;
          const app = choose(apps.find((who) => who.isBot) ?? null);
          const others = found.map(choose).filter((choice): choice is PersonChoice => choice !== null);
          if (app || others.length) draw(app, others);
          else if (!this.rows.length && needle) this.close();
        },
      );
    }, SEARCH_PAUSE_MS);
  }

  private show(sections: CompletionSection[], empty = "") {
    this.sections = sections.filter((section) => section.rows.length);
    this.rows = this.sections.flatMap((section) => section.rows);
    if (!this.rows.length && !empty) {
      if (this.popup) {
        render(nothing, this.popup);
        this.popup.remove();
        this.popup = null;
      }
      return;
    }
    this.active = Math.min(this.active, Math.max(0, this.rows.length - 1));
    if (!this.popup) {
      this.active = 0;
      this.browsed = false;
    }
    this.draw(empty);
  }

  private replace(text: string) {
    if (!this.current()) return;
    const token = this.token!;
    this.close();
    this.input.setSelectionRange(token.start, token.end);
    this.settled = true;
    if (!this.input.ownerDocument.execCommand?.("insertText", false, text)) {
      this.input.setRangeText(text, token.start, token.end, "end");
      this.input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: text }),
      );
    }
    this.settled = false;
  }

  private pick(row: CompletionRow) {
    if ("emoji" in row) {
      rememberEmoji((row as EmojiChoice).emoji);
      this.replace((row as EmojiChoice).emoji.c);
      return;
    }
    const choice = row as PersonChoice;
    if (choice.wire) this.options?.book.add(choice.insert.slice(1), choice.wire);
    const after = this.input.value[this.token?.end ?? 0];
    this.replace(after === " " ? choice.insert : `${choice.insert} `);
    this.paint();
  }

  private current(): boolean {
    const token = this.token;
    if (!token) return false;
    const sigil = token.kind === "emoji" ? ":" : "@";
    if (
      this.input.selectionStart !== token.end ||
      this.input.selectionEnd !== token.end ||
      this.input.value.slice(token.start, token.end) !== `${sigil}${token.query}${token.complete ? ":" : ""}`
    ) {
      this.close();
      return false;
    }
    return true;
  }

  private draw(empty = "") {
    const token = this.token!;
    if (!this.popup) {
      this.popup = document.createElement("div");
      this.popup.id = this.id;
      this.popup.setAttribute("role", "listbox");
      this.popup.addEventListener("mousedown", (event) => event.preventDefault());
      this.input.insertAdjacentElement("afterend", this.popup);
      this.input.setAttribute("aria-controls", this.id);
      this.input.setAttribute("aria-autocomplete", "list");
    }
    this.popup.className = `completion-popover ${token.kind}-completion`;
    this.popup.setAttribute("aria-label", token.kind === "emoji" ? "Emoji" : "People");
    if (this.rows.length) this.input.setAttribute("aria-activedescendant", `${this.id}-${this.active}`);
    else this.input.removeAttribute("aria-activedescendant");
    render(
      this.rows.length
        ? completionRows({
            id: this.id,
            sections: this.sections,
            active: this.active,
            pick: (row) => this.pick(row),
            point: (index) => {
              if (index === this.active) return;
              this.active = index;
              this.browsed = true;
              this.draw();
            },
          })
        : html`<div class="completion-empty">${empty}</div>`,
      this.popup,
    );
    const wrap = this.popup.offsetParent as HTMLElement | null;
    const room = (wrap?.clientWidth ?? this.popup.offsetWidth) - this.popup.offsetWidth;
    const text = this.popup.querySelector<HTMLElement>(".completion-name, .completion-empty");
    const inset = text ? text.getBoundingClientRect().left - this.popup.getBoundingClientRect().left : 0;
    this.popup.style.left = `${Math.max(0, Math.min(room, tokenLeft(this.input, token.start) - inset))}px`;
    this.popup.querySelector(".completion-row.active")?.scrollIntoView?.({ block: "nearest" });
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || !this.popup || !this.current()) return;
    if (event.ctrlKey || event.metaKey) {
      this.close();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    } else if (!event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
      if (!this.rows.length || (this.token?.kind === "emoji" && !this.token.query && !this.browsed)) {
        this.close();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.pick(this.rows[this.active]!);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && this.rows.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.active = (this.active + (event.key === "ArrowDown" ? 1 : this.rows.length - 1)) % this.rows.length;
      this.browsed = true;
      this.draw();
    } else if (["ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key)) this.close();
  };

  protected override disconnected() {
    this.close();
    this.backdrop?.remove();
    this.backdrop = null;
    this.observer?.disconnect();
    this.observer = null;
    this.input.removeEventListener("input", this.onInput, true);
    this.input.removeEventListener("keydown", this.onKeydown, true);
    this.input.removeEventListener("click", this.close);
    this.input.removeEventListener("blur", this.close);
    this.input.removeEventListener("scroll", this.paint);
  }

  protected override reconnected() {
    this.listen();
  }
}

export const completion = directive(Completion);
