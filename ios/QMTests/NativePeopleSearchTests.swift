import XCTest
import os

@testable import QM

@MainActor
final class NativePeopleSearchTests: XCTestCase {
  private let server = NativeRouteProtocol.Server()

  private func model() -> NativePeopleSearchModel {
    NativePeopleSearchModel(
      client: server.client(
        holding: ["First", "Second", "Pending", "Missing"].map {
          "GET /api/directory/resolve?q=\($0)"
        }.reduce(into: Set<String>()) { $0.insert($1) }))
  }

  private func respond(to query: String, body: String, status: Int = 200) {
    let route = "GET /api/directory/resolve?q=\(query)"
    server.reply(route, status: status, body)
    server.release(route)
  }

  func testSupersededResponseCannotClearTheNewSearchPendingState() async {
    let model = model()
    let first = expectation(description: "First directory query")
    let second = expectation(description: "Second directory query")
    let server = self.server
    server.state.withLock {
      $0.onCall = { [server] _ in
        let query = server.calls.last?.parameters["q"]
        if query == "First" { first.fulfill() }
        if query == "Second" { second.fulfill() }
      }
    }
    model.query = "First"
    let oldSearch = Task { await model.search() }
    await fulfillment(of: [first], timeout: 2)
    model.query = "Second"
    XCTAssertTrue(model.searching)
    XCTAssertFalse(model.completed)
    let newSearch = Task { await model.search() }
    await fulfillment(of: [second], timeout: 2)

    respond(
      to: "First",
      body: #"{"matches":[{"principalId":"first","displayName":"First","type":"internal"}]}"#)
    await oldSearch.value
    XCTAssertTrue(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertTrue(model.matches.isEmpty)

    respond(
      to: "Second",
      body: #"{"matches":[{"principalId":"second","displayName":"Second","type":"internal"}]}"#)
    await newSearch.value
    XCTAssertFalse(model.searching)
    XCTAssertTrue(model.completed)
    XCTAssertEqual(model.matches.map(\.id), ["second"])
    XCTAssertNil(model.error)
  }

  func testTaskCancellationDoesNotPresentAnEmptyResult() async {
    let model = model()
    let pending = expectation(description: "Pending directory query")
    server.state.withLock { $0.onCall = { _ in pending.fulfill() } }
    model.query = "Pending"
    let search = Task { await model.search() }
    await fulfillment(of: [pending], timeout: 2)
    search.cancel()
    await search.value
    XCTAssertFalse(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertNil(model.error)
  }

  func testClearingQueryDropsDelayedFailure() async {
    let model = model()
    let pending = expectation(description: "Pending directory query")
    server.state.withLock { $0.onCall = { _ in pending.fulfill() } }
    model.query = "Pending"
    let search = Task { await model.search() }
    await fulfillment(of: [pending], timeout: 2)
    model.query = ""
    XCTAssertFalse(model.searching)
    respond(
      to: "Pending", body: #"{"message":"Directory unavailable"}"#, status: 503)
    await search.value
    XCTAssertNil(model.error)
    XCTAssertFalse(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertTrue(model.matches.isEmpty)
  }

  func testFailedSearchCanRetryAndOnlyCompletedResponseIsEmpty() async {
    let model = model()
    let failed = expectation(description: "Failed directory query")
    server.state.withLock { $0.onCall = { _ in failed.fulfill() } }
    model.query = "Missing"
    let search = Task { await model.search() }
    await fulfillment(of: [failed], timeout: 2)
    respond(
      to: "Missing", body: #"{"message":"Directory unavailable"}"#, status: 503)
    await search.value
    XCTAssertFalse(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertEqual(model.error, "Directory unavailable")

    let retried = expectation(description: "Retried directory query")
    server.state.withLock { $0.onCall = { _ in retried.fulfill() } }
    server.hold("GET /api/directory/resolve?q=Missing")
    let retry = Task { await model.search() }
    await fulfillment(of: [retried], timeout: 2)
    XCTAssertTrue(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertNil(model.error)
    respond(to: "Missing", body: #"{"matches":[]}"#)
    await retry.value
    XCTAssertFalse(model.searching)
    XCTAssertTrue(model.completed)
    XCTAssertTrue(model.matches.isEmpty)
    XCTAssertNil(model.error)
  }

  private static let messages =
    #"{"hits":[{"sessionId":"s1","title":"Launch","snippet":"the launch plan","seq":4}]}"#
  private static let resources = """
    {"hits":[
      {"id":"w1","kind":"webhooks","title":"Launch hook","snippet":""},
      {"id":"sk1","kind":"skills","title":"launch-notes","snippet":"Writes launch notes"},
      {"id":"group:p1","kind":"contexts","title":"Launch","snippet":"Project"},
      {"id":"sk2","kind":"skills","title":"launch-check","snippet":""}
    ],"failed":[]}
    """

  private func workspaceSearch(
    messages: [NativeRouteProtocol.Reply] = [.init(body: NativePeopleSearchTests.messages)],
    resources: [NativeRouteProtocol.Reply] = [.init(body: NativePeopleSearchTests.resources)],
    holding: Set<String> = []
  ) -> NativeWorkspaceSearchModel {
    NativeWorkspaceSearchModel(
      client: server.client(
        ["GET /api/search": messages, "GET /api/resources/search": resources],
        holding: holding),
      user: "alice")
  }

  func testWorkspaceSearchRunsMessagesAndResourcesTogetherGroupedByKind() async {
    let routes: Set = ["GET /api/search", "GET /api/resources/search"]
    let model = workspaceSearch(holding: routes)
    let both = expectation(description: "Both searches in flight")
    both.expectedFulfillmentCount = 2
    server.state.withLock { $0.onCall = { _ in both.fulfill() } }
    model.query = " launch "
    let search = Task { await model.search() }
    await fulfillment(of: [both], timeout: 2)
    XCTAssertTrue(model.searching)
    XCTAssertFalse(model.completed)
    XCTAssertEqual(Set(server.calls.map(\.route)), routes)
    XCTAssertEqual(server.calls.map(\.query), ["q=launch", "q=launch"])
    routes.forEach(server.release)
    await search.value

    XCTAssertFalse(model.searching)
    XCTAssertTrue(model.completed)
    XCTAssertEqual(model.hits.map(\.id), ["s1:4"])
    XCTAssertEqual(model.groups.map(\.kind), [.skills, .webhooks, .contexts])
    XCTAssertEqual(model.groups.map { $0.hits.map(\.id) }, [["sk1", "sk2"], ["w1"], ["group:p1"]])
    XCTAssertNil(model.resourceNotice)
    XCTAssertNil(model.chatError)
  }

  func testPartialResourceSearchReportsFailedKindsAndTruncation() async {
    let model = workspaceSearch(resources: [
      .init(
        body: """
          {"hits":[{"id":"c1","kind":"crons","title":"Launch digest","snippet":""}],
           "failed":["deploys"],"limited":["crons"]}
          """)
    ])
    model.query = "launch"
    await model.search()
    XCTAssertEqual(model.groups.map(\.kind), [.crons])
    XCTAssertEqual(model.failedResourceKinds, ["deploys"])
    XCTAssertTrue(model.resourcesLimited)
    XCTAssertNotNil(model.resourceNotice)
    XCTAssertNil(model.resourceError)
  }

  func testReturningToACompletedSearchKeepsResultsWithoutRefetching() async {
    let model = workspaceSearch()
    model.query = "launch"
    await model.search()
    XCTAssertTrue(model.completed)
    XCTAssertEqual(server.calls.count, 2)

    await model.search()
    XCTAssertTrue(model.completed)
    XCTAssertFalse(model.searching)
    XCTAssertEqual(model.hits.map(\.id), ["s1:4"])
    XCTAssertEqual(model.groups.flatMap(\.hits).count, 4)
    XCTAssertEqual(server.calls.count, 2)

    model.query = "launch "
    await model.search()
    XCTAssertEqual(server.calls.count, 4)
  }

  func testFailedSearchStaysUntilRetriedThenLoads() async {
    let model = workspaceSearch(
      messages: [
        .init(status: 503, body: #"{"message":"Search is rebuilding"}"#),
        .init(body: NativePeopleSearchTests.messages),
      ],
      resources: [
        .init(status: 503, body: #"{"message":"Resources unavailable"}"#),
        .init(body: NativePeopleSearchTests.resources),
      ])
    model.query = "launch"
    await model.search()
    await model.search()
    XCTAssertEqual(model.chatError, "Search is rebuilding")
    XCTAssertEqual(model.resourceError, "Resources unavailable")
    XCTAssertEqual(server.calls.count, 2)

    await model.retry()
    XCTAssertTrue(model.completed)
    XCTAssertNil(model.chatError)
    XCTAssertNil(model.resourceError)
    XCTAssertEqual(model.hits.map(\.id), ["s1:4"])
    XCTAssertEqual(model.groups.flatMap(\.hits).count, 4)
    XCTAssertEqual(server.calls.count, 4)
  }

  func testMessageSearchFailureKeepsResourceResults() async {
    let model = workspaceSearch(
      messages: [.init(status: 503, body: #"{"message":"Search is rebuilding"}"#)])
    model.query = "launch"
    await model.search()
    XCTAssertTrue(model.completed)
    XCTAssertEqual(model.chatError, "Search is rebuilding")
    XCTAssertTrue(model.hits.isEmpty)
    XCTAssertEqual(model.groups.flatMap(\.hits).count, 4)
    XCTAssertNil(model.resourceNotice)
  }

  func testResourceSearchFailureKeepsMessageResults() async {
    let model = workspaceSearch(
      resources: [.init(status: 503, body: #"{"message":"Resources unavailable"}"#)])
    model.query = "launch"
    await model.search()
    XCTAssertTrue(model.completed)
    XCTAssertEqual(model.hits.map(\.id), ["s1:4"])
    XCTAssertNil(model.chatError)
    XCTAssertTrue(model.groups.isEmpty)
    XCTAssertEqual(model.resourceError, "Resources unavailable")
  }

  func testWorkspaceSearchWaitsForTwoCharactersAndDropsSupersededQuery() async {
    let model = workspaceSearch()
    model.query = " l "
    await model.search()
    XCTAssertFalse(model.active)
    XCTAssertFalse(model.searching)
    XCTAssertFalse(model.completed)

    model.query = "la"
    XCTAssertTrue(model.searching)
    let superseded = Task { await model.search() }
    try? await Task.sleep(for: .milliseconds(20))
    XCTAssertTrue(server.calls.isEmpty)
    model.query = "launch"
    superseded.cancel()
    await model.search()
    await superseded.value
    XCTAssertTrue(model.completed)
    XCTAssertEqual(server.calls.map(\.query), ["q=launch", "q=launch"])
  }

  func testAskStartsPersonalConversationDraftedWithTheQuery() {
    let model = workspaceSearch()
    model.query = "  launch plan "
    let chat = model.ask()
    XCTAssertTrue(chat.draft.hasSuffix(" launch plan"))
    XCTAssertFalse(chat.draft.hasSuffix("  launch plan"))
    XCTAssertEqual(chat.conversation.scopeId, "personal:alice")
    XCTAssertEqual(chat.conversation.localOnly, true)
    XCTAssertEqual(chat.conversation.threadRef, "web:alice:\(chat.conversation.id)")
    XCTAssertTrue(server.calls.isEmpty)
  }

  func testOpeningASkillLoadsTheSkillListWhileTheSkillIsStillLoading() async throws {
    let route = "GET /api/skills/sk1"
    let client = server.client(
      [
        "GET /api/skills": [.init(body: #"{"skills":[]}"#)],
        route: [.init(status: 404, body: #"{"error":"not_found"}"#)],
      ], holding: [route])
    let opening = Task {
      _ = try await NativeResourceTarget.resolve(
        ResourceSearchHit(id: "sk1", kind: "skills", title: "Launch", snippet: ""),
        client: client, user: "alice")
    }
    func listed() -> Bool {
      Set(server.calls.map(\.route)).isSuperset(of: ["GET /api/skills", route])
    }
    let deadline = ContinuousClock.now + .seconds(2)
    while !listed(), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertTrue(listed())
    server.release(route)
    try await opening.value
  }

  func testResourceHitsResolveToTheirNativeDetail() async throws {
    let client = server.client([
      "GET /api/skills": [.init(body: #"{"skills":[]}"#)],
      "GET /api/skills/sk1": [
        .init(
          body: """
            {"skill":{"id":"sk1","name":"launch-notes","description":"","body":"Write notes",
              "scope":"org","scopeId":"org:acme","status":"draft","editable":true}}
            """)
      ],
      "GET /api/skills/gone": [.init(status: 404, body: #"{"error":"not_found"}"#)],
      "GET /api/contexts": [
        .init(body: #"{"contexts":[{"scopeId":"channel:C1","kind":"channel","sessionCount":0}]}"#)
      ],
      "GET /api/sessions": [.init(body: #"{"sessions":[]}"#)],
      "GET /api/crons": [
        .init(
          body: """
            {"crons":[],"visible":[
              {"id":"c1","ownerScopeId":"group:p1","owner":"bob","schedule":{},"enabled":true}]}
            """)
      ],
      "GET /api/deployments/d1": [.init(body: #"{"deployment":{"id":"d1"}}"#)],
      "GET /api/deployments/gone": [.init(status: 404, body: #"{"error":"not_found"}"#)],
      "GET /api/webhooks": [
        .init(
          body: """
            {"webhooks":[{"id":"w1","action":"notify","verification":{"scheme":"github"},
              "enabled":true,"createdAt":1}]}
            """)
      ],
    ])
    func detail(_ kind: String, _ id: String) async throws -> String? {
      let hit = ResourceSearchHit(id: id, kind: kind, title: "Launch", snippet: "")
      return switch try await NativeResourceTarget.resolve(hit, client: client, user: "alice") {
      case .skill(_, let skill): "skill \(skill.id)"
      case .cron(_, let cron): "cron \(cron.id)"
      case .app(let app): "app \(app.id)"
      case .webhook(_, let webhook): "webhook \(webhook.id)"
      case .project(_, let context): "project \(context.scopeId)"
      case nil: nil
      }
    }
    let skill = try await detail("skills", "sk1")
    let cron = try await detail("crons", "c1")
    let app = try await detail("deploys", "d1")
    let webhook = try await detail("webhooks", "w1")
    let project = try await detail("contexts", "channel:C1")
    let removed = try await detail("crons", "gone")
    let removedSkill = try await detail("skills", "gone")
    let removedApp = try await detail("deploys", "gone")
    let unknown = try await detail("loops", "l1")
    XCTAssertEqual(skill, "skill sk1")
    XCTAssertEqual(cron, "cron c1")
    XCTAssertEqual(app, "app d1")
    XCTAssertEqual(webhook, "webhook w1")
    XCTAssertEqual(project, "project channel:C1")
    XCTAssertNil(removed)
    XCTAssertNil(removedSkill)
    XCTAssertNil(removedApp)
    XCTAssertNil(unknown)
  }

  func testResourceDetailReportsALoadFailureInsteadOfMissing() async {
    let client = server.client([
      "GET /api/webhooks": [.init(status: 503, body: #"{"message":"Webhooks unavailable"}"#)],
      "GET /api/skills/sk1": [.init(status: 503, body: #"{"message":"Skills unavailable"}"#)],
    ])
    for (kind, id, message) in [
      ("webhooks", "w1", "Webhooks unavailable"), ("skills", "sk1", "Skills unavailable"),
    ] {
      let hit = ResourceSearchHit(id: id, kind: kind, title: "Launch", snippet: "")
      do {
        _ = try await NativeResourceTarget.resolve(hit, client: client, user: "alice")
        XCTFail("Expected the load failure")
      } catch {
        XCTAssertEqual(error.localizedDescription, message)
      }
    }
  }
}
