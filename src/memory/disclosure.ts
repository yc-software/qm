import type { Principal, ScopeId } from "../types.ts";
import { parseScopeId, personalScope } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import type { CurrentScopeMembers, IsCurrentSharedScopeMember } from "../resolution/scope-membership.ts";
import { legacyMemoryRecords, restoreMemoryRecords, type MemoryRecords } from "./records.ts";
import { memoryBlocks } from "./notebook.ts";
import { queryBullets, recallBody, type MemoryService } from "./memory-service.ts";

type RecordEntry = MemoryRecords["records"][number];

export interface MemoryDisclosure {
  actor: Principal;
  targetScope: ScopeId;
  nativeScopes: readonly ScopeId[];
  audience: readonly Principal[];
  open: boolean;
  config?: Pick<ScopedConfigStore, "resolveSharingPostureDurable">;
  isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
  currentScopeMembers?: CurrentScopeMembers;
}

function validRecords(content: string, snapshot: MemoryRecords): boolean {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.records)) return false;
  const blocks = memoryBlocks(content);
  return (
    blocks.length === snapshot.records.length &&
    snapshot.records.every(
      (record, index) =>
        record &&
        typeof record.id === "string" &&
        record.text === blocks[index] &&
        ["ordinary", "unknown", "sensitive", "restricted"].includes(record.sensitivity) &&
        typeof record.sourceUnknown === "boolean" &&
        Array.isArray(record.sources) &&
        record.sources.every(
          (source) =>
            source &&
            typeof source.scopeId === "string" &&
            !!parseScopeId(source.scopeId).kind &&
            (source.sessionId === undefined || typeof source.sessionId === "string"),
        ),
    )
  );
}

function memoryDisclosurePolicy(input: MemoryDisclosure) {
  const decisions = new Map<string, Promise<boolean>>();
  const once = (key: string, read: () => Promise<boolean>) => {
    let decision = decisions.get(key);
    if (!decision) {
      decision = read().catch(() => false);
      decisions.set(key, decision);
    }
    return decision;
  };
  let currentAudience: Promise<readonly Principal[]> | undefined;
  const audience = () =>
    (currentAudience ??=
      input.targetScope === personalScope(input.actor.id)
        ? Promise.resolve(input.audience)
        : (input
            .currentScopeMembers?.(input.targetScope)
            .then((members) => members ?? [])
            .catch(() => []) ?? Promise.resolve([])));
  const native = (scope: ScopeId) => input.nativeScopes.includes(scope);
  function entitled(person: Principal, scope: ScopeId): Promise<boolean> {
    return once(`member:${person.id}:${scope}`, async () => {
      const { kind, ref } = parseScopeId(scope);
      if (person.type !== "internal") return false;
      if (kind === "personal") return samePerson(person.id, ref);
      if (kind === "org") return native(scope);
      if (kind === "team") return native(scope) && person.teamIds?.includes(ref) === true;
      if (scope === input.targetScope && native(scope)) return true;
      return (await input.isCurrentSharedScopeMember?.(person.id, scope)) === true;
    });
  }
  async function allEntitled(scope: ScopeId, members = input.audience): Promise<boolean> {
    return members.length > 0 && (await Promise.all(members.map((person) => entitled(person, scope)))).every(Boolean);
  }
  async function narrow(scope: ScopeId): Promise<boolean> {
    return native(scope) && (await entitled(input.actor, scope)) && (await allEntitled(scope));
  }
  function sourceAllowed(source: ScopeId, sensitivity: RecordEntry["sensitivity"]): Promise<boolean> {
    return once(`source:${source}:${sensitivity}`, async () => {
      if (!(await entitled(input.actor, source))) return false;
      if (source === input.targetScope || (native(source) && ["org", "team"].includes(parseScopeId(source).kind ?? "")))
        return allEntitled(source);
      if (!input.open || !input.config) return false;
      const personal = personalScope(input.actor.id);
      if ((await input.config.resolveSharingPostureDurable(personal, input.targetScope)) !== "open") return false;
      if ((await input.config.resolveSharingPostureDurable(personal, source)) !== "open") return false;
      const members = await audience();
      if (await allEntitled(source, [...members])) return true;
      return (
        sensitivity === "ordinary" &&
        source === personal &&
        members.length > 0 &&
        members.every((person) => person.type === "internal")
      );
    });
  }
  return {
    async narrow(scope: ScopeId) {
      try {
        return await narrow(scope);
      } catch {
        return false;
      }
    },
    async allows(home: ScopeId, record: RecordEntry): Promise<boolean> {
      try {
        if ((record.sourceUnknown || record.sensitivity === "unknown") && !(await narrow(home))) return false;
        if (!record.sources.length) return record.sourceUnknown && (await narrow(home));
        return (
          await Promise.all(record.sources.map((source) => sourceAllowed(source.scopeId, record.sensitivity)))
        ).every(Boolean);
      } catch {
        return false;
      }
    },
  };
}

