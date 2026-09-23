import type { LoopItem, LoopItemStatus, LoopOutput, LoopSourcePayload } from "../../types.ts";
import { sendBuffered } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx } from "./route.ts";
import { loadAdministrable } from "./loops.ts";

interface BoardStage {
  name: string;
  state: "active" | "done";
  ts: number;
}

interface BoardTicket {
  id: string;
  title: string;
  url: string;
  project: string;
  assignee: string;
  status: "working" | "done" | "failed";
  stages: BoardStage[];
  mr?: string;
  terminalKind?: "ready_for_review";
}

interface BoardQueueEntry {
  id: string;
  title: string;
  url: string;
  assignee: string;
}

interface BoardFeedEntry {
  ts: number;
  text: string;
}

interface BoardSnapshot {
  updatedAt: number;
  tickets: BoardTicket[];
  queue: BoardQueueEntry[];
  feed: BoardFeedEntry[];
}

const FEED_MAX = 200;

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function stringField(payload: LoopSourcePayload | undefined, name: string): string {
  const value = payload?.[name];
  return typeof value === "string" ? value : "";
}

function stagesOf(item: LoopItem): BoardStage[] {
  const raw = item.sourcePayload?.stages;
  if (!Array.isArray(raw)) return [];
  const stages: BoardStage[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const { name, state, ts } = entry;
    if (typeof name !== "string" || (state !== "active" && state !== "done") || typeof ts !== "number") continue;
    stages.push({ name, state, ts });
  }
  return stages;
}

function newestPrByItem(outputs: LoopOutput[]): Map<string, string> {
  const oldestFirst = [...outputs].sort((a, b) => a.createdAt - b.createdAt || compareText(a.id, b.id));
  const refs = new Map<string, string>();
  for (const output of oldestFirst) {
    if (output.shipAction !== "open_pr" || output.externalRef === undefined) continue;
    refs.set(output.itemId, output.externalRef);
  }
  return refs;
}

function ticketStatus(status: LoopItemStatus): BoardTicket["status"] {
  if (status === "shipped") return "done";
  return status === "failed" ? "failed" : "working";
}

function newestStamp(rows: Array<{ updatedAt: number }>): number {
  if (rows.length === 0) return Date.now();
  return rows.reduce((newest, row) => (row.updatedAt > newest ? row.updatedAt : newest), 0);
}

function buildSnapshot(items: LoopItem[], outputs: LoopOutput[]): BoardSnapshot {
  const oldestFirst = [...items].sort((a, b) => a.createdAt - b.createdAt || compareText(a.sourceKey, b.sourceKey));
  const prByItem = newestPrByItem(outputs);
  const tickets: BoardTicket[] = [];
  const queue: BoardQueueEntry[] = [];
  const feed: BoardFeedEntry[] = [];
  for (const item of oldestFirst) {
    if (item.status === "skipped") continue;
    const title = item.sourceSummary ?? "";
    const url = stringField(item.sourcePayload, "url");
    const assignee = stringField(item.sourcePayload, "assignee");
    const stages = stagesOf(item);
    for (const message of item.thread ?? []) feed.push({ ts: message.at, text: message.text });
    for (const stage of stages) feed.push({ ts: stage.ts, text: `${item.sourceKey} ${stage.name}` });
    if (item.status === "queued") {
      queue.push({ id: item.sourceKey, title, url, assignee });
      continue;
    }
    const status = ticketStatus(item.status);
    const mr = prByItem.get(item.id);
    tickets.push({
      id: item.sourceKey,
      title,
      url,
      project: stringField(item.sourcePayload, "project"),
      assignee,
      status,
      stages,
      ...(mr !== undefined ? { mr } : {}),
      ...(status === "done" ? { terminalKind: "ready_for_review" as const } : {}),
    });
  }
  feed.sort((a, b) => a.ts - b.ts);
  return { updatedAt: newestStamp([...items, ...outputs]), tickets, queue, feed: feed.slice(-FEED_MAX) };
}

export async function getLoopBoard(ctx: ApiCtx): Promise<void> {
  const loaded = await loadAdministrable(ctx);
  if (!loaded) return;
  const { deps, loop } = loaded;
  const [items, outputs] = await Promise.all([deps.items.byLoop(loop.id), deps.outputs.byLoop(loop.id)]);
  sendBuffered(
    ctx.res,
    200,
    { "content-type": "application/json", "cache-control": "no-store" },
    JSON.stringify(buildSnapshot(items, outputs)),
  );
}
