export interface CachedMessage {
  container: string;
  ts: string;
  sub?: string;
  authorId?: string;
  authorName?: string;
  text: string;
  mentions?: Record<string, string>;
  self?: boolean;
  bot?: boolean;
  mentionsSelf?: boolean;
  editedAt?: number;
  deleted?: boolean;
  handled?: boolean;
  createdAt: number;
}

export interface CachedFile {
  container: string;
  ts: string;
  fileId: string;
  name?: string;
  mimetype?: string;
  createdAt: number;
}

export interface ContainerState {
  container: string;
  lastTs?: string;
  oldestTs?: string;
  name?: string;
  kind?: "channel" | "dm" | "group";
  updatedAt: number;
}

export interface ActiveThread {
  container: string;
  sub: string;
  lastTs: string;
  messageCount: number;
  lastActivityAt: number;
}

export interface IngestEvent {
  container: string;
  ts: string;
  sub?: string;
  authorId?: string;
  authorName?: string;
  text?: string;
  mentions?: Record<string, string>;
  self?: boolean;
  bot?: boolean;
  mentionsSelf?: boolean;
  editedAt?: number;
  deleted?: boolean;
  handled?: boolean;
  createdAt?: number;
  files?: Array<{ fileId: string; name?: string; mimetype?: string }>;
  members?: string[];
  containerName?: string;
  kind?: "channel" | "dm" | "group";
}

export interface ContainerSummary extends ContainerState {
  members: string[];
  messageCount: number;
}

export interface ReadMessagesOpts {
  sub?: string;
  limit?: number;
  after?: string;
  before?: string;
  includeDeleted?: boolean;
  noFallback?: boolean;
}

export interface SearchOpts {
  container?: string;
  limit?: number;
}

export type LiveFallback = (container: string, opts: ReadMessagesOpts) => Promise<CachedMessage[] | null>;

export interface SurfaceCache {
  ingest(events: IngestEvent[]): Promise<{ upserted: number }>;
  markHandled(container: string, ts: string): Promise<void>;
  readMessages(container: string, opts?: ReadMessagesOpts): Promise<CachedMessage[]>;
  search(query: string, opts?: SearchOpts): Promise<CachedMessage[]>;
  activeThreads(opts?: { container?: string; limit?: number }): Promise<ActiveThread[]>;
  members(container: string): Promise<string[]>;
  isMember(container: string, principalId: string): Promise<boolean>;
  containerState(container: string): Promise<ContainerState | null>;
  listContainers(opts?: { limit?: number }): Promise<ContainerSummary[]>;
  close(): Promise<void>;
}
