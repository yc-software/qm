import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

type Row = Record<string, unknown>;
export interface AggregateProfile {
  collectedAt: string;
  results: Array<{ label: string; rows: Row[] }>;
}
export interface SeedSession {
  n: number;
  id: string;
  scope: string;
  surface: string | null;
  origin: string;
  thread: string;
  messages: number;
  turns: number;
  title: string;
  at: number;
  otherOffset: number;
  assistantOffset: number;
  tapeEntries: number;
}
export interface SeedPlan {
  schemaVersion: 1;
  fixtureId: string;
  profileSha256: string;
  scale: number;
  anchorTime: number;
  targets: Record<string, number>;
  sessions: SeedSession[];
  principals: Array<{ principalId: string; sessionCount: number }>;
  scopes: string[];
  cohorts: Record<string, { principalId: string; sessionCount: number; scopeId: string; rootCase: SeedCase }>;
  cases: Record<string, SeedCase>;
  multiview: SeedCase[];
  aggregates: Record<string, Row[]>;
  entryTypes: Record<string, number>;
  earlierEntry: { sessionId: string; seq: number };
  sidebarPagination: { principalId: string; sessionId: string };
  memberships: Array<{ sessionId: string; principalId: string }>;
  adminHistoryCohorts: Record<string, { scopeId: string; conversationCount: number; rootCase: SeedCase }>;
  entrySearchTargets?: Record<string, number>;
  tapeKinds: Record<string, number>;
  canonicalTapeRows: number;
  resourceOwners: Record<
    string,
    Array<{
      scopeId: string;
      rows: number;
      enabledRows?: number;
      latestBodyBytes?: number;
      latestFacts?: number;
      latestNewlines?: number;
    }>
  >;
  inventory: Array<{
    schema: string;
    table: string;
    sourceRows: number;
    sourceBytes: number;
    status: "planned" | "excluded" | "unclassified";
    reason: string;
  }>;
  sourceSnapshots: Array<{ collectedAt: string; labels: string[] }>;
}
export interface SeedCase {
  sessionId: string;
  principalId: string;
  scopeId: string;
  threadRef: string;
  title: string;
  expectedVisibleText: string;
  earlierVisibleText: string;
  messageCount: number;
  readOnly?: boolean;
  transcriptStorage?: "canonical" | "legacy" | "mixed";
  transcriptBoundarySeq?: number;
}

