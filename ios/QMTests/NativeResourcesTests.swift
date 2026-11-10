import XCTest
import os

@testable import QM

final class NativeResourcesProtocol: URLProtocol, @unchecked Sendable {
  struct State {
    var requests: [URLRequest] = []
    var repeatCursor = false
    var rejectMutation = false
  }
  static let state = OSAllocatedUnfairLock(initialState: State())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let snapshot = Self.state.withLock { state in
      state.requests.append(request)
      return state
    }
    let url = request.url!
    let body: String
    var status = 200
    let project =
      #"{"id":"p1","name":"Launch","ownerId":"alice","memberIds":["alice"],"scopeId":"group:web-project-p1","members":[{"principalId":"alice","displayName":"Alice"}]}"#
    if url.path == "/api/memory" {
      let first = #"{"id":"f1","text":"Keeps answers short","createdAt":1000}"#
      let second = #"{"id":"f2","text":"Prefers Swift","createdAt":2000}"#
      if snapshot.rejectMutation && request.httpMethod != "GET" {
        status = 403
        body = #"{"error":"forbidden"}"#
      } else if request.httpMethod == "PATCH" {
        let edited = #"{"id":"f1","text":"Keeps answers very short","createdAt":1000}"#
        body = "{\"facts\":[\(edited),\(second)]}"
      } else if request.httpMethod == "DELETE" {
        body = "{\"facts\":[\(second)]}"
      } else {
        body = "{\"facts\":[\(first),\(second)]}"
      }
    } else if url.path == "/api/contexts" {
      body =
        "{\"contexts\":[{\"scopeId\":\"group:web-project-p1\",\"kind\":\"group\",\"name\":\"Launch\",\"sessionCount\":0,\"project\":\(project)}]}"
    } else if url.path == "/api/sessions" {
      body = #"{"sessions":[]}"#
    } else if url.path.hasPrefix("/api/projects") {
      status = snapshot.rejectMutation ? 403 : 201
      body = "{\"project\":\(project)}"
    } else {
      let cursor = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems?.first {
        $0.name == "cursor"
      }?.value
      let file =
        #"{"id":"first","name":"Plan.pdf","mimetype":"application/pdf","sizeBytes":40,"direction":"out","createdAt":1000,"openable":true}"#
      let other =
        #"{"id":"second","name":"photo.png","mimetype":"image/png","sizeBytes":80,"direction":"in","createdAt":2000,"openable":true}"#
      body =
        cursor == nil
        ? "{\"owned\":[\(file)],\"nextCursor\":\"page2\"}"
        : "{\"owned\":[\(file)],\"shared\":[\(other)]\(snapshot.repeatCursor ? ",\"nextCursor\":\"page2\"" : "")}"
    }
    let response = HTTPURLResponse(
      url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor
final class NativeResourcesTests: XCTestCase {
  private func client() -> APIClient {
    NativeResourcesProtocol.state.withLock { $0 = .init() }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [NativeResourcesProtocol.self]
    return APIClient(
      baseURL: URL(string: "https://native-resources.example")!, configuration: config)
  }

  func testFilesPaginationKeepsScopeAndDeduplicatesOwnedAndSharedResults() async {
    let client = client()
    let model = WorkspaceFilesModel(client: client, scope: "group:launch")
    await model.load(reset: true)
    await model.loadAll()
    XCTAssertEqual(model.files.map(\.id), ["first", "second"])
    XCTAssertEqual(model.files.map(\.kind), ["Created", "Shared"])
    XCTAssertEqual(model.files.map(\.category), ["Documents", "Images"])
    XCTAssertNil(model.nextCursor)
    XCTAssertNil(model.error)
    let requests = NativeResourcesProtocol.state.withLock { $0.requests }
    XCTAssertEqual(requests.count, 2)
    for request in requests {
      XCTAssertEqual(
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
          $0.name == "scope"
        }?.value, "group:launch")
    }
  }

  func testActiveFileFilterSurvivesRefresh() async {
    let model = WorkspaceFilesModel(client: client(), scope: nil)
    model.filtering = true
    await model.load(reset: true)
    XCTAssertEqual(model.files.count, 2)
    await model.load(reset: true)
    XCTAssertEqual(model.files.count, 2)
    XCTAssertNil(model.nextCursor)
    XCTAssertEqual(NativeResourcesProtocol.state.withLock { $0.requests.count }, 4)
  }

  func testFileFilterWaitsForInitialLoad() async {
    let model = WorkspaceFilesModel(client: client(), scope: nil)
    model.loading = true
    let filtering = Task { await model.loadAll() }
    await model.load(reset: true)
    await filtering.value
    XCTAssertEqual(model.files.map(\.id), ["first", "second"])
  }

  func testProjectRefreshIncludesAccountDraftsAndRemovesEmptyDrafts() async throws {
    let client = client()
    let user = UUID().uuidString
    let account = client.baseURL.absoluteString + user
    defer { DraftStore.removeAccount(account) }
    let conversation = Conversation(
      id: "draft", scopeId: "group:web-project-p1", threadRef: "web:draft", surface: "web",
      localOnly: true)
    let drafts = DraftStore(account: account, thread: conversation.threadRef)
    try drafts.write(.init(text: "Unsent project draft", conversation: conversation))
    let model = ProjectsModel(client: client, user: user)
    await model.load()
    XCTAssertEqual(model.conversations.first?.label, "Unsent project draft")
    XCTAssertEqual(model.conversations.first?.localOnly, true)
    try drafts.write(.init())
    await model.load()
    XCTAssertTrue(model.conversations.isEmpty)
  }

  func testCronTitleEditsDoNotResetCadenceOrChangeLiteralMessages() throws {
    let literal = try JSONDecoder().decode(
      NativeCron.self,
      from: Data(
        #"{"id":"c1","ownerScopeId":"personal:a","owner":"a","title":"Old","message":"Literal text","schedule":{"everyMs":60000,"firstFireAt":1000},"enabled":true}"#
          .utf8))
    let patch = literal.editPatch(
      title: "New", task: "Changed instructions", schedule: literal.schedule)
    XCTAssertEqual(patch["title"] as? String, "New")
    XCTAssertNil(patch["schedule"])
    XCTAssertNil(patch["task"])
    XCTAssertFalse(literal.canEditTask)
    let reschedule = literal.editPatch(
      title: "Old", task: literal.task,
      schedule: .init(everyMs: 120000, firstFireAt: 1000, cron: nil, timezone: nil))
    let timing = try XCTUnwrap(reschedule["schedule"] as? [String: Any])
    XCTAssertEqual(timing["everyMs"] as? Double, 120000)
    XCTAssertNil(timing["firstFireAt"])
  }

  func testWebhookFilterValidationPreservesValuesAndRejectsIncompleteRules() throws {
    let filters = try WebhooksModel.parseFilters("action: opened, closed\nrepository.name: qm\n")
    XCTAssertEqual(filters.count, 2)
    XCTAssertEqual(filters[0]["in"] as? [String], ["opened", "closed"])
    XCTAssertThrowsError(try WebhooksModel.parseFilters("action"))
    XCTAssertThrowsError(try WebhooksModel.parseFilters("action: ,"))
    XCTAssertThrowsError(try WebhooksModel.parseFilters(": value"))
  }

  func testRepeatedFileCursorStopsInsteadOfLooping() async {
    let model = WorkspaceFilesModel(client: client(), scope: nil)
    NativeResourcesProtocol.state.withLock { $0.repeatCursor = true }
    await model.load(reset: true)
    await model.loadAll()
    XCTAssertNotNil(model.error)
    XCTAssertNil(model.nextCursor)
    XCTAssertEqual(NativeResourcesProtocol.state.withLock { $0.requests.count }, 2)
  }

  func testProjectUsesCanonicalScopeAndRejectedMutationDoesNotEraseCurrentData() async {
    let model = ProjectsModel(client: client())
    await model.load()
    XCTAssertEqual(model.contexts.first?.scopeId, "group:web-project-p1")
    let created = await model.mutate("api/projects", body: ["name": "Launch"])
    XCTAssertEqual(created?.scopeId, "group:web-project-p1")
    XCTAssertEqual(model.contexts.count, 1)
    NativeResourcesProtocol.state.withLock { $0.rejectMutation = true }
    let denied = await model.mutate("api/projects/p1", body: ["name": "Changed"], method: "PATCH")
    XCTAssertNil(denied)
    XCTAssertEqual(model.contexts.first?.title, "Launch")
    XCTAssertNotNil(model.error)
    XCTAssertFalse(model.busy)
  }

  func testMemoryEditsAndForgetsFactsThroughTheServerList() async throws {
    let model = MemoryModel(client: client())
    await model.load()
    XCTAssertEqual(model.facts.map(\.id), ["f1", "f2"])
    let edited = await model.edit(model.facts[0], text: "Keeps answers very short")
    XCTAssertTrue(edited)
    XCTAssertEqual(model.facts.first?.text, "Keeps answers very short")
    let patch = try XCTUnwrap(NativeResourcesProtocol.state.withLock { $0.requests.last })
    XCTAssertEqual(patch.httpMethod, "PATCH")
    let forgot = await model.forget(model.facts[0])
    XCTAssertTrue(forgot)
    XCTAssertEqual(model.facts.map(\.id), ["f2"])
    XCTAssertFalse(model.busy)
  }

  func testMemoryKeepsFactsWhenTheServerRejectsAChange() async {
    let model = MemoryModel(client: client())
    await model.load()
    NativeResourcesProtocol.state.withLock { $0.rejectMutation = true }
    let forgot = await model.forget(model.facts[0])
    XCTAssertFalse(forgot)
    XCTAssertEqual(model.facts.map(\.id), ["f1", "f2"])
    XCTAssertNotNil(model.error)
  }

  func testAPIComponentsEncodeOnceAndCannotAddAPathOrQuery() {
    let client = client()
    let member = "alice+ops@example.com/team?admin=true#fragment"
    let url = client.url("api/projects/p1/members/\(member.apiComponent)")
    XCTAssertNil(url.query)
    XCTAssertNil(url.fragment)
    XCTAssertTrue(url.absoluteString.contains("%2Fteam%3Fadmin=true%23fragment"))
    XCTAssertFalse(url.absoluteString.contains("%252F"))
    XCTAssertEqual(
      client.url("api/sessions").absoluteString, "https://native-resources.example/api/sessions")
  }
}
