import type { Loop, LoopItem } from "../types.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import { scopeId } from "../types.ts";
import type { LoopStore } from "./loop-store.ts";
import { SOURCE_IDS, adapterForItem } from "./sources/index.ts";
import { EVENT_TEXT_CHARS, type LatestEvent } from "./ingress.ts";

const INBOX_LOOP_NAME = "Inbox";

const INBOX_LOOP_SURFACE = "inbox";

export const INBOX_SYNC_TASK_VERSION = 7;

export const INBOX_SYNC_DEFAULT_EVERY_MS = 15 * 60 * 1000;

export const INBOX_LEDGER_MAX_ITEMS = 500;

export const INBOX_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const INBOX_SUCCESS_CONDITION =
  "Every Slack message and email waiting on the person's own reply is on the ledger with a ready-to-send draft in their voice, and nothing else is.";

export function renderInboxSyncTask(loopId: string): string {
  return `Inbox sync v${INBOX_SYNC_TASK_VERSION}. Keep the user's QM inbox loop current: every Slack message and email genuinely WAITING ON A REPLY FROM THEM gets a ledger item with a ready-to-send draft in their own voice. The inbox UI is the only delivery surface — never message the user, and NEVER send a reply yourself; you produce drafts only.

1. GET $AGENT_API_URL/v1/loops/${loopId}/items (agent capability header) — note existing items: skip complete items already tracked; a newer message in a tracked conversation is reported as an event (below), never re-posted or redrafted here. Preserve human-edited drafts. Repair incomplete open items first: an existing dedupeKey with missing sourcePayload, title, snippet, source metadata, or proposal is unfinished work, not a reason to skip it. Re-read its original conversation using the dedupeKey and summary, then ingest the complete item and draft under that same dedupeKey even when no newer message arrived. Never invent message content from a summary; if the source is unavailable, leave the item pending for retry.
   - Closed-loop detection: BEFORE scanning for new items, re-read the exact source conversation of EVERY unresolved item (held, pending, processed, or failed), regardless of lastScanAt, age, read/unread state, or whether Gmail still labels it INBOX. The intake watermark is NOT a reconciliation watermark. Whenever the LATEST message in that conversation is newer than the item's sourceAt, report it as an event and let the Loop decide: POST $AGENT_API_URL/v1/loops/${loopId}/events with {"events":[{"sourceKey":"<item sourceKey>","author":"owner"|"other","at":<message timestamp in ms>,"text":"<the message, <=${EVENT_TEXT_CHARS} chars>","from":"<sender name, for other>"}]} (up to 20 events per call). author is "owner" when the user wrote it themselves (their own Slack userId on Slack; their own address or a send-as alias in the From line, or the SENT label, on Gmail), else "other". Ignore Gmail drafts. Never resolve, dismiss, or redraft these items yourself: the event is judged by the Loop, which closes answered conversations and redrafts reopened ones. If a source read fails or is incomplete, retain the item and retry later; do not treat it as resolved. This applies to both Gmail and Slack items.
2. Keep a lastScanAt watermark in a state file on your workspace (e.g. ~/workspace/inbox-sync/STATE.md); scan each connected source since that watermark (fall back to ~3 days on first run), and advance the watermark only after a successful pass, so outages and missed fires backfill instead of leaving silent gaps. Skip a source whose app is not connected. Judge "waiting on a reply" like a good chief of staff, with a deliberate asymmetry: (a) NEEDS REPLY: direct questions, requests, intros, and personal messages that expect acknowledgment; when in any doubt, this bucket. (b) PROBABLY RESOLVED: the transcript reads closed (a thanks, a "sounds good", a thread someone else already answered) but a reasonable person might still send a word; post the item anyway with "probablyResolved": true in the item body and a draft included; the UI shows these in a muted section. NEVER silently drop a human conversation you judged resolved; demote it instead. (c) SKIP entirely: only unmistakable machine noise (newsletters, receipts, calendar notices, bot chatter). Human words never skip; the lowest they go is probablyResolved.
   - Gmail (use the google-workspace skill): INBOX threads where the LAST message is inbound and the user is in To or Cc. sourceKey = the Gmail threadId. Record gmail metadata: threadId, messageId, the RFC-2822 Message-ID header (rfcMessageId), subject, and the reply recipients (to = reply-all sender+others minus the user; cc as appropriate).
   - Slack (use your Slack access as the user): unanswered DMs, @mentions, and thread replies addressed to the user. ONE ITEM PER CONVERSATION, never per message: for unthreaded DMs and group DMs sourceKey = the channelId alone (two people posting in the same group DM is ONE item, refreshed with the latest state and a single draft answering everything outstanding); for all threaded asks sourceKey = channelId:threadTs (channelId:ts of a top-level message anchoring its own thread). Record slack metadata: channelId, channelLabel ("#channel" or "DM with <name>"), ts (the LATEST waiting message), userId (the Slack user id of that message's sender), isDirectMessage from Slack conversations.info is_im/is_mpim (NEVER infer group DMs from C/G ID prefixes), and threadTs for every threaded ask. For a top-level CHANNEL mention, threadTs is the original mentioned message ts, even before anyone replies. Preserve that anchor forever: unrelated channel chatter must not replace, refresh, or resolve this item. Read conversations.replies for that root, not the channel tail. For mentions inside a thread, include the root and only that thread. Relevant messages immediately before/after a channel mention may be included in context with nearby:true; never label these as thread replies, and never include unrelated neighboring messages.
3. For each new or refreshed item, investigate before drafting: read the whole thread, and check whatever context makes the reply substantive (calendar for scheduling asks, earlier email/Slack history for open questions). Draft the reply in the user's own voice — for email follow the email-draft-in-voice skill (build the voice profile first if it is missing); for Slack match how the user actually writes in Slack (check their recent messages: register, length, punctuation). Punctuation hard rule: never use em dashes or en dashes in a draft; use a comma, period, or "..." instead, and re-read every draft before posting to strip any that slipped in.
4. POST $AGENT_API_URL/v1/loops/${loopId}/items with {"items": [...]}. Each item: source ("gmail"|"slack"), sourceKey, title (subject or channel label), from (display name), fromDetail (address or @handle), snippet (the full text of the waiting message, never shortened or ellipsized), context (up to 6 prior thread messages as {author, at, text}), receivedAt (ms epoch of the waiting message), externalUrl (deep link to the original in Gmail/Slack), draft ({to, cc, subject, body} for gmail — body plain text; {body} for slack), and the gmail/slack metadata block from step 2. IMAGES: when a thread message carries image attachments, include an "images" array of their https URLs (Slack: url_private; up to 4) on the matching context entry, and on the item itself for the waiting message — the UI proxies and renders them inline as the user's own eyes would see them in Slack/Gmail.
5. Found nothing new and changed nothing? Finish silently. Only raise your voice on a real fault (a connector that errors repeatedly) — and then only briefly.`;
}

