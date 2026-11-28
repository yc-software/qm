import SwiftUI
import XCTest

@testable import QM

@MainActor
final class DemoWorkspaceTests: XCTestCase {
  private func model() -> AppModel {
    let defaults = UserDefaults(suiteName: "demo-\(UUID().uuidString)")!
    let model = AppModel(defaults: defaults, configuredURL: "https://saved.example")
    addTeardownBlock { @MainActor in model.signOut() }
    return model
  }

  private func chat(_ conversation: Conversation, in model: AppModel, known: Bool) throws
    -> ChatModel
  {
    ChatModel(
      conversation: conversation, client: try XCTUnwrap(model.client), user: DemoWorkspace.user,
      knownSession: known)
  }

  func testExploringTheDemoOpensASampleWorkspaceWithoutSigningIn() async throws {
    let model = model()
    XCTAssertFalse(model.exploringDemo)

    await model.exploreDemo()

    XCTAssertTrue(model.exploringDemo)
    XCTAssertEqual(model.identity?.user, "demo")
    XCTAssertNil(model.error)
    XCTAssertEqual(
      model.conversations.map(\.title),
      [
        "What can I do in this demo?", "Plan the team offsite agenda",
        "Summarize this week's support requests",
      ])
    XCTAssertEqual(model.conversations.filter { $0.pinned == true }.map(\.id), ["demo-offsite"])
  }

  func testASampleConversationShowsItsHistoryAndAnswersWithTheScriptedReply() async throws {
    let model = model()
    await model.exploreDemo()
    let sample = try XCTUnwrap(model.conversations.first { $0.id == "demo-offsite" })
    let chat = try chat(sample, in: model, known: true)
    let restored = await chat.refresh()
    XCTAssertTrue(restored)
    XCTAssertEqual(chat.messages.map(\.role), ["user", "assistant"])
    XCTAssertTrue(chat.messages[1].text.contains("9:30 Arrivals and coffee"))

    chat.draft = "Make it a half day"
    await chat.send()

    XCTAssertNil(chat.error)
    XCTAssertEqual(chat.draft, "")
    XCTAssertEqual(chat.messages.map(\.role), ["user", "assistant", "user", "assistant"])
    XCTAssertEqual(chat.messages[2].text, "Make it a half day")
    XCTAssertEqual(chat.messages[3].text, DemoState.scriptedReply)
    let reopened = try self.chat(sample, in: model, known: true)
    _ = await reopened.refresh()
    XCTAssertEqual(reopened.messages.count, 4)
    chat.pause()
    reopened.pause()
  }

  func testANewDemoConversationIsListedAfterItsFirstMessage() async throws {
    let model = model()
    await model.exploreDemo()
    let chat = try chat(try XCTUnwrap(model.newConversation()), in: model, known: false)
    chat.draft = "Hello from the demo"

    await chat.send()
    await model.load()

    XCTAssertNil(chat.error)
    XCTAssertEqual(chat.messages.last?.text, DemoState.scriptedReply)
    XCTAssertEqual(model.conversations.first?.title, "Hello from the demo")
    XCTAssertEqual(model.conversations.count, 4)
    chat.pause()
  }

  func testDemoConversationsCanBePinnedRenamedAndArchived() async throws {
    let model = model()
    await model.exploreDemo()
    let sample = try XCTUnwrap(model.conversations.first { $0.id == "demo-support" })

    await model.update(sample, patch: ["pinned": true, "title": "Support themes"])
    let renamed = try XCTUnwrap(model.conversations.first { $0.id == "demo-support" })
    XCTAssertEqual(renamed.title, "Support themes")
    XCTAssertEqual(renamed.pinned, true)

    await model.update(renamed, patch: ["archived": true])
    XCTAssertFalse(model.conversations.contains { $0.id == "demo-support" })
    await model.select(.archived)
    XCTAssertEqual(model.conversations.map(\.id), ["demo-support"])
    XCTAssertNil(model.error)
  }

