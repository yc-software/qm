export interface SurfaceKey {
  surface?: string;
  account?: string;
}

export interface SurfaceSource {
  account: string;
  workspace: string;
  assistant: string;
}

export interface CachedMessage extends SurfaceKey {
  container: string;
  ts: string;
  sub?: string;
  broadcast?: boolean;
  subtype?: string;
  authorId?: string;
  botId?: string;
  authorName?: string;
  text: string;
  replyCount?: number;
  files?: Array<{ fileId: string; name?: string; title?: string; size?: number; mimetype?: string }>;
  mentions?: Record<string, string>;
  self?: boolean;
  bot?: boolean;
  mentionsSelf?: boolean;
  editedAt?: number;
  deleted?: boolean;
  deletedAt?: number;
  handled?: boolean;
  createdAt: number;
}

export interface ContainerState {
  container: string;
  lastTs?: string;
  oldestTs?: string;
  name?: string;
  kind?: "channel" | "dm" | "group";
  source?: SurfaceSource;
  updatedAt: number;
}

export interface ActiveThread {
  container: string;
  sub: string;
  lastTs: string;
  messageCount: number;
  lastActivityAt: number;
}

export interface IngestEvent extends SurfaceKey {
  container: string;
  ts: string;
  sub?: string | null;
  broadcast?: boolean;
  subtype?: string;
  authorId?: string;
  botId?: string;
  authorName?: string;
  text?: string;
  raw?: Record<string, unknown>;
  mentions?: Record<string, string>;
  self?: boolean;
  bot?: boolean;
  mentionsSelf?: boolean;
  editedAt?: number;
  deleted?: boolean;
  handled?: boolean;
  createdAt?: number;
  files?: Array<{ fileId: string; name?: string; title?: string; size?: number; mimetype?: string }>;
  members?: string[];
  containerName?: string;
  kind?: "channel" | "dm" | "group";
  source?: SurfaceSource;
}

export interface ContainerSummary extends ContainerState {
  members: string[];
  messageCount: number;
}

export interface ReadMessagesOpts extends SurfaceKey {
  at?: string;
  sub?: string | null;
  timestamps?: string[];
  tsSuffix?: string;
  oldestFirst?: boolean;
  channelHistory?: boolean;
  limit?: number;
  after?: string;
  before?: string;
  includeDeleted?: boolean;
  noFallback?: boolean;
  self?: boolean;
}

interface RevisedSinceOpts extends SurfaceKey {
  thread?: string;
}

export interface SearchOpts extends SurfaceKey {
  container?: string;
  limit?: number;
}

export type LiveFallback = (container: string, opts: ReadMessagesOpts) => Promise<CachedMessage[] | null>;

export interface SurfaceCache {
  ingest(events: IngestEvent[]): Promise<{ upserted: number }>;
  markHandled(container: string, ts: string, key?: SurfaceKey): Promise<void>;
  readMessages(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  revisedSince(container: string, since: number, opts?: RevisedSinceOpts): Promise<CachedMessage[]>;
  search(query: string, opts?: SearchOpts): Promise<CachedMessage[]>;
  activeThreads(opts?: SurfaceKey & { container?: string; limit?: number }): Promise<ActiveThread[]>;
  members(container: string, key?: SurfaceKey): Promise<string[]>;
  isMember(container: string, principalId: string, key?: SurfaceKey): Promise<boolean>;
  containerState(container: string, key?: SurfaceKey): Promise<ContainerState | null>;
  listContainers(opts?: SurfaceKey & { limit?: number }): Promise<ContainerSummary[]>;
  close(): Promise<void>;
}