export async function ensureDefaultInboxLoops(store: LoopStore, owner: string): Promise<Loop[]> {
  const loops: Loop[] = [];
  for (const [source, name] of [
    ["gmail", "Email"],
    ["slack", "Slack"],
  ]) {
    const existing = (await store.list()).find(
      (loop) => loop.ownerScopeId === scopeId("personal", owner) && loop.surface === `inbox:${source}`,
    );
    if (existing) {
      loops.push(existing);
      continue;
    }
    const { loop } = await store.create({
      owner,
      createdBy: owner,
      ownerScopeId: scopeId("personal", owner),
      name: name!,
      surface: `inbox:${source}`,
      sources: [source!],
      purpose: `Messages in ${name} waiting on your reply.`,
      playbook: renderSourceInboxTask("$LOOP_ID", source!),
      successCondition: `Every ${name} conversation needing a reply has a draft for review.`,
      shipActions: [{ action: "send", gate: "hold" }],
    });
    loops.push(loop);
  }
  return loops;
}

export function isReplyLoop(loop: Loop, item: LoopItem): boolean {
  return Boolean(adapterForItem(item)) && loop.shipActions.length === 1 && loop.shipActions[0]?.action === "send";
}

export const REPLY_DECISION = [
  'First decide whether the person still owes a reply in this conversation. sourcePayload.latestEvent, when present, is the newest message an event saw: author "owner" means the person wrote it themselves (in Gmail, Slack, or from QM).',
  'If the person has already answered and nothing newer asks anything of them, end with {"resolution":{"kind":"replied","reason":"<one line>"}}. If the conversation needs nothing from them (closed out, a plain thanks, someone else answered, machine noise), end with {"resolution":{"kind":"no_reply_needed","reason":"<one line>"}}. Re-read the conversation from the source when the payload is not enough to tell. When in doubt, draft a reply.',
].join("\n");

export async function applyReplyResolution(
  items: Pick<LoopItemLedger, "recordAction">,
  loop: Loop,
  item: LoopItem,
  parsed: unknown,
): Promise<boolean> {
  const resolution = isReplyLoop(loop, item) ? parseResolution(parsed) : null;
  if (!resolution) return false;
  const latest = item.sourcePayload?.latestEvent as LatestEvent | undefined;
  const ownText = latest?.author === "owner" ? latest.text : undefined;
  const result = resolution.kind === "replied" ? ownText : resolution.reason;
  await items.recordAction(item.id, {
    kind: resolution.kind,
    outcome: "dismissed",
    ...(result ? { result } : {}),
  });
  return true;
}

function parseResolution(parsed: unknown): { kind: "replied" | "no_reply_needed"; reason: string } | null {
  if (!parsed || typeof parsed !== "object" || !("resolution" in parsed)) return null;
  const raw = (parsed as { resolution?: unknown }).resolution;
  if (!raw || typeof raw !== "object") return null;
  const { kind, reason } = raw as { kind?: unknown; reason?: unknown };
  if (kind !== "replied" && kind !== "no_reply_needed") return null;
  return { kind, reason: typeof reason === "string" ? reason.slice(0, 500) : "" };
}

export function renderSourceInboxTask(loopId: string, source: string): string {
  return `Source restriction: scan only ${source}. Never read or ingest another source. Keep a separate watermark for this Loop.\n${renderInboxSyncTask(loopId)}`;
}

function isInboxLoop(loop: Loop): boolean {
  return loop.surface === INBOX_LOOP_SURFACE;
}

export async function findInboxLoop(store: LoopStore, owner: string): Promise<Loop | null> {
  const scope = scopeId("personal", owner);
  const loops = await store.list();
  return loops.find((loop) => loop.ownerScopeId === scope && isInboxLoop(loop)) ?? null;
}

export async function ensureInboxLoop(store: LoopStore, owner: string): Promise<Loop> {
  const existing = await findInboxLoop(store, owner);
  if (existing) return existing;
  const { loop } = await store.create({
    owner,
    createdBy: owner,
    ownerScopeId: scopeId("personal", owner),
    name: INBOX_LOOP_NAME,
    surface: INBOX_LOOP_SURFACE,
    sources: [...SOURCE_IDS],
    purpose: "Everything waiting on a reply from you, drafted and ready to send.",
    playbook: renderInboxSyncTask("$LOOP_ID"),
    successCondition: INBOX_SUCCESS_CONDITION,
    shipActions: [{ action: "send", gate: "hold" }],
  });
  return loop;
}
