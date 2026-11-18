import SwiftUI
import XCTest

@testable import QM

@MainActor
final class ConversationReadTests: XCTestCase {
  func testLeavingAChatOpenedOutsideTheListMarksItsUnreadRowReadOnTheNextLoad() async throws {
    let server = NativeRouteProtocol.Server()
    let suite = "conversation-read-\(server.host)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let model = AppModel(
      defaults: defaults, configuredURL: "https://\(server.host)",
      configuration: server.configuration)
    let client = try XCTUnwrap(model.client)
    try client.saveSession("token")
    defer { model.signOut() }
    let row =
      #"{"id":"a","scopeId":"personal:test","threadRef":"web:test:a","surface":"web","canContinue":true,"unread":true}"#
    let patch = "POST /api/sessions/a?"
    server.reply("GET /me", #"{"user":"test"}"#)
    server.reply("GET /api/contexts", #"{"contexts":[]}"#)
    server.reply("GET /api/sessions?", #"{"sessions":[\#(row)]}"#)
    server.reply(patch, #"{"session":\#(row)}"#)
    await model.load()
    let conversation = try XCTUnwrap(model.conversations.first)

    let controller = UIHostingController(
      rootView: AnyView(
        NavigationStack {
          ChatView(
            model: ChatModel(
              conversation: conversation, client: client, user: "test", knownSession: true))
        }
        .environment(model)))
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previousWindow = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previousWindow?.makeKey()
    }
    controller.view.layoutIfNeeded()
    XCTAssertTrue(patches(to: patch, server).isEmpty)

    controller.rootView = AnyView(EmptyView())
    for _ in 0..<200 where patches(to: patch, server).isEmpty {
      try await Task.sleep(for: .milliseconds(10))
      await model.load(refreshIdentity: false)
    }
    XCTAssertEqual(patches(to: patch, server), [["unread": false]])
    XCTAssertEqual(model.conversations.first?.unread, false)
  }

  private func patches(to route: String, _ server: NativeRouteProtocol.Server) -> [[String: Bool]] {
    server.calls.filter { $0.exact == route }.compactMap {
      try? JSONSerialization.jsonObject(with: $0.body) as? [String: Bool]
    }
  }
}
