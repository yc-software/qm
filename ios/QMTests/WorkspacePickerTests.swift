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

  private func signedInModel() throws -> AppModel {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ForegroundSyncProtocol.self]
    let model = AppModel(
      defaults: defaults(), configuredURL: "https://\(UUID().uuidString).example",
      configuration: configuration)
    try XCTUnwrap(model.client).saveSession("current-token")
    addTeardownBlock { @MainActor in model.signOut() }
    return model
  }

  private func waitForHeldRequest(_ key: String, count: Int) async throws {
    for _ in 0..<500 {
      if ForegroundSyncProtocol.pending.withLock({ $0[key]?[count] != nil }) { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw QMError.message("The expected held request never arrived: \(key), request \(count)")
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

  func testInvalidWorkspaceChangesPreserveCurrentClientWhileLoading() throws {
    let model = AppModel(defaults: defaults(), configuredURL: "https://qm.example")
    let client = model.client
    model.loading = true
    for raw in [
      "http://remote.example", "https://user:secret@qm.example", "https://qm.example/private",
      "https://qm.example?token=secret", "file:///tmp/test", "https://qm.example#section", "",
    ] {
      XCTAssertThrowsError(try model.selectWorkspace(raw))
      XCTAssertTrue(model.client === client)
      XCTAssertTrue(model.loading)
    }
  }

  func testWorkspaceSwitchDuringRestoreIgnoresLateSuccessAndFailure() async throws {
    for status in [200, 503] {
      let model = try signedInModel()
      let old = try XCTUnwrap(model.client)
      let identityKey = old.url("me").absoluteString
      let listKey = old.url("api/sessions").absoluteString
      ForegroundSyncProtocol.held.withLock {
        $0[identityKey] = 1
        $0[listKey] = 1
      }
      ForegroundSyncProtocol.statusCodes.withLock { $0[identityKey] = [1: status] }
      let restore = Task { await model.restore() }
      defer { restore.cancel() }
      try await waitForHeldRequest(identityKey, count: 1)
      try await waitForHeldRequest(listKey, count: 1)
      XCTAssertTrue(model.loading)

      let next = "https://\(UUID().uuidString.lowercased()).example"
      try model.selectWorkspace(next)
      let current = try XCTUnwrap(model.client)
      XCTAssertFalse(current === old)
      XCTAssertEqual(current.baseURL.absoluteString, next)
      XCTAssertFalse(model.loading)
      XCTAssertFalse(old.hasSession)
      XCTAssertNil(model.identity)
      XCTAssertTrue(model.conversations.isEmpty)
      XCTAssertFalse(model.hasLoadedConversations)
      try current.saveSession("new-workspace-token")
      model.error = "New workspace error"

      ForegroundSyncProtocol.release(identityKey, count: 1)
      ForegroundSyncProtocol.release(listKey, count: 1)
      await restore.value

      XCTAssertTrue(model.client === current)
      XCTAssertTrue(current.hasSession)
      XCTAssertFalse(model.loading)
      XCTAssertNil(model.identity)
      XCTAssertTrue(model.conversations.isEmpty)
      XCTAssertFalse(model.hasLoadedConversations)
      XCTAssertEqual(model.error, "New workspace error")
    }
  }

  func testChoosingSameWorkspaceDuringRestorePreservesSessionAndDraft() async throws {
    let model = try signedInModel()
    let client = try XCTUnwrap(model.client)
    await model.load()
    let identity = try XCTUnwrap(model.identity)
    let generation = client.generation
    let draft = DraftStore(
      account: client.baseURL.absoluteString + identity.user, thread: "web:test:unsent")
    try draft.write(.init(text: "Keep this unsent message"))
    let key = client.url("me").absoluteString
    ForegroundSyncProtocol.held.withLock { $0[key] = 2 }
    let restore = Task { await model.restore() }
    defer { restore.cancel() }
    try await waitForHeldRequest(key, count: 2)
    XCTAssertTrue(model.loading)

    try model.selectWorkspace(client.baseURL.absoluteString.uppercased() + ":443/")

    XCTAssertTrue(model.client === client)
    XCTAssertTrue(client.hasSession)
    XCTAssertEqual(client.generation, generation)
    XCTAssertEqual(model.identity?.user, identity.user)
    XCTAssertTrue(model.loading)
    XCTAssertEqual(draft.read().text, "Keep this unsent message")
    ForegroundSyncProtocol.release(key, count: 2)
    await restore.value
    XCTAssertFalse(model.loading)
    XCTAssertEqual(draft.read().text, "Keep this unsent message")
  }

  func testWorkspaceAddressAddsAHelpfulDefaultScheme() {
    XCTAssertEqual(
      AppModel.workspaceURL("qm.example.com")?.absoluteString, "https://qm.example.com")
    #if DEBUG
      XCTAssertEqual(
        AppModel.workspaceURL("10.0.0.2:8113")?.absoluteString,
        "https://10.0.0.2:8113")
      XCTAssertEqual(
        AppModel.workspaceURL("http://192.168.1.20:8113/")?.absoluteString,
        "http://192.168.1.20:8113")
      XCTAssertNil(AppModel.workspaceURL("http://remote.example:8113"))
      XCTAssertNil(AppModel.workspaceURL("http://fc.example:8113"))
      XCTAssertNil(AppModel.workspaceURL("http://foo.10.0.0.1"))
      XCTAssertNil(AppModel.workspaceURL("http://10.0.0.1.foo"))
    #endif
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
    XCTAssertEqual(model.updatingConversationIDs, [conversation.id])
    try model.selectWorkspace("https://\(UUID().uuidString).example")
    XCTAssertTrue(model.updatingConversationIDs.isEmpty)
    model.error = "New workspace error"
    LateResponseProtocol.respond()
    await update.value
    XCTAssertEqual(model.error, "New workspace error")
    XCTAssertFalse(model.loading)
  }

  func testExpiredMutationAllowsReauthenticationAndKeepsNewMutationPending() async throws {
    let model = try signedInModel()
    let client = try XCTUnwrap(model.client)
    await model.load()
    let conversation = try XCTUnwrap(model.conversations.first)
    XCTAssertTrue(model.hasLoadedConversations)
    let key = client.url("api/sessions/\(conversation.id)").absoluteString
    ForegroundSyncProtocol.held.withLock { $0[key] = 1 }
    let oldUpdate = Task { await model.update(conversation, patch: ["title": "Old title"]) }
    defer { oldUpdate.cancel() }
    try await waitForHeldRequest(key, count: 1)
    XCTAssertEqual(model.updatingConversationIDs, [conversation.id])

    let expiredConversation = Conversation(
      id: "expired", scopeId: "personal:test", threadRef: "web:test:expired", surface: "web")
    let expiredKey = client.url("api/sessions/expired").absoluteString
    ForegroundSyncProtocol.statusCodes.withLock { $0[expiredKey] = [1: 401] }
    await model.update(expiredConversation, patch: ["pinned": true])
    XCTAssertFalse(client.hasSession)
    XCTAssertNil(model.identity)
    XCTAssertTrue(model.conversations.isEmpty)
    XCTAssertFalse(model.hasLoadedConversations)
    XCTAssertTrue(model.updatingConversationIDs.isEmpty)

    try client.saveSession("new-token")
    await model.load()
    XCTAssertTrue(model.hasLoadedConversations)
    ForegroundSyncProtocol.held.withLock { $0[key] = 2 }
    let newUpdate = Task { await model.update(conversation, patch: ["title": "New title"]) }
    defer { newUpdate.cancel() }
    try await waitForHeldRequest(key, count: 2)
    model.resetAfterSessionLoss()
    XCTAssertNotNil(model.identity)
    XCTAssertTrue(model.hasLoadedConversations)
    XCTAssertEqual(model.updatingConversationIDs, [conversation.id])

    ForegroundSyncProtocol.release(key, count: 1)
    await oldUpdate.value
    XCTAssertEqual(model.updatingConversationIDs, [conversation.id])
    XCTAssertNil(model.error)

    ForegroundSyncProtocol.release(key, count: 2)
    await newUpdate.value
    XCTAssertTrue(model.updatingConversationIDs.isEmpty)
    XCTAssertNil(model.error)
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[key] }, 2)

    await model.update(expiredConversation, patch: ["pinned": true])
    XCTAssertEqual(ForegroundSyncProtocol.counts.withLock { $0[expiredKey] }, 2)
    XCTAssertTrue(model.updatingConversationIDs.isEmpty)
    XCTAssertNil(model.error)
  }

  func testSignedOutLoadClearsPendingMutationsAndInitialLoadState() async throws {
    let model = try signedInModel()
    let client = try XCTUnwrap(model.client)
    await model.load()
    let conversation = try XCTUnwrap(model.conversations.first)
    let key = client.url("api/sessions/\(conversation.id)").absoluteString
    ForegroundSyncProtocol.held.withLock { $0[key] = 1 }
    let update = Task { await model.update(conversation, patch: ["pinned": true]) }
    defer { update.cancel() }
    try await waitForHeldRequest(key, count: 1)

    let listKey = client.url("api/sessions").absoluteString
    ForegroundSyncProtocol.statusCodes.withLock { $0[listKey] = [2: 401] }
    await model.load(refreshIdentity: false)
    XCTAssertFalse(client.hasSession)
    XCTAssertNil(model.identity)
    XCTAssertTrue(model.conversations.isEmpty)
    XCTAssertFalse(model.loading)
    XCTAssertFalse(model.hasLoadedConversations)
    XCTAssertTrue(model.updatingConversationIDs.isEmpty)
    XCTAssertNotNil(model.error)

    ForegroundSyncProtocol.release(key, count: 1)
    await update.value
    XCTAssertTrue(model.updatingConversationIDs.isEmpty)
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