export class MemoryDisclosureDenied extends Error {
  constructor() {
    super("This notebook contains memories unavailable here. Edit it from an authorized conversation.");
  }
}

export function disclosedMemory(memory: MemoryService, access: MemoryDisclosure): MemoryService {
  if (memory.withDisclosure) {
    const view = memory.withDisclosure(access);
    return { ...view, capture: (...args) => memory.capture(...args) };
  }
  async function filtered<T extends { content: string; records?: MemoryRecords }>(scope: ScopeId, head: T): Promise<T> {
    const snapshot = head.records ?? legacyMemoryRecords(scope, head.content);
    if (!validRecords(head.content, snapshot)) return { ...head, content: "", records: { version: 1, records: [] } };
    const policy = memoryDisclosurePolicy(access);
    const allowed = await Promise.all(snapshot.records.map((record) => policy.allows(scope, record)));
    const records = snapshot.records.filter((_, index) => allowed[index]);
    return {
      ...head,
      content: allowed.every(Boolean) ? head.content : records.map((record) => record.text).join("\n\n"),
      records: { version: 1, records },
    };
  }
  async function head(scope: ScopeId) {
    return filtered(scope, (await memory.readHead?.(scope)) ?? { content: await memory.read(scope), revision: "" });
  }
  async function guardedHistory(scope: ScopeId, limit?: number) {
    const history = (await memory.history?.(scope, limit)) ?? [];
    const floor: MemoryRecords = { version: 1, records: [] };
    for (const revision of history) {
      const snapshot = revision.records ?? legacyMemoryRecords(scope, revision.content);
      if (!validRecords(revision.content, snapshot)) return [];
    }
    return history.map((revision) => {
      const snapshot = revision.records ?? legacyMemoryRecords(scope, revision.content);
      const records = restoreMemoryRecords(floor, snapshot);
      floor.records.push(...snapshot.records);
      return { ...revision, records };
    });
  }
  async function editable(scope: ScopeId) {
    const raw = (await memory.readHead?.(scope)) ?? { content: await memory.read(scope), revision: "" };
    const visible = await filtered(scope, raw);
    if (!(await memoryDisclosurePolicy(access).narrow(scope)) || visible.content !== raw.content)
      throw new MemoryDisclosureDenied();
    return raw;
  }
  return {
    ...memory,
    async replace(scope, content, author) {
      const current = await editable(scope);
      if (memory.replaceIfRevision && current.revision) {
        if (!(await memory.replaceIfRevision(scope, content, current.revision, author)))
          throw new Error("Memory changed while editing; read it again before retrying.");
      } else {
        if (current.records) throw new MemoryDisclosureDenied();
        await memory.replace(scope, content, author);
      }
    },
    async replaceIfRevision(scope, content, revision, author) {
      const current = await editable(scope);
      if (current.revision !== revision) return false;
      return (await memory.replaceIfRevision?.(scope, content, revision, author)) ?? false;
    },
    async restore(scope, revision, expectedRevision, author) {
      await editable(scope);
      const target = (await guardedHistory(scope, 100)).find((row) => row.revision === revision);
      if (!target || (await filtered(scope, target)).content !== target.content) return false;
      return (await memory.restore?.(scope, revision, expectedRevision, author)) ?? false;
    },
    async readHead(scope) {
      return head(scope);
    },
    async read(scope) {
      return (await head(scope)).content;
    },
    async recall(scope, context) {
      if (memory.readHead) return recallBody((await head(scope)).content);
      return (await memoryDisclosurePolicy(access).narrow(scope)) ? memory.recall(scope, context) : "";
    },
    async query(scope, query, limit = 20, context) {
      const snapshot = await memory.readHead?.(scope);
      if (snapshot?.records) return queryBullets((await filtered(scope, snapshot)).content, query, limit);
      return (await memoryDisclosurePolicy(access).narrow(scope)) ? memory.query(scope, query, limit, context) : [];
    },
    async history(scope, limit) {
      return Promise.all((await guardedHistory(scope, limit)).map((revision) => filtered(scope, revision)));
    },
  };
}
