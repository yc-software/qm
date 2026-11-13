import XCTest

@testable import QM

@MainActor
final class NativeConversationSidebarTests: XCTestCase {
  func testPinnedRowsAppearOnceAndProjectNamesComeFromContexts() {
    let project = WorkspaceProject(
      id: "project", name: "Billing migration", ownerId: "sample", memberIds: [],
      scopeId: "group:project", members: [], slackChannel: nil)
    let context = WorkspaceContext(
      scopeId: project.scopeId, kind: "group", name: "Old name", isPrivate: nil,
      sessionCount: 3, project: project)
    let conversations = [
      Conversation(id: "pinned", scopeId: project.scopeId, threadRef: "web:pinned", pinned: true),
      Conversation(id: "first", scopeId: project.scopeId, threadRef: "web:first"),
      Conversation(id: "personal", scopeId: "personal:sample", threadRef: "web:personal"),
      Conversation(id: "second", scopeId: project.scopeId, threadRef: "web:second"),
    ]
    let sections = NativeConversationSection.grouped(
      conversations, contexts: [context.scopeId: context])
    XCTAssertEqual(sections.map(\.title), ["Pinned", "Billing migration", "Personal"])
    XCTAssertEqual(sections.map(\.icon), ["pin", "folder", "person"])
    XCTAssertEqual(
      sections.map { $0.conversations.map(\.id) }, [["pinned"], ["first", "second"], ["personal"]])
  }

  func testConversationsRemainAccessibleWhenContextMetadataIsUnavailable() {
    let conversations = [
      Conversation(
        id: "channel", scopeId: "channel:launch", threadRef: "web:channel",
        channelName: "launch-team"),
      Conversation(id: "group", scopeId: "group:team", threadRef: "web:group"),
      Conversation(id: "project", scopeId: "project:work", threadRef: "web:project"),
    ]
    let sections = NativeConversationSection.grouped(conversations, contexts: [:])
    XCTAssertEqual(
      sections.map(\.title), ["launch-team", "Group conversation", "Project conversation"])
    XCTAssertEqual(sections.map(\.icon), ["number", "person.2", "folder"])
    XCTAssertEqual(sections.flatMap(\.conversations).map(\.id), conversations.map(\.id))
    XCTAssertTrue(NativeConversationSection.grouped([], contexts: [:]).isEmpty)
  }

  func testContextFailureRetriesWithoutLosingConversationsAndStopsPollingAfterSuccess() async throws
  {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ForegroundSyncProtocol.self]
    let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
    let model = AppModel(
      defaults: defaults, configuredURL: "https://\(UUID().uuidString).example",
      configuration: configuration)
    let client = try XCTUnwrap(model.client)
    try client.saveSession("test")
    defer { model.signOut() }
    let key = client.url("api/contexts").absoluteString
    ForegroundSyncProtocol.statusCodes.withLock { $0[key] = [1: 503] }
    await model.load()
    XCTAssertFalse(model.conversations.isEmpty)
    XCTAssertNotNil(model.error)
    await model.load(refreshIdentity: false)
    XCTAssertNil(model.error)
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[key] }, 2)
    await model.load(refreshIdentity: false)
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[key] }, 2)
    await model.load()
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[key] }, 3)
  }
}

extension NativeConversationSidebarTests {
  func testSlackGroupMembersFlowFromContextResponseToSidebar() throws {
    let contexts = try JSONDecoder().decode(
      WorkspaceContexts.self,
      from: Data(
        #"""
        {"contexts":[
          {"scopeId":"group:team","kind":"group","name":"Alex, Sam","sessionCount":1,"groupMembers":[{"principalId":"alex","displayName":"Alex","avatarUrl":"https://example.test/alex.png"},{"principalId":"sam","displayName":"Sam"}]},
          {"scopeId":"channel:launch","kind":"channel","name":"Launch","sessionCount":1}
        ]}
        """#.utf8)
    ).contexts
    let conversations = contexts.map {
      Conversation(id: $0.scopeId, scopeId: $0.scopeId, threadRef: "slack", surface: "slack")
    }
    let sections = NativeConversationSection.grouped(
      conversations, contexts: Dictionary(uniqueKeysWithValues: contexts.map { ($0.scopeId, $0) }))
    XCTAssertEqual(sections[0].members.map(\.principalId), ["alex", "sam"])
    XCTAssertEqual(sections[0].members[0].avatarUrl, "https://example.test/alex.png")
    XCTAssertNil(sections[0].members[1].avatarUrl)
    XCTAssertTrue(sections[1].members.isEmpty)
    let members = sections[0].members
    XCTAssertEqual(NativeGroupAvatars(members: members).shown.count, 2)
    let large = NativeGroupAvatars(
      members: members + [
        .init(principalId: "taylor", displayName: "Taylor", avatarUrl: nil),
        .init(principalId: "morgan", displayName: "Morgan", avatarUrl: nil),
      ])
    XCTAssertEqual(large.shown.map(\.principalId), ["alex", "sam"])
    XCTAssertEqual(large.remaining, 2)
  }
}

extension NativeConversationSidebarTests {
  func testFolderPreviewKeepsSelectedConversationAndSearchResultsVisible() {
    let conversations = (1...8).map {
      Conversation(id: "chat-\($0)", scopeId: "group:project", threadRef: "web:\($0)")
    }
    let section = NativeConversationSection(
      id: "scope:group:project", title: "Project", icon: "folder", conversations: conversations)
    XCTAssertTrue(section.hasPreview)
    XCTAssertEqual(
      section.preview(showAll: false, searching: false, selectedID: nil).map(\.id),
      Array(conversations.prefix(5)).map(\.id))
    XCTAssertEqual(
      section.preview(showAll: false, searching: false, selectedID: "chat-8").map(\.id),
      ["chat-1", "chat-2", "chat-3", "chat-4", "chat-5", "chat-8"])
    XCTAssertEqual(section.preview(showAll: true, searching: false, selectedID: nil), conversations)
    XCTAssertEqual(section.preview(showAll: false, searching: true, selectedID: nil), conversations)
    let pinned = NativeConversationSection(
      id: "pinned", title: "Pinned", icon: "pin", conversations: conversations)
    XCTAssertFalse(pinned.hasPreview)
    let personal = NativeConversationSection(
      id: "personal", title: "Personal", icon: "person",
      conversations: (1...8).map {
        Conversation(id: "\($0)", scopeId: "personal:sample", threadRef: "web:\($0)")
      })
    XCTAssertFalse(personal.hasPreview)
  }
}
