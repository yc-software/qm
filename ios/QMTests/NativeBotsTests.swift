import XCTest

@testable import QM

final class NativeBotsTests: XCTestCase {
  private let server = NativeRouteProtocol.Server()

  @MainActor
  func testLoadsBotsAndTreatsDisabledFlagAsHidden() async throws {
    let model = BotsModel(
      client: server.client([
        "GET /api/personas": [
          .init(
            body:
              #"{"personas":[{"id":"b1","name":"Reviewer","description":"Reads PRs","role":"read","icon":{"kind":"emoji","value":"🦉"},"createdBy":"x","version":1}]}"#
          ),
          .init(status: 404, body: #"{"error":"personas_disabled"}"#),
          .init(status: 404, body: #"{"error":"not_found"}"#),
        ]
      ]),
      user: "test")
    await model.load()
    XCTAssertTrue(model.enabled)
    XCTAssertEqual(model.bots.map(\.name), ["Reviewer"])
    XCTAssertEqual(model.bots.first?.emoji, "🦉")
    await model.load()
    XCTAssertFalse(model.enabled)
    XCTAssertTrue(model.bots.isEmpty)
    XCTAssertNil(model.error)
    await model.load()
    XCTAssertNotNil(model.error)
  }

  @MainActor
  func testStartingAChatCreatesAPersonalSessionAndAssignsTheBot() async throws {
    let model = BotsModel(
      client: server.client([
        "POST /api/sessions": [
          .init(
            body: #"{"session":{"id":"s1","scopeId":"personal:test","threadRef":"web:test:s1"}}"#)
        ],
        "PUT /api/sessions/s1/persona": [.init(body: #"{"persona":{"sessionModelId":"m1"}}"#)],
      ]),
      user: "test")
    let bot = Bot(id: "b1", name: "Reviewer", description: "", role: .read)
    let started = await model.startChat(with: bot)
    let chat = try XCTUnwrap(started)
    XCTAssertEqual(chat.conversation.personaId, "b1")
    XCTAssertEqual(chat.modelId, "m1")
    XCTAssertEqual(
      server.calls(to: "POST /api/sessions").first?.json["scopeId"] as? String, "personal:test")
    XCTAssertEqual(
      server.calls(to: "PUT /api/sessions/s1/persona").first?.json["personaId"] as? String, "b1")
    XCTAssertEqual(model.chatModel(chat).effectiveRuntime?.modelId, "m1")
  }

  func testBotsTileAppearsOnlyWhenBotsAreOn() {
    let identity = Identity(user: "test", companyName: nil, displayName: nil)
    XCTAssertFalse(WorkspaceDestination.available(to: identity).contains { $0.id == "bots" })
    XCTAssertEqual(
      WorkspaceDestination.sections(for: identity, bots: true).first?.destinations.map(\.id),
      ["voice.html", "contexts", "bots", "files"])
  }
}
