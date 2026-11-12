import Foundation
import Testing

@testable import QM

@MainActor
struct WorkspaceTests {
  @MainActor private struct Workspace {
    let model: AppModel
    let client: APIClient
    let server: NativeRouteProtocol.Server
    let sessions = "GET /api/sessions?"
    func sessions(_ query: [URLQueryItem]) -> String {
      sessions + (client.url("api/sessions", query: query).query ?? "")
    }
    func patch(_ id: String) -> String { "POST /api/sessions/\(id)?" }
    var listLoads: Int { server.calls.filter { $0.exact == sessions }.count }
    func patches(_ id: String) -> [[String: Bool]] {
      server.calls.filter { $0.exact == patch(id) }.compactMap {
        try? JSONSerialization.jsonObject(with: $0.body) as? [String: Bool]
      }
    }
  }

  private func workspace() throws -> Workspace {
    let server = NativeRouteProtocol.Server()
    server.reply("GET /me", #"{"user":"test"}"#)
    server.reply("GET /api/contexts", #"{"contexts":[]}"#)
    let model = AppModel(
      defaults: UserDefaults(suiteName: "workspace-\(server.host)")!,
      configuredURL: "https://\(server.host)", configuration: server.configuration)
    let client = try #require(model.client)
    try client.saveSession("token")
    return Workspace(model: model, client: client, server: server)
  }

  private func session(
    _ id: String, activity: Double, pinned: Bool = false, awaiting: Bool = false,
    archived: Bool = false, unread: Bool = false, title: String? = nil, color: String? = nil
  ) -> String {
    let fields: [String?] = [
      #""id":"\#(id)""#, #""scopeId":"personal:test""#, #""threadRef":"web:test:\#(id)""#,
      #""surface":"web""#, #""canContinue":true"#, #""lastActivityAt":\#(activity)"#,
      #""pinned":\#(pinned)"#, #""awaitingInput":\#(awaiting)"#, #""archived":\#(archived)"#,
      #""unread":\#(unread)"#, title.map { #""title":"\#($0)""# },
      color.map { #""color":"\#($0)""# },
    ]
    return "{\(fields.compactMap { $0 }.joined(separator: ","))}"
  }

  private func page(_ sessions: [String], pinned: [String] = [], next: String? = nil) -> String {
    let cursor = next.map { #""\#($0)""# } ?? "null"
    return #"{"sessions":[\#(sessions.joined(separator: ","))],"#
      + #""pinned":[\#(pinned.joined(separator: ","))],"hasArchived":true,"nextCursor":\#(cursor)}"#
  }

  private func pinned(_ model: AppModel) -> [String] {
    NativeConversationSection.grouped(model.conversations, contexts: [:])
      .filter { $0.id == "pinned" }.flatMap(\.conversations).map(\.id)
  }

  private func unpinned(_ model: AppModel) -> [String] {
    NativeConversationSection.grouped(model.conversations, contexts: [:])
      .filter { $0.id != "pinned" }.flatMap(\.conversations).map(\.id)
  }

  private func eventually(_ condition: () -> Bool) async throws {
    for _ in 0..<500 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw QMError.message("The expected state was never reached")
  }

  @Test func filterRequestsStatusAndIgnoresStaleFirstPage() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    let waiting = workspace.sessions([.init(name: "status", value: "waiting")])
    workspace.server.reply(workspace.sessions, page([session("a", activity: 10)]))
    workspace.server.reply(
      waiting, page([session("w", activity: 9, awaiting: true)]))
    workspace.server.hold(workspace.sessions)
    let first = Task { await model.load() }
    try await eventually { workspace.server.isHeld(workspace.sessions) }

    await model.select(.waiting)
    #expect(model.filter == .waiting)
    #expect(model.conversations.map(\.id) == ["w"])
    #expect(model.hasLoadedConversations)
    #expect(!model.loading)

    workspace.server.release(workspace.sessions)
    await first.value
    #expect(model.conversations.map(\.id) == ["w"])
    #expect(model.filter == .waiting)
    #expect(!model.loading)
  }

  @Test func pinnedSessionsLeadTheFirstPageAndANullCursorEndsPaging() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(
      workspace.sessions,
      page([session("b", activity: 10)], pinned: [session("p", activity: 1, pinned: true)]))
    await model.load()
    #expect(pinned(model) == ["p"])
    #expect(unpinned(model) == ["b"])
    #expect(model.nextCursor == nil)
    await model.loadMore()
    let listRequests = workspace.server.calls.filter {
      $0.url.path == "/api/sessions"
    }
    #expect(listRequests.count == 1)
    #expect(!model.loadingMore)
  }

  @Test func loadMoreAppendsOlderPagesAndRefreshKeepsThem() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    let older = workspace.sessions([.init(name: "before", value: "9.b")])
    workspace.server.reply(
      workspace.sessions,
      page([session("a", activity: 10), session("b", activity: 9)], next: "9.b"))
    workspace.server.reply(older, page([session("c", activity: 8)]))
    await model.load()
    #expect(model.nextCursor == "9.b")
    await model.loadMore()
    #expect(model.conversations.map(\.id) == ["a", "b", "c"])
    #expect(model.nextCursor == nil)
    #expect(!model.loadingMore)

    workspace.server.reply(
      workspace.sessions,
      page(
        [session("n", activity: 11), session("a", activity: 10), session("b", activity: 9)],
        next: "9.b"))
    await model.load(refreshIdentity: false)
    #expect(model.conversations.map(\.id) == ["n", "a", "b", "c"])
    #expect(model.nextCursor == nil)

    workspace.server.reply(
      workspace.sessions, page([session("n", activity: 11), session("a", activity: 10)]))
    await model.load(refreshIdentity: false)
    #expect(model.conversations.map(\.id) == ["n", "a"])
  }

  @Test func loadMoreForThePreviousFilterIsIgnored() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    let older = workspace.sessions([.init(name: "before", value: "10.a")])
    let archived = workspace.sessions([.init(name: "status", value: "archived")])
    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 10)], next: "10.a"))
    workspace.server.reply(older, page([session("z", activity: 5)]))
    workspace.server.reply(
      archived, page([session("r", activity: 7, archived: true)]))
    workspace.server.hold(older)
    await model.load()
    let more = Task { await model.loadMore() }
    try await eventually { workspace.server.isHeld(older) }
    #expect(model.loadingMore)

    await model.select(.archived)
    #expect(!model.loadingMore)
    #expect(model.conversations.map(\.id) == ["r"])
    workspace.server.release(older)
    await more.value
    #expect(model.conversations.map(\.id) == ["r"])
    #expect(model.nextCursor == nil)
    #expect(model.filter == .archived)
    #expect(!model.loadingMore)
  }

  @Test func openingAnUnreadConversationMarksItRead() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 10, unread: true)]))
    await model.load()
    workspace.server.reply(
      workspace.patch("a"), #"{"session":\#(session("a", activity: 10))}"#)
    workspace.server.reply(workspace.sessions, page([session("a", activity: 10)]))
    await model.open(try #require(model.conversations.first))
    #expect(workspace.patches("a") == [["unread": false]])
    #expect(model.conversations.first?.unread == false)
    #expect(workspace.listLoads == 1)

    await model.open(try #require(model.conversations.first))
    #expect(workspace.patches("a").count == 1)
  }

  @Test func aConversationThatCouldNotBeMarkedReadShowsItsDotAgainWithoutAnError() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 10, unread: true)]))
    workspace.server.reply(
      workspace.patch("a"), status: 500, #"{"message":"Unavailable"}"#)
    await model.load()
    await model.open(try #require(model.conversations.first))
    #expect(workspace.patches("a") == [["unread": false]])
    #expect(model.error == nil)

    await model.load(refreshIdentity: false)
    #expect(model.conversations.first?.unread == true)
    #expect(workspace.patches("a").count == 1)
  }

  @Test func leavingAConversationOpenedOutsideTheListMarksOnlyItsUnreadRowRead() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(
      workspace.sessions,
      page([
        session("a", activity: 12, unread: true), session("b", activity: 11, unread: true),
        session("c", activity: 10),
      ]))
    workspace.server.reply(
      workspace.patch("a"), #"{"session":\#(session("a", activity: 12))}"#)
    model.left("web:test:a")
    model.left("web:test:c")
    await model.load()
    #expect(workspace.patches("a") == [["unread": false]])
    #expect(workspace.patches("b").isEmpty)
    #expect(workspace.patches("c").isEmpty)
    #expect(model.conversations.map(\.unread) == [false, true, false])
    #expect(workspace.listLoads == 1)
  }

  @Test func leavingAConversationMarksItsNewReplyReadWithoutShowingTheDot() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(workspace.sessions, page([session("a", activity: 10)]))
    await model.load()
    await model.open(try #require(model.conversations.first))
    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 11, unread: true)]))
    workspace.server.reply(
      workspace.patch("a"), #"{"session":\#(session("a", activity: 11))}"#)
    await model.load(refreshIdentity: false)
    #expect(workspace.patches("a").isEmpty)

    workspace.server.hold(workspace.patch("a"))
    await model.open(nil)
    let refresh = Task { await model.load(refreshIdentity: false) }
    try await eventually {
      workspace.server.isHeld(workspace.patch("a"))
    }
    #expect(model.conversations.first?.unread == false)
    workspace.server.reply(workspace.sessions, page([session("a", activity: 11)]))
    workspace.server.release(workspace.patch("a"))
    await refresh.value
    #expect(workspace.patches("a") == [["unread": false]])
    #expect(model.conversations.first?.unread == false)

    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 12, unread: true)]))
    await model.open(nil)
    await model.load(refreshIdentity: false)
    #expect(workspace.patches("a").count == 1)
    #expect(model.conversations.first?.unread == true)
  }

  @Test func leavingABrandNewConversationMarksItReadOnceItExists() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(workspace.sessions, page([]))
    await model.load()
    let unsent = try #require(model.newConversation())
    await model.open(unsent)
    await model.open(nil)
    await model.load(refreshIdentity: false)
    #expect(model.error == nil)

    let sent = try #require(model.newConversation())
    await model.open(sent)
    workspace.server.reply(
      workspace.sessions, page([session(sent.id, activity: 12, unread: true)]))
    workspace.server.reply(
      workspace.patch(sent.id),
      #"{"session":\#(session(sent.id, activity: 12))}"#)
    await model.open(nil)
    await model.load(refreshIdentity: false)
    #expect(workspace.patches(sent.id) == [["unread": false]])
    let posts = workspace.server.calls.filter {
      $0.method == "POST"
    }
    #expect(posts.map(\.exact) == [workspace.patch(sent.id)])
  }

  @Test func onlyWebThreadsTrackUnread() {
    #expect(
      Conversation(id: "chat", scopeId: "personal:test", threadRef: "web:test:chat", surface: "web")
        .tracksUnread)
    #expect(
      !Conversation(
        id: "chat", scopeId: "channel:test", threadRef: "ch:C123:1727712000.123456",
        surface: "slack"
      ).tracksUnread)
    #expect(
      !Conversation(id: "chat", scopeId: "personal:test", threadRef: "dm:D456", surface: "slack")
        .tracksUnread)
    #expect(
      !Conversation(id: "chat", scopeId: "personal:test", threadRef: "web:test:chat").tracksUnread)
  }

  @Test func archivedOlderPagesKeepPinnedRowsAcrossARefresh() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    let status = URLQueryItem(name: "status", value: "archived")
    workspace.server.reply(
      workspace.sessions([status]),
      page(
        [session("a", activity: 10, archived: true), session("b", activity: 9, archived: true)],
        next: "9.b"))
    workspace.server.reply(
      workspace.sessions([status, .init(name: "before", value: "9.b")]),
      page([
        session("p", activity: 8, pinned: true, archived: true),
        session("c", activity: 7, archived: true),
      ]))
    await model.select(.archived)
    await model.loadMore()
    #expect(model.conversations.map(\.id) == ["a", "b", "p", "c"])
    await model.load(refreshIdentity: false)
    #expect(model.conversations.map(\.id) == ["a", "b", "p", "c"])
  }

  @Test func pinningMovesARowIntoThePinnedSectionAndUnpinningReturnsIt() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 10), session("b", activity: 9)]))
    await model.load()
    #expect(pinned(model).isEmpty)

    workspace.server.reply(
      workspace.patch("b"),
      #"{"session":\#(session("b", activity: 9, pinned: true))}"#)
    workspace.server.reply(
      workspace.sessions,
      page([session("a", activity: 10)], pinned: [session("b", activity: 9, pinned: true)]))
    await model.update(try #require(model.conversations.last), patch: ["pinned": true])
    #expect(pinned(model) == ["b"])
    #expect(unpinned(model) == ["a"])

    workspace.server.reply(
      workspace.patch("b"), #"{"session":\#(session("b", activity: 9))}"#)
    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 10), session("b", activity: 9)]))
    await model.update(
      try #require(model.conversations.first { $0.id == "b" }), patch: ["pinned": false])
    #expect(pinned(model).isEmpty)
    #expect(unpinned(model) == ["a", "b"])
    #expect(workspace.patches("b") == [["pinned": true], ["pinned": false]])
  }

  @Test func searchAndTheWebFilterAreAnsweredByTheServerAcrossPages() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    let narrowed: [URLQueryItem] = [
      .init(name: "surface", value: "web"), .init(name: "q", value: "invoice"),
    ]
    workspace.server.reply(
      workspace.sessions, page([session("a", activity: 10)], next: "10.a"))
    workspace.server.reply(
      workspace.sessions(narrowed),
      page([session("old", activity: 2, title: "Invoice run")], next: "2.old"))
    workspace.server.reply(
      workspace.sessions(narrowed + [.init(name: "before", value: "2.old")]),
      page([session("older", activity: 1, title: "Invoice draft")]))
    await model.load()
    #expect(model.conversations.map(\.id) == ["a"])

    await model.narrow(search: "invoice", webOnly: true)
    #expect(model.conversations.map(\.id) == ["old"])
    #expect(!model.narrowing)
    await model.loadMore()
    #expect(model.conversations.map(\.id) == ["old", "older"])
    await model.load(refreshIdentity: false)
    #expect(model.conversations.map(\.id) == ["old", "older"])

    await model.narrow(search: "", webOnly: false)
    #expect(model.conversations.map(\.id) == ["a"])
  }

  @Test func leavingAConversationStartedOnThisPhoneMarksItsServerRowRead() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(workspace.sessions, page([]))
    await model.load()
    let started = Conversation(
      id: "local", scopeId: "personal:test", threadRef: "web:test:srv", surface: "web",
      localOnly: true)
    await model.open(started)
    await model.open(nil)

    workspace.server.reply(
      workspace.sessions, page([session("srv", activity: 10, unread: true)]))
    workspace.server.reply(
      workspace.patch("srv"), #"{"session":\#(session("srv", activity: 10))}"#)
    await model.load(refreshIdentity: false)
    #expect(workspace.patches("srv") == [["unread": false]])
  }

  @Test func unsentDraftsLeadTheListAndUntitledRowsNameTheirSurface() async throws {
    let workspace = try workspace()
    let model = workspace.model
    let account = workspace.client.baseURL.absoluteString + "test"
    defer {
      model.signOut()
      DraftStore.removeAccount(account)
    }
    let drafted = Conversation(
      id: "x", scopeId: "personal:test", threadRef: "web:test:x", surface: "web", localOnly: true)
    try DraftStore(account: account, thread: drafted.threadRef).write(
      .init(text: "Unsent idea", conversation: drafted))
    workspace.server.reply(workspace.sessions, page([session("a", activity: 10)]))
    await model.load()
    #expect(model.conversations.map(\.id) == ["x", "a"])
    #expect(model.conversations.map(\.label) == ["Unsent idea", "Web chat"])
    let channel = Conversation(
      id: "c", scopeId: "channel:C1", threadRef: "ch:C1", surface: "slack", channelName: "launch")
    #expect(channel.label == "#launch")
    #expect(
      Conversation(id: "d", scopeId: "personal:test", threadRef: "dm:D1", surface: "slack").label
        == "Direct message")
  }

  @Test func anUnsentDraftStaysOffTheWaitingAndArchivedPages() async throws {
    let workspace = try workspace()
    let model = workspace.model
    let account = workspace.client.baseURL.absoluteString + "test"
    defer {
      model.signOut()
      DraftStore.removeAccount(account)
    }
    let drafted = Conversation(
      id: "x", scopeId: "personal:test", threadRef: "web:test:x", surface: "web", localOnly: true)
    try DraftStore(account: account, thread: drafted.threadRef).write(
      .init(text: "Unsent idea", conversation: drafted))
    workspace.server.reply(workspace.sessions, page([session("a", activity: 10)]))
    workspace.server.reply(
      workspace.sessions([.init(name: "status", value: "waiting")]),
      page([session("w", activity: 9, awaiting: true)]))
    workspace.server.reply(
      workspace.sessions([.init(name: "status", value: "archived")]),
      page([session("z", activity: 8, archived: true)]))
    func rows() -> [String] { model.visibleConversations(search: "", webOnly: false).map(\.id) }

    await model.load()
    #expect(rows() == ["x", "a"])
    await model.select(.waiting)
    #expect(rows() == ["w"])
    await model.select(.archived)
    #expect(rows() == ["z"])
  }

  @Test func aSubagentWaitingOnApprovalMarksItsParentRow() throws {
    let parent = try JSONDecoder().decode(
      Conversation.self,
      from: Data(
        #"{"id":"a","scopeId":"personal:test","threadRef":"web:test:a","subagents":{"running":1,"waiting":1}}"#
          .utf8))
    #expect(parent.needsInput)
    #expect(!Conversation(id: "b", scopeId: "personal:test", threadRef: "web:test:b").needsInput)
  }

  @Test func aProjectListsItsOwnConversationsIncludingPinnedOnes() async throws {
    let workspace = try workspace()
    defer { workspace.model.signOut() }
    let scope = URLQueryItem(name: "scope", value: "personal:test")
    workspace.server.reply(
      workspace.sessions([scope]),
      page(
        [session("b", activity: 10)], pinned: [session("p", activity: 1, pinned: true)],
        next: "10.b"))
    workspace.server.reply(
      workspace.sessions([scope, .init(name: "before", value: "10.b")]),
      page([session("a", activity: 9)], pinned: [session("p", activity: 1, pinned: true)]))
    let projects = ProjectsModel(client: workspace.client, user: "test")
    await projects.loadConversations("personal:test")
    #expect(projects.error == nil)
    #expect(projects.conversations["personal:test"]?.map(\.id) == ["b", "p"])
    #expect(projects.nextCursors["personal:test"] == "10.b")

    await projects.loadConversations("personal:test", more: true)

    #expect(projects.error == nil)
    #expect(projects.conversations["personal:test"]?.map(\.id) == ["b", "a", "p"])
    #expect(projects.nextCursors["personal:test"] == nil)
    #expect(projects.loadingMore == nil)
  }

  @Test func loadMoreReplacesADraftRowWithTheServerRow() async throws {
    let workspace = try workspace()
    let model = workspace.model
    let account = workspace.client.baseURL.absoluteString + "test"
    defer {
      model.signOut()
      DraftStore.removeAccount(account)
    }
    let drafted = Conversation(
      id: "x", scopeId: "personal:test", threadRef: "web:test:x", surface: "web",
      canContinue: true)
    try DraftStore(account: account, thread: drafted.threadRef).write(
      .init(text: "Unsent reply", conversation: drafted))
    workspace.server.reply(
      workspace.sessions,
      page([session("a", activity: 10), session("b", activity: 9)], next: "9.b"))
    workspace.server.reply(
      workspace.sessions([.init(name: "before", value: "9.b")]),
      page([session("x", activity: 8, title: "Server title")]))
    await model.load()
    #expect(model.conversations.first { $0.id == "x" }?.localOnly == true)
    await model.loadMore()
    let row = try #require(model.conversations.first { $0.id == "x" })
    #expect(row.localOnly != true)
    #expect(row.title == "Server title")
    #expect(model.conversations.map(\.id) == ["a", "b", "x"])
  }

  @Test func pullToRefreshReturnsToTheFirstPage() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(
      workspace.sessions,
      page([session("a", activity: 10), session("b", activity: 9)], next: "9.b"))
    workspace.server.reply(
      workspace.sessions([.init(name: "before", value: "9.b")]),
      page([session("c", activity: 8)], next: "8.c"))
    await model.load()
    await model.loadMore()
    #expect(model.conversations.map(\.id) == ["a", "b", "c"])
    #expect(model.nextCursor == "8.c")

    await model.refresh()
    #expect(model.conversations.map(\.id) == ["a", "b"])
    #expect(model.nextCursor == "9.b")
    await model.loadMore()
    #expect(model.conversations.map(\.id) == ["a", "b", "c"])
  }

  @Test func backgroundRefreshKeepsAnOlderRowTiedWithTheFirstPageBoundary() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    workspace.server.reply(
      workspace.sessions,
      page([session("b", activity: 10), session("a", activity: 9)], next: "9.a"))
    workspace.server.reply(
      workspace.sessions([.init(name: "before", value: "9.a")]),
      page([session("tied", activity: 9), session("c", activity: 8)]))
    await model.load()
    await model.loadMore()
    #expect(Set(model.conversations.map(\.id)) == ["b", "a", "tied", "c"])
    await model.load(refreshIdentity: false)
    #expect(Set(model.conversations.map(\.id)) == ["b", "a", "tied", "c"])
  }

  @Test func switchingFiltersClearsAStaleError() async throws {
    let workspace = try workspace()
    let model = workspace.model
    defer { model.signOut() }
    let waiting = workspace.sessions([.init(name: "status", value: "waiting")])
    workspace.server.reply(workspace.sessions, page([session("a", activity: 10)]))
    workspace.server.reply(
      workspace.patch("a"), status: 500, #"{"message":"Pin is unavailable"}"#)
    workspace.server.reply(waiting, page([]))
    await model.load()
    await model.update(try #require(model.conversations.first), patch: ["pinned": true])
    #expect(model.error == "Pin is unavailable")

    workspace.server.hold(waiting)
    let switching = Task { await model.select(.waiting) }
    try await eventually { workspace.server.isHeld(waiting) }
    #expect(model.error == nil)
    #expect(model.showingInitialConversationLoad)
    workspace.server.release(waiting)
    await switching.value
    #expect(model.error == nil)
    #expect(!model.showingInitialConversationLoad)
  }

  @Test func conversationFiltersSeparateWaitingAndArchived() {
    var conversation = Conversation(
      id: "chat", scopeId: "personal:test", threadRef: "web:test", surface: "web", canContinue: true
    )
    #expect(ConversationFilter.active.includes(conversation))
    #expect(!ConversationFilter.waiting.includes(conversation))
    conversation.awaitingInput = true
    #expect(!ConversationFilter.active.includes(conversation))
    #expect(ConversationFilter.waiting.includes(conversation))
    conversation.archived = true
    #expect(!ConversationFilter.active.includes(conversation))
    #expect(!ConversationFilter.waiting.includes(conversation))
    #expect(ConversationFilter.archived.includes(conversation))
  }

  @Test func replyAbilityFollowsTheServer() throws {
    let decode = { (json: String) in
      try JSONDecoder().decode(Conversation.self, from: Data(json.utf8))
    }
    #expect(
      try decode(#"{"id":"a","scopeId":"personal:test","threadRef":"web:a","canContinue":true}"#)
        .canReply)
    #expect(
      try !decode(#"{"id":"b","scopeId":"personal:test","threadRef":"web:b","canContinue":false}"#)
        .canReply)
    #expect(try !decode(#"{"id":"c","scopeId":"personal:test","threadRef":"web:c"}"#).canReply)
    #expect(
      try decode(#"{"id":"d","scopeId":"personal:test","threadRef":"web:d","localOnly":true}"#)
        .canReply)
  }

  @Test func subagentsStayReadOnlyEvenWhenContinuationIsAllowed() {
    var conversation = Conversation(
      id: "agent", scopeId: "personal:test", threadRef: "web:test:agent", surface: "web",
      canContinue: true, parentSessionId: "parent")
    #expect(conversation.isSubagent)
    #expect(!conversation.canReply)
    conversation.localOnly = true
    #expect(!conversation.canReply)
    conversation.parentSessionId = ""
    #expect(!conversation.isSubagent)
    #expect(conversation.canReply)
    conversation.parentSessionId = nil
    #expect(!conversation.isSubagent)
    #expect(conversation.canReply)
  }

  @Test func slackLinksUseWorkspaceAndThreadIdentifiers() {
    var conversation = Conversation(
      id: "chat", scopeId: "channel:test", threadRef: "ch:C123:1727712000.123456")
    #expect(
      conversation.slackURL(workspaceURL: "https://example.slack.com/")?.absoluteString
        == "https://example.slack.com/archives/C123/p1727712000123456")
    conversation = Conversation(id: "chat", scopeId: "personal:test", threadRef: "dm:D456")
    #expect(
      conversation.slackURL(workspaceURL: "https://example.slack.com/messages?old=true#old")?
        .absoluteString
        == "https://example.slack.com/archives/D456")
    for invalid in [
      nil, "http://example.slack.com", "https://example.slack.com.evil.test",
      "https://user:password@example.slack.com",
    ] {
      #expect(conversation.slackURL(workspaceURL: invalid) == nil)
    }
    conversation = Conversation(
      id: "chat", scopeId: "group:test", threadRef: "grp:G789:1727712000.000100", surface: "slack")
    #expect(conversation.isSlackThread)
    #expect(
      conversation.slackURL(workspaceURL: "https://example.slack.com")?.absoluteString
        == "https://example.slack.com/archives/G789/p1727712000000100")
    for reference in ["web:test", "cron:nightly", "ch:C123:1727712000.1:extra"] {
      conversation = Conversation(
        id: "chat", scopeId: "channel:test", threadRef: reference, surface: "slack")
      #expect(!conversation.isSlackThread)
      #expect(conversation.slackURL(workspaceURL: "https://example.slack.com") == nil)
    }
  }

  @Test func forkOriginHasReadableLabel() {
    #expect(Conversation.ForkOrigin(sessionId: "source", title: "  Original  ").label == "Original")
    #expect(
      Conversation.ForkOrigin(sessionId: "source", title: " ").label == "another conversation")
  }

  @Test func navigationOriginIncludesSchemeAndPort() {
    let base = URL(string: "https://qm.example.com")!
    #expect(
      APIClient.sameOrigin(
        URL(string: "https://qm.example.com:443/files")!, base))
    #expect(
      !APIClient.sameOrigin(URL(string: "http://qm.example.com/files")!, base))
    #expect(
      !APIClient.sameOrigin(
        URL(string: "https://qm.example.com:8443/files")!, base))
    #expect(
      !APIClient.sameOrigin(
        URL(string: "https://qm.example.com.evil.test")!, base))
  }

  @Test func browseUsesServerCapabilities() throws {
    let restricted = try JSONDecoder().decode(Identity.self, from: Data(#"{"user":"test"}"#.utf8))
    let full = try JSONDecoder().decode(
      Identity.self, from: Data(#"{"user":"test","permissions":["inbox","loops","admin"]}"#.utf8))
    let basicIDs = Set(WorkspaceDestination.available(to: restricted).map(\.id))
    let fullIDs = Set(WorkspaceDestination.available(to: full).map(\.id))
    #expect(!basicIDs.contains("inbox"))
    #expect(!basicIDs.contains("calendar"))
    #expect(!basicIDs.contains("admin"))
    #expect(fullIDs.isSuperset(of: ["inbox", "calendar", "loops"]))
    #expect(!fullIDs.contains("admin"))
  }
}
