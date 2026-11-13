import XCTest
import os

@testable import QM

@MainActor
final class NativeAgentTrailTests: XCTestCase {
  private let server = NativeRouteProtocol.Server(
    fallback: .init(
      body:
        #"{"sessions":[{"id":"agent","scopeId":"personal:alice","threadRef":"agent:1","parentSessionId":"root","title":"Check streaming","purpose":"Verify updates after commentary","working":true,"workingSince":1000}]}"#
    ))
  private let route = "GET /api/sessions/root/children"

  private func client() -> APIClient { server.client() }

  private func conversation(_ id: String, parent: String? = "root") -> Conversation {
    Conversation(
      id: id, scopeId: "personal:alice", threadRef: "agent:\(id)", title: id,
      parentSessionId: parent)
  }

  func testBranchesPreserveSiblingOrderAndKeepGrandchildrenWithTheirParent() {
    let sessions = [
      conversation("streaming"), conversation("navigation"),
      conversation("reconnect", parent: "streaming"),
      conversation("back-button", parent: "navigation"),
      conversation("background", parent: "reconnect"),
    ]
    let rows = NativeAgentBranch.rows(sessions, rootID: "root")
    XCTAssertEqual(
      rows.map(\.id), ["streaming", "reconnect", "background", "navigation", "back-button"])
    XCTAssertEqual(rows.map(\.depth), [1, 2, 3, 1, 2])
    XCTAssertEqual(rows.map(\.parentName), [nil, "streaming", "reconnect", nil, "navigation"])
  }

