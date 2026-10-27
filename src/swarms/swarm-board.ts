import { createPgPool } from "../persistence/pg-pool.ts";

export interface SwarmBoardPost {
  id: string;
  swarmId: string;
  channel: string;
  threadId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
}

interface SwarmBoardChannel {
  name: string;
  description: string;
  posts: number;
  lastPostAt: number | null;
}

interface SwarmBoardPage {
  channel?: string;
  before?: number;
  limit: number;
}

export interface SwarmBoard {
  ensure(swarmId: string, createdBy: string, now: number): Promise<void>;
  firstBoard(sessionIds: readonly string[]): Promise<string | null>;
  channels(swarmId: string): Promise<SwarmBoardChannel[]>;
  createChannel(swarmId: string, name: string, description: string, createdBy: string, now: number): Promise<boolean>;
  hasChannel(swarmId: string, name: string): Promise<boolean>;
  threads(swarmId: string, page: SwarmBoardPage): Promise<Array<SwarmBoardPost & { replies: number }>>;
  search(swarmId: string, query: string, page: SwarmBoardPage): Promise<SwarmBoardPost[]>;
  thread(swarmId: string, rootId: string, after: number | undefined, limit: number): Promise<SwarmBoardPost[]>;
  post(swarmId: string, id: string): Promise<SwarmBoardPost | null>;
  insert(post: SwarmBoardPost): Promise<void>;
  unnotified(swarmId: string, before: number): Promise<SwarmBoardPost[]>;
  markNotified(swarmId: string, id: string): Promise<void>;
  subscribe(swarmId: string, memberId: string, channel: string): Promise<void>;
  unsubscribe(swarmId: string, memberId: string, channel: string): Promise<boolean>;
  subscribers(swarmId: string, channel: string): Promise<string[]>;
}

const POST_COLUMNS = "id, swarm_id, channel, thread_id, author_id, author_name, body, created_at";

function toPost(row: Record<string, unknown>): SwarmBoardPost {
  return {
    id: row.id as string,
    swarmId: row.swarm_id as string,
    channel: row.channel as string,
    threadId: (row.thread_id as string | null) ?? null,
    authorId: row.author_id as string,
    authorName: row.author_name as string,
    body: row.body as string,
    createdAt: Number(row.created_at),
  };
}