export const principalId = (n: number): string => `perf-${String(n).padStart(5, "0")}@example.invalid`;
export const fixtureGroupId = (n: number): string => `G${String(n).padStart(10, "0")}`;
export const FIXTURE_TAIL_TURNS = 25;
export const PAYLOAD_BUCKETS = 1024;
export const UI_TABLES = [
  "admin_grants",
  "session_pins",
  "channel_files",
  "keychain_asks",
  "channel_state",
  "keychain_credentials",
  "keychain_grants",
  "deployments",
  "projects",
  "monitors",
  "approvals",
  "loops",
  "loop_items",
  "base_model_configs",
  "soul_configs",
  "connector_status",
  "model_registry",
  "command_policies",
  "security_postures",
  "sharing_postures",
  "interactive_fast_mode_flag",
  "individual_model_auth_flag",
  "credential_liveness",
  "feature_flags",
  "mcp_servers",
  "suggested_activity_profiles",
  "webhooks",
  "webhook_history",
  "loop_outputs",
  "approval_grants",
  "session_shares",
  "swarms",
  "sandbox_routing",
  "sandbox_defaults",
  "sandbox_resources",
  "sandbox_resource_rollout",
  "deactivated_principals",
  "slack_emoji_catalog",
  "channel_policy",
  "channel_policy_history",
  "deployment_access",
  "tasks",
  "task_events",
  "file_uploads",
  "environments",
];
export const syntheticId = (kind: string, n: number): string => {
  const hash = createHash("md5").update(`qm-perf-${kind}-${n}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};
export const sentinel = (sessionId: string, edge: "first" | "last"): string => `QM PERF ${sessionId} ${edge}`;

function number(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error(`Invalid aggregate ${name}`);
  return n;
}

export function validateTarget(url: string, expectedName: string): string {
  if (!/^qm_perf_[a-z0-9_]{1,48}$/.test(expectedName)) throw new Error("An explicit qm_perf_* database is required");
  const parsed = new URL(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    decodeURIComponent(parsed.pathname.slice(1)) !== expectedName
  )
    throw new Error("Database URL does not match the explicit fixture database name");
  if (parsed.searchParams.has("options"))
    throw new Error("Database URL options are not accepted by the fixture seeder");
  return expectedName;
}

export function quantileBounds(
  count: number,
  quantiles: number[],
  max: number,
  probabilities = [0.5, 0.9, 0.95, 0.99],
  minimum = 1,
): Array<[number, number]> {
  if (!count) return [];
  const anchors = new Map<number, number>([
    [0, minimum],
    [count - 1, Math.max(minimum, Math.round(max))],
  ]);
  for (let i = 0; i < quantiles.length; i++) {
    const rank = Math.min(count - 1, Math.max(0, Math.ceil(probabilities[i]! * count) - 1));
    if (rank !== count - 1) anchors.set(rank, Math.max(minimum, Math.round(quantiles[i]!)));
  }
  const sorted = [...anchors].sort((a, b) => a[0] - b[0]);
  const result: Array<[number, number]> = [];
  let segment = 0;
  for (let i = 0; i < count; i++) {
    while (segment + 1 < sorted.length && sorted[segment + 1]![0] <= i) segment++;
    const left = sorted[segment]!;
    const right = sorted[segment + 1] ?? left;
    result.push(i === left[0] ? [left[1], left[1]] : [left[1], Math.max(left[1], right[1])]);
  }
  return result;
}

export function fitCounts(bounds: Array<[number, number]>, total: number, preferred?: number[]): number[] {
  const low = bounds.reduce((sum, b) => sum + b[0], 0);
  const capacity = bounds.reduce((sum, b) => sum + b[1] - b[0], 0);
  if (!Number.isSafeInteger(total) || total < low || total > low + capacity)
    throw new Error(`Aggregate total ${total} is incompatible with quantile bounds [${low}, ${low + capacity}]`);
  if (preferred) {
    const base = bounds.map(([min, max], i) => Math.max(min, Math.min(max, Math.round(preferred[i]!))));
    const delta = total - base.reduce((sum, n) => sum + n, 0);
    if (!delta) return base;
    const weights = bounds.map(([min, max], i) => (delta > 0 ? max - base[i]! : base[i]! - min));
    const adjustment = apportion(weights, Math.abs(delta));
    return base.map((n, i) => n + Math.sign(delta) * adjustment[i]!);
  }
  let residue = 0;
  return bounds.map(([min, max]) => {
    const exact = capacity ? ((total - low) * (max - min)) / capacity : 0;
    const rounded = Math.floor(exact + residue + 1e-9);
    residue += exact - rounded;
    return min + rounded;
  });
}

function ownerQuantileBounds(count: number, quantiles: number[], max: number, minimum = 1): Array<[number, number]> {
  const probabilities = [0.5, 0.95, 0.99];
  const bounds = quantileBounds(count, quantiles, max, probabilities, minimum);
  if (count > 1) bounds[0] = [minimum, Math.max(minimum, Math.round(quantiles[0]!))];
  for (let i = 0; i < probabilities.length; i++) {
    const rank = probabilities[i]! * (count - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low > 0 && low < count - 1)
      bounds[low] = [Math.max(minimum, Math.floor(quantiles[i]!)), Math.max(minimum, Math.floor(quantiles[i]!))];
    if (high > 0 && high < count - 1)
      bounds[high] = [Math.max(minimum, Math.ceil(quantiles[i]!)), Math.max(minimum, Math.ceil(quantiles[i]!))];
  }
  return bounds;
}

function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) throw new Error("Empty aggregate distribution");
  let carry = 0;
  return weights.map((weight) => {
    const exact = (weight * total) / sum + carry;
    const value = Math.floor(exact + 1e-9);
    carry = exact - value;
    return value;
  });
}

export function makeSeedPlan(profiles: AggregateProfile[], scale = 1): SeedPlan {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error("Scale must be in (0, 1]");
  if (!profiles.length) throw new Error("At least one aggregate profile is required");
  const aggregates: Record<string, Row[]> = {};
  for (const profile of profiles) {
    if (!Array.isArray(profile.results)) throw new Error("Aggregate profile results are missing");
    for (const result of profile.results) aggregates[result.label] = result.rows;
  }
  const profileSha256 = createHash("sha256").update(JSON.stringify(profiles)).digest("hex");
  const anchorTime = Date.parse(profiles[0]!.collectedAt);
  if (!Number.isFinite(anchorTime)) throw new Error("Profile collectedAt is invalid");
  const targets: Record<string, number> = {};
  for (const row of [
    ...(aggregates.ui_table_counts ?? []),
    ...(aggregates.tables ?? []),
    ...(aggregates.small_table_estimates ?? []),
    ...(aggregates.all_table_estimates ?? []).filter((row) => UI_TABLES.includes(String(row.relname))),
  ]) {
    const table = String(row.relname);
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Invalid aggregate table name");
    if (!(table in targets)) {
      const count = number(row.n_live_tup, table);
      targets[table] = Math.max(UI_TABLES.includes(table) && count > 0 ? 1 : 0, Math.round(count * scale));
    }
  }
  const entrySearchTargets =
    scale === 1 && aggregates.entry_search_exact_types?.length
      ? Object.fromEntries(
          aggregates.entry_search_exact_types.map((row) => [String(row.type), number(row.rows, "search rows")]),
        )
      : undefined;
  if (entrySearchTargets)
    targets.session_entry_search = Object.values(entrySearchTargets).reduce((sum, count) => sum + count, 0);
  const participant = aggregates.participant_distribution?.[0];
  if (!participant) throw new Error("Participant distribution is required");
  const principalCount = Math.round(number(participant.principals, "principals"));
  const membershipCount = Math.round(number(participant.memberships, "memberships"));
  const principalCounts = fitCounts(
    quantileBounds(
      principalCount,
      participant.sessions_per_principal as number[],
      number(participant.max_sessions, "max_sessions"),
    ),
    membershipCount,
  );
  const principals = principalCounts.map((sessionCount, i) => ({ principalId: principalId(i + 1), sessionCount }));
  if (principals.length < 3) throw new Error("At least three principal cohorts are required");
  targets.participants = membershipCount;
  targets.sessions = Math.max(targets.sessions ?? 0, Math.max(...principalCounts) + 12);
  const groups = aggregates.session_distribution;
  if (!groups?.length) throw new Error("Session distribution is required");
  const sizes = apportion(
    groups.map((g) => number(g.sessions, "sessions")),
    targets.sessions,
  );
  if (scale < 1) {
    const webGroup = groups.findIndex((g) => g.surface === "web" && g.origin === "conversation");
    const background = groups.findIndex((g) => g.origin === "cron");
    const visible = sizes.reduce((sum, count, i) => sum + (groups[i]!.origin === "conversation" ? count : 0), 0);
    const extra = Math.max(0, Math.max(...principalCounts) + 12 - visible);
    if (webGroup < 0 || background < 0 || sizes[background]! < extra)
      throw new Error("Diagnostic scale cannot preserve the participant cohorts");
    sizes[webGroup]! += extra;
    sizes[background]! -= extra;
  }
  const groupBounds = groups.map((g, i) =>
    quantileBounds(sizes[i]!, g.messages as number[], number(g.max_messages, "max_messages")),
  );
  const bounds = groupBounds.flat();
  const minimumEntries = bounds.reduce((sum, b) => sum + b[0], 0);
  targets.session_entries = Math.max(targets.session_entries ?? 0, minimumEntries);
  const jointFor = (group: Row) =>
    aggregates.session_joint_distribution?.find((row) => row.surface === group.surface && row.origin === group.origin);
  const groupEntryBounds: Array<[number, number]> = groupBounds.map((b) => [
    b.reduce((sum, pair) => sum + pair[0], 0),
    b.reduce((sum, pair) => sum + pair[1], 0),
  ]);
  const messageTotals = fitCounts(
    groupEntryBounds,
    targets.session_entries,
    groups.map((group, i) => Number(jointFor(group)?.avg_messages ?? 0) * sizes[i]!),
  );
  const lengths = groupBounds.flatMap((b, i) => fitCounts(b, messageTotals[i]!));
  const turnCounts: number[] = [];
  const allTurnBounds: Array<[number, number]> = [];
  let offset = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const joint = jointFor(group);
    const turnBounds = quantileBounds(
      sizes[i]!,
      group.turns as number[],
      Number(group.max_turns ?? (group.turns as number[]).at(-1)),
      [0.5, 0.95, 0.99],
    );
    for (let j = 0; j < turnBounds.length; j++) {
      const maximum = Math.max(1, lengths[offset + j]! - 1);
      turnBounds[j] = [Math.min(turnBounds[j]![0], maximum), Math.min(turnBounds[j]![1], maximum)];
    }
    const minimum = turnBounds.reduce((sum, b) => sum + b[0], 0);
    const maximum = turnBounds.reduce((sum, b) => sum + b[1], 0);
    const requested = joint ? Math.round(Number(joint.avg_turns) * sizes[i]!) : minimum;
    if (scale === 1 && sizes[i]! >= 20 && joint && (requested < minimum || requested > maximum))
      throw new Error("Measured turn mean conflicts with turn quantiles");
    for (const count of fitCounts(turnBounds, Math.min(maximum, Math.max(minimum, requested)))) turnCounts.push(count);
    for (const bound of turnBounds) allTurnBounds.push(bound);
    offset += sizes[i]!;
  }
  if (entrySearchTargets?.user !== undefined) {
    const calibrated = fitCounts(allTurnBounds, entrySearchTargets.user, turnCounts);
    for (let i = 0; i < turnCounts.length; i++) turnCounts[i] = calibrated[i]!;
  }
  const scopes: string[] = [];
  const scopeRows = aggregates.scope_history_distribution ?? aggregates.scope_distribution ?? [];
  const personalCount = Number(scopeRows.find((r) => r.kind === "personal")?.scopes ?? 0);
  const personalOwners = new Map<number, string>([
    [personalCount - 1, principals.at(-1)!.principalId],
    [Math.ceil(personalCount * 0.95) - 1, principals[Math.ceil(principals.length * 0.95) - 1]!.principalId],
    [Math.ceil(personalCount * 0.5) - 1, principals[Math.ceil(principals.length * 0.5) - 1]!.principalId],
  ]);
  const availablePrincipals = principals
    .map((p) => p.principalId)
    .filter((p) => ![...personalOwners.values()].includes(p));
  let nextPrincipal = 0;
  for (const row of scopeRows) {
    const count = Math.round(number(row.scopes, "scope count"));
    if (!["personal", "channel", "group"].includes(String(row.kind))) throw new Error("Unknown scope kind");
    for (let i = 1; i <= count; i++) {
      let scope = `${row.kind}:perf-${i}`;
      if (row.kind === "group") scope = `group:${fixtureGroupId(i)}`;
      if (row.kind === "personal")
        scope = `personal:${personalOwners.get(i - 1) ?? availablePrincipals[nextPrincipal++] ?? principalId(i)}`;
      if (row.kind === "group" && i <= (targets.projects ?? 0))
        scope = `group:web-project-${syntheticId("project", i)}`;
      scopes.push(scope);
    }
  }
  if (!scopes.length) throw new Error("Scope distribution is required");
  if ((targets.channel_messages ?? 0) > 0)
    targets.channel_state = Math.max(
      targets.channel_state ?? 0,
      Math.min(targets.channel_messages!, scopes.filter((scope) => scope.startsWith("channel:")).length),
    );
  const scopeGroupBounds = scopeRows.map((row) =>
    quantileBounds(
      Number(row.scopes),
      row.sessions as number[],
      Number(row.max_sessions),
      (row.sessions as number[]).length === 4 ? [0.5, 0.9, 0.95, 0.99] : [0.5, 0.95, 0.99],
    ),
  );
  const scopeBounds = scopeGroupBounds.flat();
  const scopeTotals =
    scale === 1
      ? fitCounts(
          scopeGroupBounds.map((b) => [
            b.reduce((sum, pair) => sum + pair[0], 0),
            b.reduce((sum, pair) => sum + pair[1], 0),
          ]),
          targets.sessions,
          scopeRows.map((row) => Number(row.total_sessions ?? 0)),
        )
      : [];
  const scopeCounts =
    scale === 1
      ? scopeGroupBounds.flatMap((b, i) => fitCounts(b, scopeTotals[i]!))
      : fitCounts(
          scopeBounds.map(() => [1, targets.sessions!]),
          targets.sessions,
          apportion(
            scopeBounds.map(([low]) => low),
            targets.sessions,
          ),
        );
  const conversationCount = sizes.reduce(
    (sum, count, i) => sum + (groups[i]!.origin === "conversation" ? count : 0),
    0,
  );
  const conversationBounds = scopeRows
    .flatMap((row) =>
      quantileBounds(
        Number(row.scopes),
        (row.conversations as number[]) ?? (row.sessions as number[]),
        Number(row.max_conversations ?? row.max_sessions),
        row.conversations ? [0.5, 0.9, 0.95, 0.99] : [0.5, 0.95, 0.99],
        0,
      ),
    )
    .map(([min, max], i): [number, number] => [Math.min(min, scopeCounts[i]!), Math.min(max, scopeCounts[i]!)]);
  const minConversations = conversationBounds.reduce((sum, b) => sum + b[0], 0);
  const maxConversations = conversationBounds.reduce((sum, b) => sum + b[1], 0);
  let conversationCounts: number[];
  if (scale === 1 && conversationCount >= minConversations && conversationCount <= maxConversations) {
    let firstScope = 0;
    const grouped = scopeRows.map((row) => {
      const group = conversationBounds.slice(firstScope, firstScope + Number(row.scopes));
      firstScope += Number(row.scopes);
      return group;
    });
    const totals = fitCounts(
      grouped.map((b) => [b.reduce((sum, pair) => sum + pair[0], 0), b.reduce((sum, pair) => sum + pair[1], 0)]),
      conversationCount,
      scopeRows.map((row) => Number(row.total_conversations ?? 0)),
    );
    conversationCounts = grouped.flatMap((b, i) => fitCounts(b, totals[i]!));
  } else {
    conversationCounts = fitCounts(
      scopeCounts.map((count, i) => {
        let minimum = [...personalOwners.values()].some((p) => scopes[i] === `personal:${p}`) ? 1 : 0;
        if (scopes[i] === `personal:${principals.at(-1)!.principalId}`) minimum = 12;
        return [minimum, count];
      }),
      conversationCount,
    );
  }
  const conversationScopes = conversationCounts.flatMap((count, i) => Array<string>(count).fill(scopes[i]!));
  const backgroundScopes = scopeCounts.flatMap((count, i) =>
    Array<string>(count - conversationCounts[i]!).fill(scopes[i]!),
  );
  let conversationIndex = 0;
  let backgroundIndex = 0;
  let n = 0;
  const sessions: SeedSession[] = groups.flatMap((g, i) =>
    Array.from({ length: sizes[i]! }, (_, index) => {
      const id = syntheticId("session", ++n);
      const origin = String(g.origin);
      const owner = principals[(n - 1) % principals.length]!.principalId;
      let thread =
        origin === "cron"
          ? `agent:main:cron:perf-cron-${n % Math.max(1, targets.crons ?? 1)}:run:${id}`
          : `web:${owner}:${id}`;
      const scope =
        origin === "conversation" ? conversationScopes[conversationIndex++]! : backgroundScopes[backgroundIndex++]!;
      if (g.surface === "slack")
        thread = `ch:${scope.startsWith("channel:") ? scope.slice("channel:".length) : `perf-${1 + (n % Math.max(1, targets.directory_channels ?? 1))}`}:${Math.floor(anchorTime / 1000)}.${n}`;
      const active = index < Math.round((Number(g.active_7d ?? 0) * sizes[i]!) / Number(g.sessions));
      const age = active ? (n * 7919) % 7 : 7 + ((n * 7919) % 101);
      return {
        n,
        id,
        scope,
        surface: g.surface === null ? null : String(g.surface),
        origin,
        thread,
        messages: lengths[n - 1]!,
        turns: turnCounts[n - 1]!,
        title: `QM performance conversation ${n}`,
        at: anchorTime - age * 86_400_000,
        otherOffset: 0,
        assistantOffset: 0,
        tapeEntries: 0,
      };
    }),
  );
  const admin = principals.at(-1)!;
  targets.admin_grants = Math.max(1, targets.admin_grants ?? 0);
  const web = sessions.filter((s) => s.surface === "web" && s.origin === "conversation");
  if (web.length < 14) throw new Error("Scale/profile must provide at least fourteen web sessions");
  const short = web[Math.max(0, Math.ceil(web.length / 2) - 1)]!;
  const long = web.at(-1)!;
  let dense = web
    .filter((s) => s !== long && s !== short && s.messages >= 51)
    .sort((a, b) => b.messages / b.turns - a.messages / a.turns)[0]!;
  const densityCeiling = Number(
    jointFor(groups.find((g) => g.surface === "web" && g.origin === "conversation")!)?.max_messages_per_turn ?? 0,
  );
  if (densityCeiling) {
    const donors = web.filter((s) => s !== long && s !== short).sort((a, b) => a.turns - b.turns);
    let best = dense.messages / dense.turns;
    let donor: SeedSession | undefined;
    for (const candidate of donors) {
      if (candidate.messages < 51) continue;
      const match = donors.find(
        (s) =>
          s !== candidate && s.turns >= Math.ceil(candidate.messages / densityCeiling) && s.messages > candidate.turns,
      );
      if (match && candidate.messages / match.turns > best) {
        dense = candidate;
        donor = match;
        best = candidate.messages / match.turns;
      }
    }
    if (donor) [dense.turns, donor.turns] = [donor.turns, dense.turns];
    const targetMessages = Math.floor(densityCeiling * dense.turns);
    const denseBounds = bounds[dense.n - 1]!;
    if (targetMessages >= denseBounds[0] && targetMessages <= denseBounds[1]) {
      const adjusted = fitCounts(
        web.map((s): [number, number] =>
          s === dense
            ? [targetMessages, targetMessages]
            : [Math.max(bounds[s.n - 1]![0], s.turns + 1), bounds[s.n - 1]![1]],
        ),
        web.reduce((sum, s) => sum + s.messages, 0),
        web.map((s) => s.messages),
      );
      for (let i = 0; i < web.length; i++) web[i]!.messages = adjusted[i]!;
    }
  }
  const selected = [short, long, dense, ...web.filter((s) => s !== short && s !== long && s !== dense).slice(-9)];
  const protectedSessions = new Set(selected.map((s) => s.id));
  const moveScope = (session: SeedSession, scope: string) => {
    if (session.scope === scope) return;
    const replacement =
      sessions.find(
        (s) => s !== session && s.scope === scope && s.origin === session.origin && !protectedSessions.has(s.id),
      ) ??
      (scale < 1
        ? sessions.find((s) => s !== session && s.scope === scope && !protectedSessions.has(s.id))
        : undefined);
    if (!replacement) throw new Error(`Scope ${scope} has no replaceable fixture session`);
    replacement.scope = session.scope;
    session.scope = scope;
  };
  for (let i = 0; i < selected.length; i++) {
    moveScope(selected[i]!, `personal:${admin.principalId}`);
    selected[i]!.thread = `web:${admin.principalId}:${selected[i]!.id}`;
    selected[i]!.title = `QM performance ${["short", "long", "dense"][i] ?? `pane ${i + 1}`}`;
    selected[i]!.at = anchorTime - (i + 1) * 1000;
  }
  const caseFor = (s: SeedSession, owner = admin.principalId): SeedCase => ({
    sessionId: s.id,
    principalId: owner,
    scopeId: s.scope,
    threadRef: s.thread,
    title: s.title,
    expectedVisibleText: sentinel(s.id, "last"),
    earlierVisibleText: s === long && s.turns > FIXTURE_TAIL_TURNS ? `QM PERF ${s.id} earlier` : "",
    messageCount: s.messages,
    transcriptStorage: "canonical",
  });
  const rank = (p: number) => principals[Math.min(principals.length - 1, Math.ceil(p * principals.length) - 1)]!;
  const cases: Record<string, SeedCase> = { short: caseFor(short), long: caseFor(long), dense: caseFor(dense) };
  const cohorts: SeedPlan["cohorts"] = {};
  for (const [name, owner] of Object.entries({ median: rank(0.5), p95: rank(0.95), max: admin })) {
    const s =
      name === "max"
        ? short
        : web.find(
            (s) => !selected.includes(s) && !Object.values(cases).some((c) => c.sessionId === s.id) && s.messages > 1,
          )!;
    if (!s) throw new Error("Missing cohort session");
    if (s.scope !== `personal:${owner.principalId}`) moveScope(s, `personal:${owner.principalId}`);
    s.thread = `web:${owner.principalId}:${s.id}`;
    s.at = anchorTime - 100;
    const rootCase = caseFor(s, owner.principalId);
    cases[name] = rootCase;
    cohorts[name] = { ...owner, scopeId: s.scope, rootCase };
    protectedSessions.add(s.id);
  }
  const legacySize = Number(
    (groups.find((g) => g.surface === "web" && g.origin === "conversation")?.messages as number[] | undefined)?.[2] ??
      100,
  );
  for (const name of ["legacy", "mixed"] as const) {
    const session = web
      .filter((s) => !protectedSessions.has(s.id) && s.messages > 1)
      .sort(
        (a, b) =>
          Number(b.turns > 50) - Number(a.turns > 50) ||
          Math.abs(a.messages - legacySize) - Math.abs(b.messages - legacySize) ||
          a.n - b.n,
      )[0];
    if (!session) throw new Error(`Missing ${name} web transcript cohort`);
    moveScope(session, `personal:${admin.principalId}`);
    protectedSessions.add(session.id);
    session.thread = `web:${admin.principalId}:${session.id}`;
    session.title = `QM performance ${name} transcript`;
    session.at = anchorTime - (name === "legacy" ? 13000 : 14000);
    cases[name] = { ...caseFor(session), transcriptStorage: name };
  }
  const earlierEntry = {
    sessionId: long.id,
    seq:
      long.turns > FIXTURE_TAIL_TURNS
        ? Math.ceil(((long.turns - FIXTURE_TAIL_TURNS) * (long.messages - 1)) / long.turns) - 1
        : -1,
  };
  let forcedUsers = 0;
  let forcedAssistants = 0;
  let otherOffset = 0;
  for (const session of sessions) {
    session.otherOffset = otherOffset;
    forcedUsers += session.turns;
    const assistants =
      Number(session.messages > 1) + Number(session.id === earlierEntry.sessionId && earlierEntry.seq > 0);
    forcedAssistants += assistants;
    otherOffset += session.messages - session.turns - assistants;
  }
  const sampled = aggregates.entry_sample ?? [
    { type: "assistant", sampled_rows: 1 },
    { type: "tool_call", sampled_rows: 4 },
    { type: "tool_result", sampled_rows: 4 },
    { type: "thinking", sampled_rows: 2 },
    { type: "text", sampled_rows: 1 },
  ];
  const weights = sampled.filter((r) => r.type !== "user");
  const desiredAssistant = Math.round(
    (targets.session_entries * Number(sampled.find((r) => r.type === "assistant")?.sampled_rows ?? 0)) /
      sampled.reduce((sum, r) => sum + Number(r.sampled_rows), 0),
  );
  const residualAssistant = Math.max(0, desiredAssistant - forcedAssistants);
  const others = weights.filter((r) => r.type !== "assistant" && !(entrySearchTargets && r.type === "text"));
  const exactText = entrySearchTargets?.text ?? 0;
  const counts = apportion(
    others.map((r) => Number(r.sampled_rows)),
    Math.max(0, otherOffset - residualAssistant - exactText),
  );
  const entryTypes = {
    user: forcedUsers,
    assistant: forcedAssistants + residualAssistant,
    ...Object.fromEntries(others.map((row, i) => [String(row.type), counts[i]!])),
    ...(entrySearchTargets ? { text: exactText } : {}),
  };
  const slack = sessions.filter((s) => s.surface === "slack" && s.origin === "conversation").at(-1);
  if (slack) {
    const channelScope = scopes.find((scope) => scope.startsWith("channel:"));
    if (channelScope) {
      const populated = `channel:perf-${Math.min(targets.directory_channels ?? 1, scopes.filter((scope) => scope.startsWith("channel:")).length)}`;
      moveScope(slack, populated);
      slack.thread = `ch:${populated.slice("channel:".length)}:${Math.floor(anchorTime / 1000)}.${slack.n}`;
      slack.at = anchorTime - 500;
      cases.slack = { ...caseFor(slack), readOnly: true };
    }
  }
  const memberships: SeedPlan["memberships"] = [];
  const caseIds = new Set([...Object.values(cases), ...selected.map((s) => caseFor(s))].map((c) => c.sessionId));
  let assistantOffset = 0;
  for (const session of [...sessions.filter((s) => caseIds.has(s.id)), ...sessions.filter((s) => !caseIds.has(s.id))]) {
    session.assistantOffset = assistantOffset;
    assistantOffset +=
      Number(session.messages > 1) + Number(session.id === earlierEntry.sessionId && earlierEntry.seq > 0);
  }
  const visible = sessions.filter((s) => s.origin === "conversation");
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (let i = 0; i < principals.length; i++) {
    const owner = principals[i]!;
    const chosen = new Set(
      [...Object.values(cases), ...selected.map((s) => caseFor(s))]
        .filter((c) => c.principalId === owner.principalId)
        .map((c) => c.sessionId),
    );
    if (chosen.size > owner.sessionCount)
      throw new Error("Principal cohort has fewer memberships than its required cases");
    for (let k = 0; chosen.size < owner.sessionCount; k++) chosen.add(visible[(i * 97 + k) % visible.length]!.id);
    for (const sessionId of chosen) memberships.push({ sessionId, principalId: owner.principalId });
  }
  const adminSessions = memberships
    .filter((m) => m.principalId === admin.principalId)
    .map((m) => byId.get(m.sessionId)!)
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const sidebarTarget = adminSessions[Math.min(55, adminSessions.length - 1)]!;
  const legacy = byId.get(cases.legacy!.sessionId)!;
  const mixed = byId.get(cases.mixed!.sessionId)!;
  mixed.tapeEntries = Math.floor(mixed.messages / 2);
  cases.mixed!.transcriptBoundarySeq = mixed.tapeEntries;
  const tapeOrder = [
    ...sessions.filter((s) => caseIds.has(s.id) && s !== legacy && s !== mixed),
    ...sessions.filter((s) => !caseIds.has(s.id)).sort((a, b) => b.at - a.at || a.n - b.n),
  ];
  const selectedTapeRows = tapeOrder
    .filter((s) => caseIds.has(s.id))
    .reduce((sum, s) => sum + s.messages, mixed.tapeEntries);
  const canonicalTapeRows = Math.min(
    targets.session_entries! - legacy.messages - mixed.messages + mixed.tapeEntries,
    Math.max(
      selectedTapeRows,
      aggregates.canonical_tape_entries?.[0]
        ? Math.round(number(aggregates.canonical_tape_entries[0].rows, "canonical tape rows") * scale)
        : targets.session_entries!,
    ),
  );
  let remainingTape = canonicalTapeRows - mixed.tapeEntries;
  for (const session of tapeOrder) {
    session.tapeEntries = Math.min(session.messages, remainingTape);
    remainingTape -= session.tapeEntries;
  }
  const measuredTape = aggregates.tape_distribution;
  const extraTape = Math.max(0, (targets.session_tape ?? 0) - canonicalTapeRows);
  const tapeKinds: Record<string, number> = measuredTape
    ? Object.fromEntries(
        measuredTape.map((row, i) => [
          String(row.kind),
          apportion(
            measuredTape.map((r) => number(r.frequency, "tape kind frequency")),
            targets.session_tape!,
          )[i]!,
        ]),
      )
    : {
        annotation: canonicalTapeRows,
        message: extraTape - Math.floor(extraTape / 20),
        context_event: Math.floor(extraTape / 20),
      };
  if (Object.keys(tapeKinds).some((kind) => !["annotation", "message", "context_event"].includes(kind)))
    throw new Error("Unsupported measured tape kind");
  tapeKinds.annotation = Math.max(canonicalTapeRows, tapeKinds.annotation ?? 0);
  targets.session_tape = Object.values(tapeKinds).reduce((sum, count) => sum + count, 0);
  const adminHistoryCohorts = Object.fromEntries(
    Object.entries(cohorts).map(([name, cohort]) => [
      name,
      {
        scopeId: cohort.scopeId,
        conversationCount: sessions.filter((s) => s.scope === cohort.scopeId && s.origin === "conversation").length,
        rootCase: cohort.rootCase,
      },
    ]),
  );
  const inventory: SeedPlan["inventory"] = (aggregates.all_table_estimates ?? []).map((row) => {
    const schema = String(row.schemaname ?? "public");
    const table = String(row.relname);
    if (![schema, table].every((name) => /^[a-z_][a-z0-9_]*$/.test(name)))
      throw new Error("Invalid inventory relation name");
    const sourceRows = number(row.n_live_tup, "inventory rows");
    const sourceBytes = number(row.total_bytes ?? 0, "inventory bytes");
    const excluded = aggregates.fixture_inventory_dispositions?.find(
      (r) =>
        String(r.schema ?? "public") === schema &&
        r.table === table &&
        r.status === "excluded" &&
        typeof r.reason === "string" &&
        r.reason.trim(),
    );
    if (excluded)
      return { schema, table, sourceRows, sourceBytes, status: "excluded", reason: String(excluded.reason) };
    if (table in targets)
      return {
        schema,
        table,
        sourceRows,
        sourceBytes,
        status: "planned",
        reason: "Fixture target retains its original aggregate or exact-count provenance",
      };
    if (!sourceRows)
      return {
        schema,
        table,
        sourceRows,
        sourceBytes,
        status: "excluded",
        reason: "Source inventory has no live rows; retained relation bytes are reported separately",
      };
    if (
      [
        "public.qm_schema_migrations",
        "public.durable_map_versions",
        "public.acl_grants_version",
        "pgboss.version",
        "pgboss.queue",
      ].includes(`${schema}.${table}`)
    )
      return {
        schema,
        table,
        sourceRows,
        sourceBytes,
        status: "excluded",
        reason:
          "Schema/store initialization generates deployment metadata; production versions and queue declarations are not copied",
      };
    return {
      schema,
      table,
      sourceRows,
      sourceBytes,
      status: "unclassified",
      reason: "Nonempty measured relation needs an explicit seed or reviewed exclusion",
    };
  });
  const resourceOwners: SeedPlan["resourceOwners"] = {};
  if (entrySearchTargets?.assistant !== undefined) {
    aggregates.entry_search_shape = (aggregates.entry_search_shape ?? []).map((row) =>
      row.type === "assistant"
        ? { ...row, fixture_searchable_fraction: entrySearchTargets.assistant! / entryTypes.assistant! }
        : row,
    );
  }
  for (const [table, label, key] of [
    ["file_artifacts", "file_owner_distribution", "total"],
    ["memory_revisions", "memory_scope_distribution", "revisions"],
  ]) {
    const measured = aggregates[label!]?.[0];
    const total = targets[table!] ?? 0;
    if (!measured || !total) continue;
    const count = Math.min(total, Number(measured.scopes));
    const available = [
      ...scopes.filter((scope) => scope !== `personal:${admin.principalId}` && scope !== "org:perf"),
      "org:perf",
      `personal:${admin.principalId}`,
    ];
    if (count > available.length) throw new Error("Resource owner population exceeds fixture scopes");
    const bounds = ownerQuantileBounds(count, measured[`${key}_quantiles`] as number[], Number(measured[`${key}_max`]));
    const counts =
      scale === 1
        ? fitCounts(bounds, total)
        : fitCounts(
            bounds.map(() => [1, total]),
            total,
            bounds.map(([min]) => min),
          );
    const enabled =
      table === "file_artifacts"
        ? fitCounts(
            ownerQuantileBounds(count, measured.enabled_quantiles as number[], Number(measured.enabled_max), 0).map(
              ([min, max], i) =>
                scale === 1 ? [Math.min(min, counts[i]!), Math.min(max, counts[i]!)] : [0, counts[i]!],
            ),
            Math.round((total * Number(measured.enabled_rows)) / Number(measured.rows)),
          )
        : undefined;
    const bodies =
      table === "memory_revisions"
        ? fitCounts(
            ownerQuantileBounds(count, measured.latest_body_quantiles as number[], Number(measured.latest_body_max)),
            Math.round(count * Number(measured.latest_body_mean)),
          )
        : undefined;
    const owners = [...available.slice(0, Math.max(0, count - 2)), ...available.slice(-Math.min(2, count))];
    const shape = aggregates.memory_latest_shape?.[0];
    const facts =
      bodies && shape
        ? fitCounts(
            ownerQuantileBounds(count, shape.fact_quantiles as number[], Number(shape.max_facts), 0).map(
              ([min, max], i) => [Math.min(min, Math.floor(bodies[i]! / 4)), Math.min(max, Math.floor(bodies[i]! / 4))],
            ),
            Math.round(Number(shape.avg_facts) * count),
          )
        : undefined;
    const newlines =
      bodies && shape
        ? fitCounts(
            ownerQuantileBounds(count, shape.newline_quantiles as number[], Number(shape.max_newlines), 0).map(
              ([min, max], i) => [
                Math.max(Math.max(0, (facts?.[i] ?? 0) - 1), Math.min(min, bodies[i]! - 1)),
                Math.max(Math.max(0, (facts?.[i] ?? 0) - 1), Math.min(max, bodies[i]! - 1)),
              ],
            ),
            Math.round(Number(shape.avg_newlines) * count),
          )
        : undefined;
    resourceOwners[table!] = counts.map((rows, i) => ({
      scopeId: owners[i]!,
      rows,
      ...(enabled ? { enabledRows: enabled[i]! } : {}),
      ...(bodies ? { latestBodyBytes: bodies[i]! } : {}),
      ...(facts ? { latestFacts: facts[i]!, latestNewlines: newlines![i]! } : {}),
    }));
  }
  return {
    schemaVersion: 1,
    fixtureId: `qm-perf-${profileSha256.slice(0, 16)}-${scale}`,
    profileSha256,
    scale,
    anchorTime,
    targets,
    sessions,
    principals,
    scopes,
    cohorts,
    cases,
    multiview: selected.map((s) => caseFor(s)),
    aggregates,
    entryTypes,
    earlierEntry,
    sidebarPagination: { principalId: admin.principalId, sessionId: sidebarTarget.id },
    memberships,
    adminHistoryCohorts,
    entrySearchTargets,
    tapeKinds,
    canonicalTapeRows,
    resourceOwners,
    inventory,
    sourceSnapshots: profiles.map((profile) => ({
      collectedAt: profile.collectedAt,
      labels: profile.results.filter((result) => Array.isArray(result.rows)).map((result) => result.label),
    })),
  };
}

export function payloadText(seed: string, length: number, incompressibleFraction = 0.65): string {
  if (!Number.isSafeInteger(length) || length < 0 || length > 10_000_000) throw new Error("Invalid payload length");
  const randomBytes = Math.ceil(length * Math.max(0, Math.min(1, incompressibleFraction)));
  const chunks: string[] = [];
  for (let i = 0; i * 64 < randomBytes; i++) chunks.push(createHash("sha256").update(`${seed}:${i}`).digest("hex"));
  return (chunks.join("").slice(0, randomBytes) + " synthetic fixture ".repeat(Math.ceil(length / 19))).slice(
    0,
    length,
  );
}

export function payloadSize(row: Row, key: string, bucket: number, minimum = 16, count = 256): number {
  const values = row[key] as number[] | undefined;
  if (!values?.length) return 128;
  const points = [
    [0, Math.min(16, values[0]!)],
    [0.5, values[0]!],
    [0.9, values[1]!],
    [0.95, values[2]!],
    [0.99, values[3]!],
    [1, Number(row.max_payload_bytes ?? row.max_bytes ?? values.at(-1))],
  ];
  const q = bucket / (count - 1);
  const i = Math.max(0, points.findIndex((p) => p[0]! >= q) - 1);
  const [x, y] = points[i]!;
  const [xx, yy] = points[i + 1]!;
  return Math.max(minimum, Math.round(y! + (yy! - y!) * ((q - x!) / (xx! - x!))));
}

export function latestMemoryBody(owner: SeedPlan["resourceOwners"][string][number], ratio: number): string | null {
  if (owner.latestBodyBytes === undefined) return null;
  const bytes = owner.latestBodyBytes;
  const newlines = owner.latestNewlines ?? 0;
  const facts = owner.latestFacts ?? (bytes >= 2 ? 1 : 0);
  const prefixes = Array.from({ length: newlines + 1 }, (_, i) => (i < facts ? "- " : ""));
  const contentBytes = bytes - newlines - facts * 2;
  if (contentBytes < facts || facts > prefixes.length) throw new Error("Memory head shape cannot fit its body size");
  const text = ("QM performance memory " + payloadText(`latest-memory:${owner.scopeId}`, contentBytes, ratio)).slice(
    0,
    contentBytes,
  );
  return prefixes
    .map(
      (prefix, i) =>
        prefix +
        text.slice(
          Math.floor((i * contentBytes) / prefixes.length),
          Math.floor(((i + 1) * contentBytes) / prefixes.length),
        ),
    )
    .join("\n");
}

export function payloadLengths(row: Row, key: string, average?: number, minimum = 1): number[] {
  const values = row[key] as number[] | undefined;
  if (!values?.length) return Array<number>(PAYLOAD_BUCKETS).fill(128);
  if (average === undefined)
    return Array.from({ length: PAYLOAD_BUCKETS }, (_, bucket) =>
      payloadSize(row, key, bucket, minimum, PAYLOAD_BUCKETS),
    );
  return fitPayloadCurve(
    quantileBounds(
      PAYLOAD_BUCKETS,
      values,
      Number(row.max_payload_bytes ?? row.max_bytes ?? values.at(-1)),
      undefined,
      minimum,
    ),
    Math.round(average * PAYLOAD_BUCKETS),
    Array.from({ length: PAYLOAD_BUCKETS }, (_, bucket) => payloadSize(row, key, bucket, minimum, PAYLOAD_BUCKETS)),
  );
}

function fitPayloadCurve(bounds: Array<[number, number]>, total: number, preferred: number[]): number[] {
  const fractions = bounds.map(([min, max], i) =>
    max === min ? 0 : Math.max(0, Math.min(1, (preferred[i]! - min) / (max - min))),
  );
  const curve = (power: number) => bounds.map(([min, max], i) => min + (max - min) * fractions[i]! ** power);
  let low = 1 / 1024;
  let high = 1024;
  for (let i = 0; i < 40; i++) {
    const power = (low + high) / 2;
    if (curve(power).reduce((sum, n) => sum + n, 0) > total) low = power;
    else high = power;
  }
  return fitCounts(bounds, total, curve((low + high) / 2));
}

function payloadEnvelope(kind: string, body: string, bucket: number): Record<string, unknown> {
  const callId = `${syntheticId("call", bucket)}:1000`;
  if (kind === "tool_call") return { tool: "execute", callId, command: "printf fixture", input: body };
  if (kind === "tool_result") return { tool: "execute", callId, result: body, isError: false };
  return { text: body };
}

export function payloadMinimum(kind: string): number {
  if (kind === "memory") return "- QM performance memory ".length + 1;
  if (kind === "prompt" || kind === "request")
    return JSON.stringify({ messages: [{ role: "user", content: "" }] }).length + 1;
  return JSON.stringify(payloadEnvelope(kind, "", 0)).length + 1;
}

export function visiblePayloads(
  kind: string,
  lengths: number[],
  shape: Row | undefined,
  ratio: number,
): Array<{ body: string; payload: Record<string, unknown> }> {
  const count = lengths.length;
  const overhead = payloadMinimum(kind) - 1;
  let visible = [...lengths];
  if (shape) {
    const blank = count - Math.round((count * Number(shape.searchable_rows)) / Number(shape.sampled_rows));
    const sampledFraction = Number(shape.searchable_rows) / Number(shape.sampled_rows);
    const weightedFraction = Number(shape.fixture_searchable_fraction ?? sampledFraction);
    const conservative = weightedFraction < sampledFraction;
    const probabilities = [0.5, 0.9, 0.95, 0.99].map((q) =>
      conservative
        ? 1 - sampledFraction + (sampledFraction * Math.max(0, q - 1 + weightedFraction)) / weightedFraction
        : q,
    );
    const capacity = lengths.map((length, bucket) =>
      Math.max(
        1,
        length -
          overhead -
          payloadSize({ ...shape, max_bytes: (shape.newlines as number[]).at(-1) }, "newlines", bucket, 0, count),
      ),
    );
    const maxText = Math.min(Math.max(...lengths), Number(shape.max_text_chars ?? Math.max(...lengths)));
    const bounds = quantileBounds(count, shape.text_chars as number[], maxText, probabilities, 0).map(
      ([min, max], i): [number, number] => {
        if (i < blank) return [0, 0];
        if (conservative) return [Math.max(1, min), Math.max(1, max)];
        return [Math.max(1, Math.min(min, capacity[i]!)), Math.max(1, Math.min(max, capacity[i]!))];
      },
    );
    const minimum = bounds.reduce((sum, b) => sum + b[0], 0);
    const maximum = bounds.reduce((sum, b) => sum + b[1], 0);
    visible = fitPayloadCurve(
      bounds,
      Math.min(
        maximum,
        Math.max(
          minimum,
          Math.round(Number(shape.avg_text_chars) * count * (conservative ? sampledFraction / weightedFraction : 1)),
        ),
      ),
      Array.from({ length: count }, (_, bucket) =>
        payloadSize({ ...shape, max_bytes: maxText }, "text_chars", bucket, 0, count),
      ),
    );
  }
  const codePrefix = "```text\nQM performance fixture\n```\n";
  const tablePrefix = "| Fixture | Value |\n| --- | --- |\n| QM | performance |\n";
  const preserveWeightedShape =
    shape &&
    Number(shape.fixture_searchable_fraction ?? 1) < Number(shape.searchable_rows) / Number(shape.sampled_rows);
  const bodyLengths = visible.map((length, i) =>
    Math.max(0, preserveWeightedShape ? length : Math.min(length, lengths[i]! - overhead)),
  );
  const eligible = bodyLengths.map((length, bucket) => ({ length, bucket }));
  const codeBuckets = new Set(
    shape
      ? eligible
          .filter((row) => row.length >= codePrefix.length)
          .slice(0, Math.round((Number(shape.code_block_rows) / Number(shape.sampled_rows)) * count))
          .map((row) => row.bucket)
      : [],
  );
  const tableBuckets = new Set(
    shape
      ? eligible
          .filter((row) => row.length >= tablePrefix.length && !codeBuckets.has(row.bucket))
          .reverse()
          .slice(0, Math.round((Number(shape.table_rows) / Number(shape.sampled_rows)) * count))
          .map((row) => row.bucket)
      : [],
  );
  return lengths.map((length, bucket) => {
    let body = payloadText(`${kind}:${bucket}`, bodyLengths[bucket]!, ratio);
    if (body && shape) {
      const newlines = Math.min(
        body.length - 1,
        payloadSize({ ...shape, max_bytes: (shape.newlines as number[]).at(-1) }, "newlines", bucket, 0, count),
      );
      const line = Math.max(1, Math.floor(body.length / Math.max(1, newlines)));
      body = [...body].map((char, i) => (i > 0 && i % line === 0 && i / line <= newlines ? "\n" : char)).join("");
      let prefix = "QM performance fixture ";
      if (codeBuckets.has(bucket)) prefix = codePrefix;
      else if (tableBuckets.has(bucket)) prefix = tablePrefix;
      body = (prefix + body).slice(0, body.length);
    }
    const payload: Record<string, unknown> = body ? payloadEnvelope(kind, body, bucket) : {};
    const gap = length - Buffer.byteLength(JSON.stringify(payload));
    if (gap >= 13) payload.context = payloadText(`${kind}:${bucket}:context`, gap - 13, ratio);
    return { body, payload };
  });
}

export function seedFailure(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { message: "Fixture seeding failed" };
  return Object.fromEntries(
    [
      "message",
      "stack",
      "code",
      "severity",
      "position",
      "schema",
      "table",
      "column",
      "constraint",
      "file",
      "line",
      "routine",
    ].flatMap((field) => {
      const value = Reflect.get(error, field);
      return typeof value === "string"
        ? [[field, value.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database URL redacted]")]]
        : [];
    }),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      profile: { type: "string", multiple: true },
      scale: { type: "string", default: "1" },
      "database-url-env": { type: "string" },
      "database-name": { type: "string" },
      manifest: { type: "string" },
      "plan-only": { type: "boolean" },
    },
  });
  if (!values.profile?.length || !values.manifest) throw new Error("--profile and --manifest are required");
  const profiles = await Promise.all(
    values.profile.map(async (path) => JSON.parse(await readFile(path, "utf8")) as AggregateProfile),
  );
  const plan = makeSeedPlan(profiles, Number(values.scale));
  if (values["plan-only"]) {
    const { sessions: _sessions, aggregates: _aggregates, ...summary } = plan;
    await writeFile(
      values.manifest,
      JSON.stringify(
        { ...summary, qualified: false, status: "planned", limitations: ["No database has been seeded or verified"] },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    return;
  }
  const env = values["database-url-env"];
  if (!env || !/^QM_PERF_[A-Z0-9_]+$/.test(env) || !process.env[env])
    throw new Error("--database-url-env must name an explicit populated QM_PERF_* variable");
  const name = validateTarget(process.env[env]!, values["database-name"] ?? "");
  const { seedDatabase } = await import("./seed-db.ts");
  const manifest = await seedDatabase(process.env[env]!, name, plan);
  await writeFile(values.manifest, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify(seedFailure(error)));
    process.exitCode = 1;
  });
}