  func testAgentLaunchAppearsBeforeChildrenRefreshAndHandsOffToListedAgent() async throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"launch","tool":"subagents","body":{"action":"open","name":"Check streaming"}},{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"launch","tool":"subagents","body":{"action":"open","sessionId":"agent","title":"Check streaming"}}]
        """#.utf8))
    let starting = NativeWorkItem.items([items[0]])
    XCTAssertEqual(
      NativeAgentBranch.pendingLaunches(starting, listed: []).map(\.id), [items[0].id])
    let opened = NativeWorkItem.items(items)
    XCTAssertEqual(NativeAgentBranch.pendingLaunches(opened, listed: []).map(\.id), [items[0].id])
    XCTAssertEqual(opened.first?.agentSessionID, "agent")
    let model = NativeAgentTrailModel(client: client(), conversationID: "root")
    await model.refresh()
    XCTAssertEqual(model.branches.map(\.id), ["agent"])
    XCTAssertTrue(NativeAgentBranch.pendingLaunches(opened, listed: model.branches).isEmpty)
  }

  func testFailedBlockedAndUnconfirmedLaunchesDoNotShowStarting() throws {
    let items = try JSONDecoder().decode(
      [Item].self,
      from: Data(
        #"""
        [{"seq":1,"createdAt":1,"kind":"ToolCall","callId":"failed","tool":"subagents","body":{"action":"open"}},{"seq":2,"createdAt":2,"kind":"ToolResult","callId":"failed","tool":"subagents","body":{"action":"open","error":"Unavailable","sessionId":"failed-agent"}},{"seq":3,"createdAt":3,"kind":"ToolCall","callId":"blocked","tool":"subagents","body":{"action":"open"}},{"seq":4,"createdAt":4,"kind":"ToolResult","callId":"blocked","tool":"subagents","body":{"action":"open","blocked":"needs_approval"}},{"seq":5,"createdAt":5,"kind":"ToolCall","callId":"missing-id","tool":"subagents","body":{"action":"open"}},{"seq":6,"createdAt":6,"kind":"ToolResult","callId":"missing-id","tool":"subagents","body":{"action":"open","ok":true}},{"seq":7,"createdAt":7,"kind":"ToolCall","callId":"read","tool":"subagents","body":{"action":"read"}},{"seq":8,"createdAt":8,"kind":"ToolCall","callId":"file","tool":"files","body":{"action":"open"}}]
        """#.utf8))
    XCTAssertTrue(
      NativeAgentBranch.pendingLaunches(NativeWorkItem.items(items), listed: []).isEmpty)
  }

  func testMissingParentsAndCyclesKeepEveryServedAgentAccessibleOnce() {
    let sessions = [
      conversation("visible", parent: "hidden"), conversation("child", parent: "visible"),
      conversation("loop-a", parent: "loop-b"), conversation("loop-b", parent: "loop-a"),
      conversation("visible", parent: "hidden"), conversation("root", parent: nil),
    ]
    let rows = NativeAgentBranch.rows(sessions, rootID: "root")
    XCTAssertEqual(rows.map(\.id), ["visible", "child", "loop-a", "loop-b"])
    XCTAssertEqual(rows.first?.parentName, "another agent")
  }

  func testCurrentWorkKeepsActiveChildrenWithoutTheirFinishedAncestors() {
    let returned = (0..<5).map { conversation("old-\($0)") }
    var active = conversation("new-work", parent: "old-0")
    active.working = true
    var waiting = conversation("needs-you")
    waiting.awaitingInput = true
    let rows = NativeAgentBranch.rows(returned + [active, waiting], rootID: "root")
    let current = NativeAgentBranch.current(rows)
    XCTAssertEqual(current.map(\.id), ["new-work", "needs-you"])
    XCTAssertEqual(current.first?.parentName, "old-0")
    XCTAssertEqual(
      rows.map(\.id), ["old-0", "new-work", "old-1", "old-2", "old-3", "old-4", "needs-you"])
  }

  func testNextPromptRetiresFinishedAgentsAndKeepsTheirHistoryAcrossReopens() async {
    let client = client()
    server.state.withLock {
      $0.fallback.body =
        #"{"sessions":[{"id":"returned","scopeId":"personal:alice","threadRef":"agent:returned","lastActivityAt":1000},{"id":"failed","scopeId":"personal:alice","threadRef":"agent:failed","lastTurnFailed":true,"lastActivityAt":1000},{"id":"working","scopeId":"personal:alice","threadRef":"agent:working","working":true,"lastActivityAt":1000},{"id":"waiting","scopeId":"personal:alice","threadRef":"agent:waiting","awaitingInput":true,"lastActivityAt":1000},{"id":"new","scopeId":"personal:alice","threadRef":"agent:new","lastActivityAt":3000}]}"#
    }
    for _ in 0..<2 {
      let model = NativeAgentTrailModel(client: client, conversationID: "root")
      await model.refresh()
      XCTAssertEqual(NativeAgentBranch.current(model.branches).map(\.id), ["working", "waiting"])
      XCTAssertEqual(
        NativeAgentBranch.current(model.branches, since: 500).map(\.id),
        ["returned", "failed", "working", "waiting", "new"])
      XCTAssertEqual(
        NativeAgentBranch.current(model.branches, since: 2000).map(\.id),
        ["working", "waiting", "new"])
      XCTAssertEqual(
        NativeAgentBranch.current(model.branches, since: 4000).map(\.id), ["working", "waiting"])
      XCTAssertEqual(model.branches.map(\.id), ["returned", "failed", "working", "waiting", "new"])
    }
  }

  func testReactivatedAgentKeepsItsResultUntilTheNextPrompt() async {
    let model = NativeAgentTrailModel(client: client(), conversationID: "root")
    server.state.withLock {
      $0.fallback.body =
        #"{"sessions":[{"id":"agent","scopeId":"personal:alice","threadRef":"agent:1","lastActivityAt":1000}]}"#
    }
    await model.refresh()
    XCTAssertTrue(NativeAgentBranch.current(model.branches, since: 2000).isEmpty)
    server.state.withLock {
      $0.fallback.body =
        #"{"sessions":[{"id":"agent","scopeId":"personal:alice","threadRef":"agent:1","working":true,"lastActivityAt":3000}]}"#
    }
    await model.refresh()
    XCTAssertEqual(NativeAgentBranch.current(model.branches, since: 2000).map(\.id), ["agent"])
    server.state.withLock {
      $0.fallback.body =
        #"{"sessions":[{"id":"agent","scopeId":"personal:alice","threadRef":"agent:1","lastActivityAt":3000}]}"#
    }
    await model.refresh()
    XCTAssertEqual(NativeAgentBranch.current(model.branches, since: 2000).map(\.id), ["agent"])
    XCTAssertTrue(NativeAgentBranch.current(model.branches, since: 4000).isEmpty)
    server.state.withLock {
      $0.fallback.body =
        #"{"sessions":[{"id":"agent","scopeId":"personal:alice","threadRef":"agent:1","working":true,"lastActivityAt":4000}]}"#
    }
    await model.refresh()
    XCTAssertEqual(NativeAgentBranch.current(model.branches, since: 4000).map(\.id), ["agent"])
    server.state.withLock {
      $0.fallback.body =
        #"{"sessions":[{"id":"agent","scopeId":"personal:alice","threadRef":"agent:1","lastTurnFailed":true,"lastActivityAt":5000}]}"#
    }
    await model.refresh()
    XCTAssertEqual(NativeAgentBranch.current(model.branches, since: 4000).map(\.id), ["agent"])
    XCTAssertTrue(NativeAgentBranch.current(model.branches, since: 6000).isEmpty)
    XCTAssertEqual(model.branches.first?.state, .failed)
  }

  func testCompletionUpdatesInPlace() {
    var first = conversation("first")
    first.lastActivityAt = 1000
    first.working = true
    var second = conversation("second")
    second.lastActivityAt = 1000
    second.working = true
    func current() -> [NativeAgentBranch] {
      NativeAgentBranch.current(
        NativeAgentBranch.rows([first, second], rootID: "root"),
        since: 500)
    }
    XCTAssertEqual(current().map(\.id), ["first", "second"])
    first.working = false
    XCTAssertEqual(current().map(\.id), ["first", "second"])
    XCTAssertEqual(current().map(\.state), [.returned, .working])
  }

  func testStatusMatchesServerSessionFlagsAndPreservesRealTaskName() throws {
    let list = try JSONDecoder().decode(
      ConversationList.self,
      from: Data(
        #"{"sessions":[{"id":"a","scopeId":"personal:a","threadRef":"a","title":"  ","purpose":"Inspect streaming","working":true,"awaitingInput":true,"lastTurnFailed":true},{"id":"b","scopeId":"personal:a","threadRef":"b","working":true,"lastTurnFailed":true},{"id":"c","scopeId":"personal:a","threadRef":"c","lastTurnFailed":true},{"id":"d","scopeId":"personal:a","threadRef":"d"}]}"#
          .utf8))
    let rows = NativeAgentBranch.rows(list.sessions, rootID: "root")
    XCTAssertEqual(rows.map(\.state), [.waiting, .working, .failed, .returned])
    XCTAssertEqual(rows.map(\.name), ["Inspect streaming", "Agent", "Agent", "Agent"])
  }

  func testChildrenEndpointRetainsSnapshotOnFailureAndReplacesItAfterRecovery() async {
    let model = NativeAgentTrailModel(client: client(), conversationID: "root")
    await model.refresh()
    XCTAssertEqual(model.branches.map(\.name), ["Check streaming"])
    XCTAssertEqual(model.branches.first?.conversation.purpose, "Verify updates after commentary")
    XCTAssertEqual(model.branches.first?.conversation.workingSince, 1000)
    XCTAssertEqual(model.branches.first?.state, .working)
    let checkedAt = model.updatedAt
    XCTAssertNotNil(checkedAt)
    server.state.withLock { $0.fallback.failure = .notConnectedToInternet }
    await model.refresh()
    XCTAssertEqual(model.branches.map(\.id), ["agent"])
    XCTAssertEqual(model.updatedAt, checkedAt)
    XCTAssertTrue(model.stale)
    server.state.withLock {
      $0.fallback.failure = nil
      $0.fallback.body = #"{"sessions":[]}"#
    }
    await model.refresh()
    XCTAssertTrue(model.branches.isEmpty)
    XCTAssertFalse(model.stale)
    XCTAssertEqual(
      server.state.withLock { $0.calls.map { $0.url.path } },
      Array(repeating: "/api/sessions/root/children", count: 3))
  }

  func testInitialFailureIsVisibleAndRetryCanFindNewlySpawnedAgents() async {
    let model = NativeAgentTrailModel(client: client(), conversationID: "root")
    server.state.withLock { $0.fallback.failure = .notConnectedToInternet }
    await model.refresh()
    XCTAssertTrue(model.branches.isEmpty)
    XCTAssertNotNil(model.error)
    XCTAssertNil(model.updatedAt)
    server.state.withLock { $0.fallback.failure = nil }
    await model.refresh()
    XCTAssertEqual(model.branches.map(\.id), ["agent"])
    XCTAssertNil(model.error)
  }

  func testLoadingStateTracksTheRequestWithoutClearingTheRoster() async {
    let model = NativeAgentTrailModel(client: client(), conversationID: "root")
    XCTAssertFalse(model.loading)
    await model.refresh()
    let started = expectation(description: "Agent refresh started")
    server.hold(route)
    server.state.withLock { $0.onCall = { _ in started.fulfill() } }
    let pending = Task { await model.refresh() }
    await fulfillment(of: [started], timeout: 2)
    XCTAssertTrue(model.loading)
    XCTAssertEqual(model.branches.map(\.id), ["agent"])
    server.release(route)
    await pending.value
    XCTAssertFalse(model.loading)
    XCTAssertEqual(model.branches.map(\.id), ["agent"])
  }

  func testSignOutDropsPendingAgentResponseAndOldSnapshot() async {
    let client = client()
    let model = NativeAgentTrailModel(client: client, conversationID: "root")
    await model.refresh()
    let started = expectation(description: "Agent refresh started")
    server.hold(route)
    server.state.withLock { $0.onCall = { _ in started.fulfill() } }
    let pending = Task { await model.refresh() }
    await fulfillment(of: [started], timeout: 2)
    client.signOut()
    server.release(route)
    await pending.value
    XCTAssertTrue(model.branches.isEmpty)
    XCTAssertNil(model.updatedAt)
    XCTAssertFalse(model.stale)
  }

  func testCancellingVisibleRefreshDoesNotReportAnOfflineError() async {
    let model = NativeAgentTrailModel(client: client(), conversationID: "root")
    await model.refresh()
    let started = expectation(description: "Agent refresh started")
    server.hold(route)
    server.state.withLock { $0.onCall = { _ in started.fulfill() } }
    let pending = Task { await model.refresh() }
    await fulfillment(of: [started], timeout: 2)
    pending.cancel()
    await pending.value
    XCTAssertEqual(model.branches.map(\.id), ["agent"])
    XCTAssertFalse(model.stale)
  }

  func testAgentAppearanceUsesStableSessionIdentity() {
    XCTAssertEqual(NativeAgentAvatar.variant(for: "agent"), 212)
    XCTAssertEqual(NativeAgentAvatar.variant(for: "streaming"), 179)
  }
}
