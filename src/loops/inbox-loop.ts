import type { Loop } from "../types.ts";
import { scopeId } from "../types.ts";
import type { LoopStore } from "./loop-store.ts";
import { SOURCE_IDS } from "./sources/index.ts";

const INBOX_LOOP_NAME = "Inbox";

const INBOX_LOOP_SURFACE = "inbox";

export const INBOX_SYNC_TASK_VERSION = 3;

export const INBOX_SYNC_CRON_TITLE = "Inbox sync";

export const INBOX_SYNC_DEFAULT_EVERY_MS = 15 * 60 * 1000;

export const INBOX_LEDGER_MAX_ITEMS = 500;

export const INBOX_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const INBOX_SUCCESS_CONDITION =
  "Every Slack message and email waiting on the person's own reply is on the ledger with a ready-to-send draft in their voice, and nothing else is.";

export function renderInboxSyncTask(loopId: string): string {
  return `Inbox sync v${INBOX_SYNC_TASK_VERSION}. Keep the user's QM inbox loop current: every Slack message and email genuinely WAITING ON A REPLY FROM THEM gets a ledger item with a ready-to-send draft in their own voice. The inbox UI is the only delivery surface — never message the user, and NEVER send a reply yourself; you produce drafts only.

1. GET $AGENT_API_URL/v1/loops/${loopId}/items (agent capability header) — note existing items: skip any dedupeKey already tracked unless a NEWER inbound message has arrived since (compare sourceAt); re-post such items with the fresh message and a fresh draft.
   - Closed-loop detection: for every item still in state "held" or "pending", re-read its thread. If the LATEST message is FROM THE USER THEMSELVES — their own Slack userId on Slack, or their own email address in the From line on Gmail — they already replied outside QM, so POST $AGENT_API_URL/v1/loops/${loopId}/items/<itemId>/action with {"kind":"replied","args":{"text":"<their message, <=200 chars>"}} to close it. This applies to both Gmail and Slack items. Do NOT reopen or redraft an item the user has already answered.
2. Keep a lastScanAt watermark in a state file on your workspace (e.g. ~/workspace/inbox-sync/STATE.md); scan each connected source since that watermark (fall back to ~3 days on first run), and advance the watermark only after a successful pass, so outages and missed fires backfill instead of leaving silent gaps. Skip a source whose app is not connected. Judge "waiting on a reply" like a good chief of staff, with a deliberate asymmetry: (a) NEEDS REPLY: direct questions, requests, intros, and personal messages that expect acknowledgment; when in any doubt, this bucket. (b) PROBABLY RESOLVED: the transcript reads closed (a thanks, a "sounds good", a thread someone else already answered) but a reasonable person might still send a word; post the item anyway with "probablyResolved": true in the item body and a draft included; the UI shows these in a muted section. NEVER silently drop a human conversation you judged resolved; demote it instead. (c) SKIP entirely: only unmistakable machine noise (newsletters, receipts, calendar notices, bot chatter). Human words never skip; the lowest they go is probablyResolved.
   - Gmail (use the google-workspace skill): INBOX threads where the LAST message is inbound and the user is in To or Cc. sourceKey = the Gmail threadId. Record gmail metadata: threadId, messageId, the RFC-2822 Message-ID header (rfcMessageId), subject, and the reply recipients (to = reply-all sender+others minus the user; cc as appropriate).
   - Slack (use your Slack access as the user): unanswered DMs, @mentions, and thread replies addressed to the user. ONE ITEM PER CONVERSATION, never per message: for DMs and group DMs sourceKey = the channelId alone (two people posting in the same group DM is ONE item, refreshed with the latest state and a single draft answering everything outstanding); for channels sourceKey = channelId:threadTs for threaded asks (channelId:ts of a top-level message anchoring its own thread). Record slack metadata: channelId, channelLabel ("#channel" or "DM with <name>"), ts (the LATEST waiting message), and threadTs only when the conversation lives in a thread.
3. For each new or refreshed item, investigate before drafting: read the whole thread, and check whatever context makes the reply substantive (calendar for scheduling asks, earlier email/Slack history for open questions). Draft the reply in the user's own voice — for email follow the email-draft-in-voice skill (build the voice profile first if it is missing); for Slack match how the user actually writes in Slack (check their recent messages: register, length, punctuation). Punctuation hard rule: never use em dashes or en dashes in a draft; use a comma, period, or "..." instead, and re-read every draft before posting to strip any that slipped in.
4. POST $AGENT_API_URL/v1/loops/${loopId}/items with {"items": [...]}. Each item: source ("gmail"|"slack"), sourceKey, title (subject or channel label), from (display name), fromDetail (address or @handle), snippet (the waiting message, <=200 chars), context (up to 6 prior thread messages as {author, at, text}), receivedAt (ms epoch of the waiting message), externalUrl (deep link to the original in Gmail/Slack), draft ({to, cc, subject, body} for gmail — body plain text; {body} for slack), and the gmail/slack metadata block from step 2. IMAGES: when a thread message carries image attachments, include an "images" array of their https URLs (Slack: url_private; up to 4) on the matching context entry, and on the item itself for the waiting message — the UI proxies and renders them inline as the user's own eyes would see them in Slack/Gmail.
5. Found nothing new and changed nothing? Finish silently. Only raise your voice on a real fault (a connector that errors repeatedly) — and then only briefly.`;
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
