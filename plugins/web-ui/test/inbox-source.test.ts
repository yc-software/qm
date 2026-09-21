import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
const split = readFileSync(new URL("../src/split.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const shellState = readFileSync(new URL("../src/shell-state.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("inbox is a first-class view with a draggable sidebar entry", () => {
  assert.match(shellState, /"chats",\s*"inbox",\s*"calendar",\s*"contexts"/);
  assert.match(shell, /case "inbox":\s*void renderInbox\(\);/);
  assert.match(shell, /data-view="inbox"/);
  assert.match(shell, /application\/x-webui-inbox/);
  assert.match(shell, /nav-badge/);
});

test("inbox access rides the existing permissions plumbing", () => {
  assert.match(shell, /can\("inbox"\) \? html`\$\{inboxNavRow\(\)\}/);
  assert.match(shellState, /if \(view === "inbox" \|\| view === "calendar"\) return can\("inbox"\);/);
  assert.match(server, /process\.env\.INBOX_USERS/);
  assert.match(server, /principalInAllowlist\(principalId, configuredUsers\)/);
  assert.match(server, /if \(isInboxUser\(user\)\) permissions\.push\("inbox"\);/);
  assert.match(inbox, /if \(!can\("inbox"\)\) return;/);
});

test("the split canvas accepts inbox views as panes alongside sessions", () => {
  assert.match(inbox, /registerPaneKind\(\{/, "the inbox registers itself as a pane kind");
  assert.match(inbox, /paramsKey: "inboxView"/, "saved layouts keep loading under the inboxView key");
  assert.match(inbox, /mountInboxPane\(\{ host, viewId: id/, "pane content mounts the inbox surface");
  assert.match(
    inbox,
    /badge: \(id\) => \(can\("inbox"\) \? inboxOpenCount\(id\) : 0\)/,
    "the gated tab strip shows the open count",
  );
  assert.match(split, /paneKindEntry\(this\.params\)/, "pane content resolves its kind through the registry");
  assert.match(split, /conversation: Conversation \| null = null/);
  assert.match(split, /private ensureConversation\(\): Conversation/);
});

test("an inbox drag paints drop zones on every existing pane", () => {
  assert.match(
    split,
    /render\(paneDrag \? paneZonesTpl\(this\.panelId\) : nothing/,
    "zones render for any pane drag, inbox included",
  );
  assert.match(shell, /beginPaneKindDrag\("inboxView", "all"\)/, "the sidebar row drags the whole inbox");
  assert.doesNotMatch(inbox, /beginPaneKindDrag\("inboxView"/, "view chips are plain tabs, not drag handles");
});

test("email items edit like an email; slack items like slack", () => {
  assert.match(inbox, /<span>To<\/span>/);
  assert.match(inbox, /<span>Subject<\/span>/);
  assert.match(inbox, /Send it/, "send lives in the composer as a suggested action");
  assert.match(inbox, /inbox-chat-suggest/, "suggested actions render inside the ask composer");
  assert.match(inbox, /Send the drafted reply in Gmail/);
  assert.match(inbox, /Send the drafted reply to Slack/);
  assert.match(inbox, /rows=\$\{gmail \? 7 : 3\}/, "email drafts get a taller editor than slack replies");
});

test("the address keeps naming the open item, even after switchView writes the bare view path", () => {
  assert.match(
    inbox,
    /syncInboxUrl\(openSentEmail\?\.id \?\? fullSurface\.selectedId\);/,
    "every draw re-states the URL from the selection it just rendered",
  );
  assert.match(inbox, /await openSentEmailById\(id, drawAll\);/, "unknown inbox ids resolve through sent mail");
  assert.match(
    shell,
    /const next = deepLinkPath\(UI_BASE, appState\.currentView, sessionId, contextsState\.selected\);/,
    "syncUrlFromState carries no item id, which is what the inbox has to heal after",
  );
  const draw = inbox.match(/function drawFull\(\): void \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(draw, /pendingItemId/, "a deep link reaches the draw as pendingItemId");
  assert.match(inbox, /function syncInboxUrl\(itemId: string \| null, push = false\)/);
  assert.match(inbox, /if \(appState\.currentView !== "inbox"\) return;/, "and never writes from another view");
});

test("inbox pills own stable routes that survive refresh and history navigation", () => {
  assert.match(inbox, /itemId \?\? inboxViewSegment\(fullViewId\)/);
  assert.match(inbox, /if \(segment === "email"\) return "gmail"/);
  assert.match(inbox, /if \(surface === fullSurface\) selectInboxView\(v\.id, true\)/);
  assert.match(inbox, /export function routeInboxHistory\(segment: string \| null\)/);
  assert.match(shell, /if \(wanted === "inbox"\) routeInboxHistory\(wantedItem\)/);
  assert.match(shell, /else routeInboxHistory\(item\)/);
});

test("initial inbox selection is restored after the shell resets the active view", () => {
  assert.match(shell, /switchView\(wanted as View\);\s*if \(wanted === "inbox"\) routeInboxHistory\(wantedItem\);/);
});

test("every draft links back to the session that produced it", () => {
  assert.match(inbox, /draftSessionId/);
  assert.match(inbox, /deepLinkPath\(UI_BASE, "chats", item.draftSessionId\)/);
  assert.match(inbox, /Open agent session/);
});

test("drafts persist on blur and send uses the current edit", () => {
  assert.match(inbox, /@blur=\$\{\(\) => void persistDraft\(item\)\}/);
  assert.match(inbox, /const draft = effectiveDraft\(item\);/);
  assert.match(
    inbox,
    /`\/api\/loops\/\$\{encodeURIComponent\(item\.loopId\)\}\/items\/\$\{encodeURIComponent\(item\.id\)\}\/\$\{leaf\}`/,
    "every item mutation addresses the ledger item under its own loop",
  );
  assert.match(inbox, /postAction\(item, "edit", \{\s*proposal,/, "a blurred edit revises the proposal");
  assert.match(
    inbox,
    /postAction\(item, "send", \{\s*proposal: draft,\s*\.\.\.\(basedOnAt !== undefined \? \{ expectedProposalAt: basedOnAt \} : \{\}\),\s*\}\)/,
    "send carries the current edit and the draft version it was based on",
  );
  assert.match(inbox, /postAction\(item, status === "dismissed" \? "dismiss" : "reopen"\)/);
});

test("the inbox reads a paginated combined feed and retains original item references", () => {
  assert.match(inbox, /api<Feed>\(`\/api\/inbox\?\$\{qs\}`\)/);
  assert.match(inbox, /feedWindows/);
  assert.match(inbox, /loopId: entry\.loopId/);
  assert.match(inbox, /loadDeepLink/);
});

test("localhost can overlay private inbox seed data without checking it into source", () => {
  assert.match(inbox, /fetch\("\/inbox-seed\.local\.json", \{ cache: "no-store" \}\)/);
  assert.match(
    inbox,
    /if \(!\["localhost", "127\.0\.0\.1", "\[::1\]"\]\.includes\(location\.hostname\)\) return \[\];/,
  );
  assert.match(inbox, /const localItems = await fetchLocalInboxItems\(\);/);
  assert.match(inbox, /if \(localItems\.length\) inboxState\.items = localItems/);
  assert.match(inbox, /api<Feed>\(`\/api\/inbox\?\$\{qs\}`\)/);
});

test("each item carries a follow-up chat with the agent", () => {
  assert.match(inbox, /export function chatTpl\(item: InboxItem\): TemplateResult/);
  assert.match(inbox, /actionPath\(item, "followup"\)/);
  assert.match(inbox, /body: JSON\.stringify\(\{ message: text \}\)/);
  assert.match(inbox, /\$\{chatTpl\(item\)\}/, "the chat pane hangs off the draft editor");
  assert.match(inbox, /item\.thread\.map\(/, "the thread transcript renders");
  assert.match(inbox, /draftEdits\.delete\(item\.id\);/, "a revised proposal supersedes the local edit");
  assert.match(css, /\.inbox-chat-log \{/);
  assert.match(css, /\.inbox-chat-msg\.human \{/);
  assert.match(css, /\.inbox-chat-composer \{/);
});

test("handled items keep their history but stay out of the way", () => {
  assert.match(inbox, /Handled \(/);
  assert.match(inbox, /if \(item\.status === "sent"\) return "Sent";/);
  assert.match(inbox, /if \(item\.status === "replied"\) return "Replied";/);
  assert.match(inbox, /return "Dismissed";/);
  assert.match(inbox, /Reopen/);
});

test("an external reply in Slack or Gmail closes the loop in the UI", () => {
  assert.match(
    inbox,
    /status: "open" \| "sent" \| "dismissed" \| "replied"/,
    "the item type learns the replied status",
  );
  assert.match(inbox, /externalReplyText\?: string;/);
  assert.match(inbox, /You replied in \$\{where\}/);
  assert.match(inbox, /item\.source === "slack" \? "Slack" : "Gmail"/);
  assert.match(inbox, /item\.externalReplyText \? html`<div class="inbox-replied-text">/);
  assert.match(
    inbox,
    /resolved === "replied" && entry\.actionResult \? \{ externalReplyText: entry\.actionResult \}/,
    "the reply text rides the ledger action result, not a bespoke field",
  );
});

test("the inbox reads reactions but no longer writes them — no react or emoji-insert affordance", () => {
  assert.doesNotMatch(inbox, /reactToItem/, "reacting from the inbox is gone with its button");
  assert.doesNotMatch(inbox, /insertIntoDraftBody/, "so is inserting an emoji into a draft");
  assert.doesNotMatch(inbox, /openEmojiPicker/, "and nothing opens the picker anymore");
  assert.match(inbox, /item\.reactions\?\.length/, "reactions added elsewhere still render as chips");
  assert.match(inbox, /charForName\(name\)/);
  assert.match(inbox, /Array\.isArray\(payload\.reactions\)/, "the chips read the opaque source payload");
  assert.doesNotMatch(inbox, /\/api\/inbox\/items/, "ledger actions ride the generic loop item routes");
  assert.match(
    server,
    /\/v1\/loops\/\$\{encodeURIComponent\(params\.id!\)\}\/items\/\$\{encodeURIComponent\(params\.itemId!\)\}\/\$\{leaf\}/,
    "one relay still carries every ledger item intent",
  );
});

test("the reaction chip and replied-text styles ship with the stylesheet", () => {
  assert.doesNotMatch(css, /\.emoji-picker/, "the picker went with the affordance that opened it");
  assert.match(css, /\.inbox-reaction-chip \{/);
  assert.match(css, /\.inbox-replied-text \{/);
});

test("the inbox stylesheet exists and scopes to inbox- classes", () => {
  assert.match(css, /\.inbox-surface \{/);
  assert.match(css, /\.inbox-chip\.active \{/);
  assert.match(css, /\.pane-kind-count \{/);
  assert.match(css, /\.nav-badge \{/);
});

test("the inbox list spans the same desktop content width as the item detail", () => {
  assert.match(
    css,
    /\.content-wide-page \{[\s\S]*--content-wide-width: calc\(var\(--content-primary-width\) \+ var\(--content-gap\) \+ var\(--content-aside-width\)\);/,
  );
  assert.match(css, /\.inbox-page \.inbox-surface \{\s*width: min\(var\(--content-wide-width\), 100%\);/);
  assert.match(
    css,
    /\.content-wide-page:not\(:has\(\.inbox-item-aside\)\) > \.pane-head \{\s*width: min\(var\(--content-wide-width\), 100%\);\s*max-width: none;/,
  );
  assert.match(
    css,
    /grid-template-columns: minmax\(0, var\(--content-primary-width\)\) minmax\(0, var\(--content-aside-width\)\);/,
  );
});

test("inbox item hover behaves like a sidebar conversation hover", () => {
  assert.match(css, /\.session:hover \{\s*background: var\(--conversation-hover\);/);
  assert.match(css, /--inbox-row-hover: color-mix\(in srgb, var\(--foreground\) 4%, var\(--background\)\);/);
  assert.match(css, /\.inbox-item-summary:hover,[\s\S]*?background: var\(--inbox-row-hover\);/);
  const reveal = css.match(/\.inbox-item-summary:hover \.inbox-item-dismiss,[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reveal, /opacity: 1;/);
  assert.doesNotMatch(reveal, /background:|color:|pointer-events:/);
  assert.match(css, /\.inbox-item-summary:has\(\.inbox-item-dismiss:hover\) \{\s*background: none;/);
});

test("inbox dividers do not collide with rounded hovered rows", () => {
  assert.match(css, /\.inbox-item:not\(:last-child\)::after \{[\s\S]*?margin: 0 12px;/);
  assert.match(
    css,
    /\.inbox-item:hover::after,\s*\.inbox-item:has\(\+ \.inbox-item:hover\)::after \{\s*background: transparent;/,
  );
  assert.doesNotMatch(css, /\.inbox-item \{\s*border-bottom:/);
  assert.match(css, /\.inbox-page \.inbox-toolbar \{\s*padding: 8px 0;\s*border-bottom: 0;/);
});

test("clipped email snippets do not trigger a native hover tooltip", () => {
  assert.match(css, /\.src-gmail \.inbox-item-snippet \{\s*pointer-events: none;/);
});

test("a send refused because the agent redrafted keeps the person's edit and shows the new draft", () => {
  assert.match(inbox, /status === 409 && \/draft changed\/i\.test\(e\.message\)/);
  assert.match(inbox, /await refetchItem\(item\);/);
  assert.match(
    inbox,
    /redrafted this reply while you were editing\. Your text is kept in the box\. New draft: "\$\{preview\}"/,
  );
});

test("an edit remembers the draft version it started from, and both edit and send carry it", () => {
  assert.match(inbox, /const basedOnAt = draftEdits\.get\(item\.id\)\?\.basedOnAt \?\? item\.draftAt;/);
  assert.match(
    inbox,
    /postAction\(item, "edit", \{\s*proposal,\s*\.\.\.\(basedOnAt !== undefined \? \{ expectedProposalAt: basedOnAt \} : \{\}\),/,
  );
  assert.match(inbox, /const basedOnAt = edited\?\.basedOnAt \?\? item\.draftAt;/);
  assert.match(inbox, /if \(isDraftConflict\(e\)\) return explainDraftConflict\(item, true\);/);
});

test("draft header links stay together after the label", () => {
  assert.match(css, /\.inbox-draft-label \{[^}]*margin-right: auto;/);
  assert.doesNotMatch(css, /\.inbox-session-link \{[^}]*margin-left: auto;/);
  assert.doesNotMatch(css, /\.inbox-draft-head \.inbox-external-link \{[^}]*margin-left: auto;/);
});

test("draft header links share one text size", () => {
  assert.match(css, /\.inbox-session-link,\s*\.inbox-external-link \{[^}]*font-size: 11px;/);
  assert.doesNotMatch(css, /\.inbox-session-link \{[^}]*font-size:/);
});

test("suggested draft actions yield to typed instructions without reflow", () => {
  assert.match(inbox, /inbox-chat-composer \$\{pending\.trim\(\) \? "has-text" : ""\}/);
  assert.match(inbox, /if \(had !== Boolean\(box\.value\.trim\(\)\)\) drawAll\(\);/);
  assert.match(css, /\.inbox-chat-composer\.has-text \.inbox-chat-suggest \{\s*visibility: hidden;/);
  assert.doesNotMatch(inbox, /inbox-draft-actions|function sendLabel/);
});

test("conversation messages use the containing view's scroll instead of clipping the latest message", () => {
  const context = css.match(/\.inbox-context \{[^}]*\}/)?.[0] ?? "";
  assert.match(context, /flex: none;/);
  assert.doesNotMatch(context, /max-height:|overflow-y:/);
});

test("single email pages keep bottom breathing room", () => {
  const surface = css.match(/\.inbox-item-surface \.inbox-scroll \{[^}]*\}/)?.[0] ?? "";
  assert.match(surface, /padding-bottom: calc\(64px \+ env\(safe-area-inset-bottom\)\);/);
});
