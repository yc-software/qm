import XCTest

@testable import QM

@MainActor
final class WorkspacePickerTests: XCTestCase {
  func defaults() -> UserDefaults {
    let name = "workspace-picker-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    addTeardownBlock { defaults.removePersistentDomain(forName: name) }
    return defaults
  }

  func testWorkspacePersistsCanonicalOriginWithoutCopyingSession() throws {
    let preferences = defaults()
    let original = "https://\(UUID().uuidString.lowercased()).example"
    let model = AppModel(defaults: preferences, configuredURL: original)
    let old = try XCTUnwrap(model.client)
    let generation = old.generation
    try old.saveSession("old-workspace-token")
    let next = "https://\(UUID().uuidString.lowercased()).example"
    try model.selectWorkspace("  \(next):443/ \n")
    XCTAssertEqual(model.client?.baseURL.absoluteString, next)
    XCTAssertFalse(old.hasSession)
    XCTAssertNotEqual(old.generation, generation)
    XCTAssertFalse(model.client?.hasSession ?? true)
    XCTAssertNil(model.identity)
    XCTAssertTrue(model.conversations.isEmpty)
    let restored = AppModel(defaults: preferences, configuredURL: original)
    XCTAssertEqual(restored.client?.baseURL.absoluteString, next)
  }

  func testInvalidAndBusyWorkspaceChangesPreserveCurrentClient() throws {
    let model = AppModel(defaults: defaults(), configuredURL: "https://qm.example")
    let client = model.client
    for raw in [
      "http://remote.example", "https://user:secret@qm.example", "https://qm.example/private",
      "https://qm.example?token=secret", "file:///tmp/test", "https://qm.example#section", "",
    ] {
      XCTAssertThrowsError(try model.selectWorkspace(raw))
      XCTAssertTrue(model.client === client)
    }
    model.loading = true
    XCTAssertThrowsError(try model.selectWorkspace("https://another.example"))
    XCTAssertTrue(model.client === client)
  }

  func testLateMutationDoesNotChangeNewWorkspaceError() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [LateResponseProtocol.self]
    let model = AppModel(
      defaults: defaults(), configuredURL: "https://\(UUID().uuidString).example",
      configuration: configuration)
    let client = try XCTUnwrap(model.client)
    try client.saveSession("current-token")
    let conversation = Conversation(
      id: "session", scopeId: "personal:alice", threadRef: "web:alice:one", surface: "web",
      canContinue: true)
    let update = Task { await model.update(conversation, patch: ["title": "Changed"]) }
    try await LateResponseProtocol.waitForRequest()
    try model.selectWorkspace("https://\(UUID().uuidString).example")
    model.error = "New workspace error"
    LateResponseProtocol.respond()
    await update.value
    XCTAssertEqual(model.error, "New workspace error")
    XCTAssertFalse(model.loading)
  }

  func testChoosingSameWorkspaceDoesNotSignOut() throws {
    let origin = "https://\(UUID().uuidString.lowercased()).example"
    let model = AppModel(defaults: defaults(), configuredURL: origin.uppercased() + ":443/")
    let client = try XCTUnwrap(model.client)
    try client.saveSession("current-token")
    defer { client.signOut() }
    try model.selectWorkspace(origin + "/")
    XCTAssertTrue(model.client === client)
    XCTAssertTrue(client.hasSession)
  }
}
