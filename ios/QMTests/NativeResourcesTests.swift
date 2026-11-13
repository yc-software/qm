import XCTest
import os

@testable import QM

final class NativeResourcesProtocol: URLProtocol, @unchecked Sendable {
  struct State {
    var requests: [URLRequest] = []
    var repeatCursor = false
    var rejectMutation = false
    var publicLinksUnavailable = false
    var holdsAccessLoad = false
    var heldAccessLoad: NativeResourcesProtocol?
    var bodies: [Data] = []
  }
  static let state = OSAllocatedUnfairLock(initialState: State())
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let payloadData = request.bodyData
    let payload = (try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any]) ?? [:]
    let snapshot = Self.state.withLock { state in
      state.requests.append(request)
      state.bodies.append(payloadData)
      if state.holdsAccessLoad, request.httpMethod == "GET",
        request.url!.path == "/api/apps/d1/share"
      {
        state.heldAccessLoad = self
      }
      return state
    }
    if snapshot.heldAccessLoad !== self { respond(snapshot, payload) }
  }
  static func releaseAccessLoad() {
    let (held, snapshot) = state.withLock { state in
      let held = state.heldAccessLoad
      state.heldAccessLoad = nil
      state.holdsAccessLoad = false
      return (held, state)
    }
    held?.respond(snapshot, [:])
  }
  private func respond(_ snapshot: State, _ payload: [String: Any]) {
    let url = request.url!
    let body: String
    var status = 200
    let project =
      #"{"id":"p1","name":"Launch","ownerId":"alice","memberIds":["alice"],"scopeId":"group:web-project-p1","members":[{"principalId":"alice","displayName":"Alice"}]}"#
    if url.path == "/api/contexts" {
      body =
        "{\"contexts\":[{\"scopeId\":\"group:web-project-p1\",\"kind\":\"group\",\"name\":\"Launch\",\"sessionCount\":0,\"project\":\(project)}]}"
    } else if url.path == "/api/sessions" {
      body = #"{"sessions":[]}"#
    } else if url.path == "/api/connectors" {
      body = #"{"providers":{}}"#
    } else if url.path == "/api/keychain/overview" {
      let ask =
        #"{"id":"a1","credentialId":"c1","requesterId":"bob","requesterScopeId":"group:web-project-p1","purpose":"Deploy","requestedMode":"once","expiresAt":1800000000000}"#
      body =
        "{\"credentials\":[{\"id\":\"c1\",\"service\":\"vercel\"}],\"connectorCredentials\":[],\"grants\":[],\"asks\":[\(ask)],\"scopeNames\":{\"group:web-project-p1\":\"Launch\"}}"
    } else if url.path == "/api/apps/d1/share" {
      let grantees = #"[{"scope":"personal:bob","permission":"read"}]"#
      if request.httpMethod == "GET" {
        body = "{\"public\":false,\"externalSharing\":true,\"grantees\":\(grantees)}"
      } else if snapshot.publicLinksUnavailable {
        status = 409
        body = #"{"error":"public_links_unavailable","message":"Public links are unavailable."}"#
      } else {
        body =
          "{\"ok\":true,\"public\":\(payload["public"] as? Bool ?? false),\"reach\":\"anyone with the link\",\"grantees\":\(grantees)}"
      }
    } else if url.path == "/api/webhooks" {
      let verification = payload["verification"] as? [String: String] ?? [:]
      body =
        "{\"url\":\"https://native-resources.example/hooks/w1\",\"webhook\":{\"id\":\"w1\",\"action\":\"Triage\",\"verification\":{\"scheme\":\"\(verification["scheme"] ?? "")\",\"secret\":\"***\"},\"enabled\":true,\"createdAt\":1000}}"
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
  private func bodies() -> [[String: Any]] {
    NativeResourcesProtocol.state.withLock { $0.bodies }.compactMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
  }
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
    await model.loadConversations(conversation.scopeId)
    XCTAssertEqual(model.conversations[conversation.scopeId]?.first?.label, "Unsent project draft")
    XCTAssertEqual(model.conversations[conversation.scopeId]?.first?.localOnly, true)
    try drafts.write(.init())
    await model.loadConversations(conversation.scopeId)
    XCTAssertEqual(model.conversations[conversation.scopeId], [])
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

  func testKeychainListsARequestWithItsRequesterScopeAndMode() async throws {
    let model = KeychainModel(client: client())
    await model.load()
    let ask = try XCTUnwrap(model.overview?.asks?.first)
    XCTAssertEqual(ask.credentialId, "c1")
    XCTAssertEqual(ask.requesterScopeId, "group:web-project-p1")
    XCTAssertEqual(ask.requestedMode, "once")
    XCTAssertEqual(ask.purpose, "Deploy")
    XCTAssertEqual(model.overview?.scopeNames?["group:web-project-p1"], "Launch")
    XCTAssertNil(model.error)
  }

  func testPublicAccessFailureRevertsAndSuccessSendsOnlyThePublicFlag() async throws {
    let app = try JSONDecoder().decode(
      NativeApp.self,
      from: Data(
        #"{"id":"d1","ownerScopeId":"personal:alice","embedAncestors":["https://a.example"]}"#.utf8)
    )
    XCTAssertEqual(app.embedAncestors, ["https://a.example"])
    let model = AppPermissionsModel(client: client(), app: app)
    await model.load()
    XCTAssertFalse(model.isPublic)
    XCTAssertTrue(model.externalSharing)
    XCTAssertEqual(model.grants.map(\.scope), ["personal:bob"])
    NativeResourcesProtocol.state.withLock { $0.publicLinksUnavailable = true }

    await model.setPublic(true)

    XCTAssertFalse(model.isPublic)
    XCTAssertEqual(model.error, "Public links are unavailable.")
    XCTAssertFalse(model.busy)
    NativeResourcesProtocol.state.withLock { $0.publicLinksUnavailable = false }

    await model.setPublic(true)

    XCTAssertTrue(model.isPublic)
    XCTAssertNil(model.error)
    let body = try XCTUnwrap(bodies().last)
    XCTAssertEqual(body["public"] as? Bool, true)
    XCTAssertEqual(body.keys.sorted(), ["public"])
    await model.setPublic(true)
    XCTAssertEqual(bodies().count, 2)
  }

  func testARefreshThatStartedBeforeASaveDoesNotOverwriteIt() async throws {
    let app = try JSONDecoder().decode(
      NativeApp.self, from: Data(#"{"id":"d1","ownerScopeId":"personal:alice"}"#.utf8))
    let model = AppPermissionsModel(client: client(), app: app)
    await model.load()
    NativeResourcesProtocol.state.withLock { $0.holdsAccessLoad = true }
    let refresh = Task { await model.load() }
    while NativeResourcesProtocol.state.withLock({ $0.heldAccessLoad == nil }) {
      try await Task.sleep(for: .milliseconds(10))
    }

    await model.setPublic(true)
    XCTAssertTrue(model.isPublic)
    NativeResourcesProtocol.releaseAccessLoad()
    await refresh.value

    XCTAssertTrue(model.isPublic)
    XCTAssertFalse(model.loading)
    XCTAssertNil(model.error)
  }

  func testEmbeddingSitesAreTrimmedAndDeduplicatedInTheOrderTyped() {
    XCTAssertEqual(
      NativeApp.parseEmbedAncestors(
        "https://tools.example.com\n\n  https://*.example.com  \nhttps://tools.example.com\n"),
      ["https://tools.example.com", "https://*.example.com"])
    XCTAssertEqual(NativeApp.parseEmbedAncestors("\n \n"), [])
    XCTAssertEqual(
      NativeApp.parseEmbedAncestors("http://example.com/app"), ["http://example.com/app"])
  }

  func testWebhookCreationOffersAndSendsTheLinearScheme() async throws {
    XCTAssertTrue(WebhooksModel.verificationSchemes.contains { $0.id == "linear" })
    let model = WebhooksModel(client: client())
    let result = await model.create(action: "Triage", scheme: "linear", secret: "", filters: "")
    let created = try XCTUnwrap(result)
    XCTAssertEqual(created.webhook.verification.scheme, "linear")
    let body = try XCTUnwrap(bodies().last)
    XCTAssertEqual((body["verification"] as? [String: String])?["scheme"], "linear")
  }
}
