import type { Session } from "../../../src/types.ts";
import type { TranscriptEntry as CoreSessionEntry } from "../../../src/sessions/session-store.ts";
import type { ContextSummary, ProjectView } from "../../../src/api/app.ts";
import type { CoreContext, CoreProject, CoreSession, SessionEntry } from "../src/core-bridge.ts";
import type { SwarmMember, SwarmMessage } from "../../../src/swarms/swarm-store.ts";
import type { SwarmService } from "../../../src/swarms/swarm-service.ts";
import type { SwarmBoardMessage, SwarmPeer, SwarmView } from "../src/swarm-strip.ts";

type Expect<T extends true> = T;
type IsAssignable<A, B> = [A] extends [B] ? true : false;
type NoExtraKeys<Copy, Canon> = IsAssignable<Exclude<keyof Copy, keyof Canon>, never>;

type _session = Expect<IsAssignable<Session, CoreSession>>;
type _entry = Expect<IsAssignable<CoreSessionEntry, SessionEntry>>;
type _context = Expect<IsAssignable<ContextSummary, CoreContext>>;
type _project = Expect<IsAssignable<ProjectView, CoreProject>>;
type _sessionKeys = Expect<NoExtraKeys<CoreSession, Session>>;
type _entryKeys = Expect<NoExtraKeys<SessionEntry, CoreSessionEntry>>;
type _contextKeys = Expect<NoExtraKeys<CoreContext, ContextSummary>>;
type _projectKeys = Expect<NoExtraKeys<CoreProject, ProjectView>>;

type CoreSwarmView = Awaited<ReturnType<SwarmService["inspect"]>>;
type _swarmPeer = Expect<IsAssignable<SwarmMember, SwarmPeer>>;
type _swarmMessage = Expect<IsAssignable<SwarmMessage, SwarmBoardMessage>>;
type _swarmView = Expect<IsAssignable<CoreSwarmView, SwarmView>>;
type _swarmPeerKeys = Expect<NoExtraKeys<SwarmPeer, SwarmMember>>;
type _swarmMessageKeys = Expect<NoExtraKeys<SwarmBoardMessage, SwarmMessage>>;
type _swarmViewKeys = Expect<NoExtraKeys<SwarmView, CoreSwarmView>>;
