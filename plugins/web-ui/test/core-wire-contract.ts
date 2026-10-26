import type { Session } from "../../../src/types.ts";
import type { TranscriptItem } from "../../../src/sessions/session-store.ts";
import type { RunActivityEntry as CoreRunActivityEntry } from "../../../src/runs/run-activity-store.ts";
import type { ContextSummary, ProjectView } from "../../../src/api/app.ts";
import type { CoreContext, CoreProject, CoreSession } from "../src/core-bridge.ts";
import type { Item, RunActivityEntry } from "../src/items.ts";

type Expect<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type NoExtraKeys<Copy, Canon> = IsAssignable<Exclude<keyof Copy, keyof Canon>, never>;

type _session = Expect<IsAssignable<Session, CoreSession>>;
type _item = Expect<IsAssignable<TranscriptItem, Item>>;
type _itemBack = Expect<IsAssignable<Item, TranscriptItem>>;
type _activity = Expect<IsAssignable<CoreRunActivityEntry, RunActivityEntry>>;
type _context = Expect<IsAssignable<ContextSummary, CoreContext>>;
type _project = Expect<IsAssignable<ProjectView, CoreProject>>;
type _sessionKeys = Expect<NoExtraKeys<CoreSession, Session>>;
type _itemKeys = Expect<NoExtraKeys<Item, TranscriptItem>>;
type _contextKeys = Expect<NoExtraKeys<CoreContext, ContextSummary>>;
type _projectKeys = Expect<NoExtraKeys<CoreProject, ProjectView>>;