const BOARD_TABLES = [
  `CREATE TABLE IF NOT EXISTS swarm_boards(
        swarm_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at BIGINT NOT NULL
      )`,
  `CREATE TABLE IF NOT EXISTS swarm_board_channels(
        swarm_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (swarm_id, name)
      )`,
  `CREATE TABLE IF NOT EXISTS swarm_board_posts(
        id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL, channel TEXT NOT NULL, thread_id TEXT,
        author_id TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL
      )`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_board_posts_channel ON swarm_board_posts(swarm_id, channel, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_swarm_board_posts_thread ON swarm_board_posts(swarm_id, thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS swarm_board_subscriptions(
        swarm_id TEXT NOT NULL, member_id TEXT NOT NULL, channel TEXT NOT NULL,
        PRIMARY KEY (swarm_id, member_id, channel)
      )`,
];

export function createPostgresSwarmBoard(connectionString: string): SwarmBoard {
  const pg = createPgPool(connectionString, [
    { id: "swarm-board/0001", statements: BOARD_TABLES },
    {
      id: "swarm-board/0002",
      statements: [
        "ALTER TABLE swarm_board_posts ADD COLUMN IF NOT EXISTS notify_pending BOOLEAN NOT NULL DEFAULT false",
        "CREATE INDEX IF NOT EXISTS idx_swarm_board_posts_notify ON swarm_board_posts(swarm_id, created_at) WHERE notify_pending",
      ],
    },
  ]);
  return {
    async ensure(swarmId, createdBy, now) {
      await pg.q(
        "INSERT INTO swarm_boards(swarm_id, created_by, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [swarmId, createdBy, now],
      );
      await pg.q(
        "INSERT INTO swarm_board_channels(swarm_id, name, description, created_by, created_at) VALUES ($1, 'general', 'Coordination', $2, $3) ON CONFLICT DO NOTHING",
        [swarmId, createdBy, now],
      );
    },
    async firstBoard(sessionIds) {
      if (!sessionIds.length) return null;
      const rows = await pg.q("SELECT swarm_id FROM swarm_boards WHERE swarm_id = ANY($1)", [[...sessionIds]]);
      const found = new Set(rows.map((row) => row.swarm_id as string));
      return sessionIds.find((id) => found.has(id)) ?? null;
    },
    async channels(swarmId) {
      const rows = await pg.q(
        `SELECT c.name, c.description, count(p.id)::int AS posts, max(p.created_at) AS last_post_at
           FROM swarm_board_channels c
           LEFT JOIN swarm_board_posts p ON p.swarm_id = c.swarm_id AND p.channel = c.name
          WHERE c.swarm_id = $1
          GROUP BY c.name, c.description, c.created_at
          ORDER BY c.created_at, c.name`,
        [swarmId],
      );
      return rows.map((row) => ({
        name: row.name as string,
        description: row.description as string,
        posts: Number(row.posts),
        lastPostAt: row.last_post_at === null ? null : Number(row.last_post_at),
      }));
    },
    async createChannel(swarmId, name, description, createdBy, now) {
      const { rowCount } = await pg.query(
        "INSERT INTO swarm_board_channels(swarm_id, name, description, created_by, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        [swarmId, name, description, createdBy, now],
      );
      return rowCount > 0;
    },
    async hasChannel(swarmId, name) {
      const rows = await pg.q("SELECT 1 FROM swarm_board_channels WHERE swarm_id = $1 AND name = $2", [swarmId, name]);
      return rows.length > 0;
    },
    async threads(swarmId, page) {
      const rows = await pg.q(
        `SELECT p.id, p.swarm_id, p.channel, p.thread_id, p.author_id, p.author_name, p.body, p.created_at,
                (SELECT count(*)::int FROM swarm_board_posts r WHERE r.swarm_id = p.swarm_id AND r.thread_id = p.id) AS replies
           FROM swarm_board_posts p
          WHERE p.swarm_id = $1 AND p.thread_id IS NULL
            AND ($2::text IS NULL OR p.channel = $2) AND ($3::bigint IS NULL OR p.created_at < $3)
          ORDER BY p.created_at DESC LIMIT $4`,
        [swarmId, page.channel ?? null, page.before ?? null, page.limit],
      );
      return rows.map((row) => ({ ...toPost(row), replies: Number(row.replies) }));
    },
    async search(swarmId, query, page) {
      const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = await pg.q(
        `SELECT ${POST_COLUMNS} FROM swarm_board_posts
          WHERE swarm_id = $1 AND body ILIKE $2
            AND ($3::text IS NULL OR channel = $3) AND ($4::bigint IS NULL OR created_at < $4)
          ORDER BY created_at DESC LIMIT $5`,
        [swarmId, pattern, page.channel ?? null, page.before ?? null, page.limit],
      );
      return rows.map(toPost);
    },
    async thread(swarmId, rootId, after, limit) {
      const rows = await pg.q(
        `SELECT ${POST_COLUMNS} FROM swarm_board_posts
          WHERE swarm_id = $1 AND (id = $2 OR thread_id = $2) AND ($3::bigint IS NULL OR created_at > $3)
          ORDER BY (thread_id IS NOT NULL), created_at, id LIMIT $4`,
        [swarmId, rootId, after ?? null, limit],
      );
      return rows.map(toPost);
    },
    async post(swarmId, id) {
      const rows = await pg.q(`SELECT ${POST_COLUMNS} FROM swarm_board_posts WHERE swarm_id = $1 AND id = $2`, [
        swarmId,
        id,
      ]);
      return rows[0] ? toPost(rows[0]) : null;
    },
    async insert(post) {
      await pg.q(
        `INSERT INTO swarm_board_posts(${POST_COLUMNS}, notify_pending) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [post.id, post.swarmId, post.channel, post.threadId, post.authorId, post.authorName, post.body, post.createdAt],
      );
    },
    async unnotified(swarmId, before) {
      const rows = await pg.q(
        `SELECT ${POST_COLUMNS} FROM swarm_board_posts
          WHERE swarm_id = $1 AND notify_pending AND created_at < $2 ORDER BY created_at LIMIT 50`,
        [swarmId, before],
      );
      return rows.map(toPost);
    },
    async markNotified(swarmId, id) {
      await pg.q("UPDATE swarm_board_posts SET notify_pending = false WHERE swarm_id = $1 AND id = $2", [swarmId, id]);
    },
    async subscribe(swarmId, memberId, channel) {
      await pg.q(
        "INSERT INTO swarm_board_subscriptions(swarm_id, member_id, channel) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [swarmId, memberId, channel],
      );
    },
    async unsubscribe(swarmId, memberId, channel) {
      const { rowCount } = await pg.query(
        "DELETE FROM swarm_board_subscriptions WHERE swarm_id = $1 AND member_id = $2 AND channel = $3",
        [swarmId, memberId, channel],
      );
      return rowCount > 0;
    },
    async subscribers(swarmId, channel) {
      const rows = await pg.q(
        "SELECT member_id FROM swarm_board_subscriptions WHERE swarm_id = $1 AND channel = $2 ORDER BY member_id",
        [swarmId, channel],
      );
      return rows.map((row) => row.member_id as string);
    },
  };
}