  func testAnUnsentDemoDraftDoesNotCarryIntoTheNextVisitAfterARestart() async throws {
    let first = model()
    await first.exploreDemo()
    let chat = try chat(try XCTUnwrap(first.newConversation()), in: first, known: false)
    chat.draft = "Left unsent"
    chat.saveDraft()
    await first.load()
    XCTAssertEqual(first.conversations.count, 4)

    let relaunched = model()
    await relaunched.exploreDemo()

    XCTAssertEqual(relaunched.conversations.count, 3)
    XCTAssertFalse(relaunched.conversations.contains { $0.localOnly == true })
  }

  func testLeavingTheDemoKeepsDraftsWaitingForTheSavedWorkspace() async throws {
    let model = model()
    let account = "https://saved.example" + "alice"
    let kept = Conversation(
      id: "kept", scopeId: "personal:alice", threadRef: "web:alice:kept", surface: "web",
      localOnly: true)
    try DraftStore(account: account, thread: kept.threadRef).write(
      .init(text: "Finish after signing back in", conversation: kept))
    defer { DraftStore.removeAccount(account) }

    await model.exploreDemo()
    model.signOut()

    XCTAssertEqual(DraftStore.conversations(account).map(\.id), ["kept"])
  }

  func testTheDemoAddressCannotBeChosenAsAWorkspace() {
    XCTAssertNil(AppModel.workspaceURL("demo.qm.invalid"))
    XCTAssertNil(AppModel.workspaceURL("https://demo.qm.invalid"))
    XCTAssertNotNil(AppModel.workspaceURL("qm.example.com"))
  }

  func testTheDemoHomeOffersNewConversationsButNotSearchOrBrowse() async throws {
    let model = model()
    await model.exploreDemo()
    UserDefaults.standard.set(DemoWorkspace.origin.absoluteString, forKey: AIConsent.key)
    defer { UserDefaults.standard.removeObject(forKey: AIConsent.key) }
    for _ in 0..<100 where UIApplication.shared.connectedScenes.isEmpty {
      try await Task.sleep(for: .milliseconds(50))
    }
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previous = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.rootViewController = UIHostingController(rootView: RootView(model: model))
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previous?.makeKey()
    }
    try await Task.sleep(for: .milliseconds(800))
    window.layoutIfNeeded()

    let shown = labels(window)

    XCTAssertTrue(shown.contains("New chat"))
    XCTAssertTrue(shown.contains("Plan the team offsite agenda"))
    XCTAssertFalse(shown.contains("Search"))
    XCTAssertFalse(shown.contains("More"))
  }

  private func labels(_ root: NSObject) -> Set<String> {
    var found = Set([root.accessibilityLabel].compactMap { $0 })
    let children =
      (root.accessibilityElements as? [NSObject] ?? []) + ((root as? UIView)?.subviews ?? [])
    for child in children { found.formUnion(labels(child)) }
    return found
  }

  func testFeaturesTheDemoDoesNotCoverSayTheyNeedAWorkspace() async throws {
    let model = model()
    await model.exploreDemo()
    let keychain = KeychainModel(client: try XCTUnwrap(model.client))

    await keychain.load()

    XCTAssertEqual(
      keychain.error, "This isn’t available in the demo. Connect a workspace to use it.")
    XCTAssertTrue(model.client?.hasSession == true)
  }

  func testLeavingTheDemoReturnsToTheSavedWorkspaceAndTheNextVisitStartsFresh() async throws {
    let model = model()
    await model.exploreDemo()
    let sample = try XCTUnwrap(model.conversations.first)
    await model.update(sample, patch: ["archived": true])
    XCTAssertEqual(model.conversations.count, 2)

    model.signOut()

    XCTAssertFalse(model.exploringDemo)
    XCTAssertNil(model.identity)
    XCTAssertTrue(model.conversations.isEmpty)
    XCTAssertEqual(model.client?.baseURL, URL(string: "https://saved.example"))
    XCTAssertFalse(model.client?.hasSession == true)

    await model.exploreDemo()
    XCTAssertEqual(model.conversations.count, 3)
  }
}
