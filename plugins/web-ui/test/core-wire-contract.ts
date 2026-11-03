import type { Session } from "../../../src/types.ts";
import type { TranscriptItem } from "../../../src/sessions/session-store.ts";
import type { RunActivityEntry as CoreRunActivityEntry } from "../../../src/runs/run-activity-store.ts";
import type { App, ContextSummary, ProjectView } from "../../../src/api/app.ts";
import type {
  CoreContext,
  CoreProject,
  CoreSession,
  RunPoll,
  TranscriptPage,
  forkSession,
  fetchItem,
} from "../src/core-bridge.ts";
import type { Item, RunActivityEntry } from "../src/items.ts";

type Expect<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type NoExtraKeys<Copy, Canon> = IsAssignable<Exclude<keyof Copy, keyof Canon>, never>;
type Resolved<F extends (...args: never[]) => unknown> = NonNullable<Awaited<ReturnType<F>>>;

type CoreTranscript = Resolved<App["getSessionForViewer"]>;
type CoreFork = Resolved<App["forkSession"]>;
type CoreRunActivity = NonNullable<Resolved<App["getRun"]>["activity"]>;
type WebFork = Awaited<ReturnType<typeof forkSession>>;

type _session = Expect<IsAssignable<Session, CoreSession>>;
type _item = Expect<IsAssignable<TranscriptItem, Item>>;
type _itemBack = Expect<IsAssignable<Item, TranscriptItem>>;
type _itemRead = Expect<
  IsAssignable<Resolved<App["getSessionItemForViewer"]>["item"], Awaited<ReturnType<typeof fetchItem>>>
>;
type _activity = Expect<IsAssignable<CoreRunActivityEntry, RunActivityEntry>>;
type _activityBack = Expect<IsAssignable<RunActivityEntry, CoreRunActivityEntry>>;
type _runActivity = Expect<IsAssignable<CoreRunActivity, NonNullable<RunPoll["activity"]>>>;
type _transcriptItems = Expect<IsAssignable<CoreTranscript["items"], TranscriptPage["items"]>>;
type _transcriptEarlier = Expect<IsAssignable<CoreTranscript["earlierItems"], TranscriptPage["earlierItems"]>>;
type _transcriptKeys = Expect<NoExtraKeys<TranscriptPage, CoreTranscript>>;
type _forkItems = Expect<IsAssignable<CoreFork["items"], WebFork["items"]>>;
type _forkKeys = Expect<NoExtraKeys<WebFork, CoreFork>>;
type _context = Expect<IsAssignable<ContextSummary, CoreContext>>;
type _project = Expect<IsAssignable<ProjectView, CoreProject>>;
type _sessionKeys = Expect<NoExtraKeys<CoreSession, Session>>;
type _itemKeys = Expect<NoExtraKeys<Item, TranscriptItem>>;
type _contextKeys = Expect<NoExtraKeys<CoreContext, ContextSummary>>;
type _projectKeys = Expect<NoExtraKeys<CoreProject, ProjectView>>;
