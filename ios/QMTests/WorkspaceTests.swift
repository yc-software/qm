import Foundation
import Testing

@testable import QM

@MainActor
struct WorkspaceTests {
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
      id: "chat", scopeId: "personal:test", threadRef: "web:test", surface: "web", canContinue: true
    )
    #expect(conversation.slackURL(workspaceURL: "https://example.slack.com") == nil)
  }

  @Test func forkHistoryUsesBoundaryAndLeavesPendingMessagesCurrent() throws {
    let conversation = try JSONDecoder().decode(
      Conversation.self,
      from: Data(
        #"{"id":"fork","scopeId":"personal:test","threadRef":"web:fork","surface":"web","canContinue":true,"forkedFrom":{"sessionId":"source","title":"  Original  "},"forkBoundarySeq":5}"#
          .utf8))
    #expect(conversation.forkedFrom?.label == "Original")
    #expect(
      conversation.isInherited(ChatMessage(id: "old", role: "user", text: "Old", sequence: 5)))
    #expect(
      !conversation.isInherited(ChatMessage(id: "new", role: "user", text: "New", sequence: 6)))
    #expect(
      !conversation.isInherited(ChatMessage(id: "pending", role: "assistant", text: "Pending")))
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
