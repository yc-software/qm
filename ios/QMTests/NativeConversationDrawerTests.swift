import SwiftUI
import XCTest

@testable import QM

@MainActor
final class NativeConversationDrawerTests: XCTestCase {
  @Observable final class DrawerState {
    var open = true
    var page = false
  }

  private struct Marker: UIViewRepresentable {
    let view: UIView
    func makeUIView(context: Context) -> UIView { view }
    func updateUIView(_ uiView: UIView, context: Context) {}
  }

  private struct Harness: View {
    @Bindable var state: DrawerState
    let sidebarMarker: UIView
    let detailMarker: UIView
    let model: ChatModel
    let conversations = [
      "Review the launch plan", "Prepare meeting notes", "Summarize customer feedback",
      "Check this week’s priorities", "Draft the project update", "Plan the next release",
    ]

    var body: some View {
      NativeConversationDrawer(
        isOpen: $state.open, hasSelection: true, showsSidebarPage: state.page
      ) {
        NavigationStack {
          List(conversations, id: \.self) { title in
            HStack {
              Text(title).lineLimit(1)
              Spacer()
              Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }
            .frame(minHeight: 44)
            .listRowSeparator(.hidden)
          }
          .listStyle(.plain)
          .navigationTitle("Conversations")
          .navigationBarTitleDisplayMode(.inline)
          .searchable(text: .constant(""), prompt: "Find a conversation")
        }
        .background(Marker(view: sidebarMarker))
      } detail: {
        NavigationStack {
          ChatView(
            model: model, showsConversations: state.open,
            onShowConversations: { state.open = true })
        }
        .background(Marker(view: detailMarker))
      }
      .environment(\.scenePhase, .background)
      .tint(QMTheme.ink)
    }
  }

  func testDrawerKeepsChatMountedAndLeavesAVisibleStrip() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ForegroundSyncProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://drawer.example.test")!, configuration: configuration)
    let model = ChatModel(
      conversation: Conversation(
        id: "drawer", scopeId: "personal:test", threadRef: "web:test:drawer", surface: "web",
        canContinue: true, localOnly: true),
      client: client, user: "test", knownSession: false)
    model.draft = "Please review the plan"
    let state = DrawerState()
    let sidebar = UIView()
    let detail = UIView()
    try await withWindow(
      Harness(state: state, sidebarMarker: sidebar, detailMarker: detail, model: model)
    ) { window in
      let openFrame = detail.convert(detail.bounds, to: window)
      XCTAssertGreaterThan(openFrame.minX, window.bounds.width / 2)
      XCTAssertLessThan(openFrame.minX, window.bounds.width - 44)
      XCTAssertEqual(openFrame.width, window.bounds.width, accuracy: 1)
      let image = capture(window, name: "Conversation drawer")
      for y in [
        window.safeAreaInsets.top / 2, window.bounds.height - window.safeAreaInsets.bottom / 2,
      ] {
        XCTAssertGreaterThan(
          try contrast(image, in: CGRect(x: openFrame.minX, y: y, width: 32, height: 1)), 0.04,
          "The drawer outline must remain visible in the top and bottom safe areas")
      }
      state.open = false
      try await settle(window)
      XCTAssertEqual(detail.convert(detail.bounds, to: window).minX, 0, accuracy: 1)
      XCTAssertTrue(detail.window === window)
      XCTAssertEqual(model.draft, "Please review the plan")
      capture(window, name: "New conversation")
      state.open = true
      state.page = true
      try await settle(window)
      XCTAssertEqual(sidebar.bounds.width, window.bounds.width, accuracy: 1)
      XCTAssertTrue(detail.window === window)
      state.page = false
      try await settle(window)
      XCTAssertEqual(detail.convert(detail.bounds, to: window).minX, openFrame.minX, accuracy: 1)
    }
  }

  func testClosedDrawerCoversSidebarThroughBothSafeAreas() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ForegroundSyncProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://drawer-readonly.example.test")!, configuration: configuration)
    let model = ChatModel(
      conversation: Conversation(
        id: "readonly", scopeId: "channel:test", threadRef: "ch:test:1", surface: "slack",
        canContinue: false),
      client: client, user: "test", knownSession: true)
    let drawer = NativeConversationDrawer(isOpen: .constant(false), hasSelection: true) {
      Color.red.ignoresSafeArea()
    } detail: {
      NavigationStack { ChatView(model: model) }
    }
    .environment(\.scenePhase, .background)
    try await withWindow(drawer) { window in
      let image = capture(window, name: "Closed drawer covers underlying sidebar")
      for y in [1, window.bounds.midY, window.bounds.height - 1] {
        XCTAssertGreaterThan(
          try greenComponent(image, at: CGPoint(x: window.bounds.width / 4, y: y)), 0.95,
          "The sidebar must not show through the conversation or either safe area")
      }
    }
  }

  func testBottomSearchFiltersConversations() async throws {
    let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
    let model = AppModel(defaults: defaults, configuredURL: "https://sidebar.example.test")
    model.identity = Identity(user: "test", companyName: nil, displayName: "Test")
    model.conversations = ["Review the launch plan", "Prepare meeting notes"].enumerated().map {
      Conversation(
        id: "conversation-\($0.offset)", scopeId: "personal:test",
        threadRef: "web:test:\($0.offset)", surface: "web", title: $0.element)
    }
    try await withWindow(
      RootView(model: model).environment(\.scenePhase, .background).tint(QMTheme.ink)
    ) { window in
      let search = try XCTUnwrap(
        descendants(window).compactMap { $0 as? UITextField }.first {
          $0.placeholder == "Find a conversation"
        })
      let collection = try XCTUnwrap(
        descendants(window).compactMap { $0 as? UICollectionView }.first)
      let count = collection.numberOfItems(inSection: 0)
      XCTAssertGreaterThan(
        search.convert(search.bounds, to: window).midY, window.bounds.height * 0.8)
      capture(window, name: "Conversation search and account")
      search.text = "launch"
      search.sendActions(for: .editingChanged)
      try await settle(window)
      XCTAssertEqual(collection.numberOfItems(inSection: 0), count - 1)
      search.text = ""
      search.sendActions(for: .editingChanged)
      try await settle(window)
      XCTAssertEqual(collection.numberOfItems(inSection: 0), count)
      window.overrideUserInterfaceStyle = .dark
      try await settle(window)
      capture(window, name: "Conversation search and account dark")
    }
  }

  func testSearchFindsProjectConversationsAndRowsAreCompact() async throws {
    let defaults = try XCTUnwrap(UserDefaults(suiteName: UUID().uuidString))
    let model = AppModel(defaults: defaults, configuredURL: "https://sidebar.example.test")
    model.identity = Identity(user: "test", companyName: nil, displayName: "Test")
    model.contexts = [
      WorkspaceContext(
        scopeId: "group:billing", kind: "group", name: "Billing migration", isPrivate: nil,
        sessionCount: 1, project: nil)
    ]
    model.conversations = [
      Conversation(
        id: "project", scopeId: "group:billing", threadRef: "web:project", surface: "web",
        title: "Audit handlers"),
      Conversation(
        id: "personal", scopeId: "personal:test", threadRef: "web:personal", surface: "web",
        title: "Prepare notes"),
    ]
    try await withWindow(RootView(model: model).environment(\.scenePhase, .background)) { window in
      let search = try XCTUnwrap(
        descendants(window).compactMap { $0 as? UITextField }.first {
          $0.placeholder == "Find a conversation"
        })
      let collection = try XCTUnwrap(
        descendants(window).compactMap { $0 as? UICollectionView }.first)
      XCTAssertEqual(collection.numberOfItems(inSection: 0), 4)
      let row = try XCTUnwrap(collection.cellForItem(at: IndexPath(item: 1, section: 0)))
      XCTAssertLessThanOrEqual(row.bounds.height, 44)
      search.text = "Billing"
      search.sendActions(for: .editingChanged)
      try await settle(window)
      XCTAssertEqual(collection.numberOfItems(inSection: 0), 2)
      search.text = "no match"
      search.sendActions(for: .editingChanged)
      try await settle(window)
      for _ in 0..<12 where collection.numberOfSections == 0 { try await settle(window) }
      XCTAssertEqual(collection.numberOfItems(inSection: 0), 1)
    }
  }

  func testWorkspaceRendersAllPermittedDestinationsInThreeGroups() async throws {
    let identity = Identity(
      user: "test", companyName: nil, displayName: "Test", permissions: ["inbox", "loops"])
    let client = APIClient(baseURL: URL(string: "https://workspace.example.test")!)
    try await withWindow(NavigationStack { BrowseView(identity: identity, client: client) }) {
      window in
      let collection = try XCTUnwrap(
        descendants(window).compactMap { $0 as? UICollectionView }.first)
      XCTAssertEqual(collection.numberOfSections, 3)
      XCTAssertEqual(
        (0..<collection.numberOfSections).map { collection.numberOfItems(inSection: $0) },
        [5, 3, 5])
      capture(window, name: "Your Workspace")
      window.overrideUserInterfaceStyle = .dark
      try await settle(window)
      capture(window, name: "Your Workspace dark")
    }
  }

  private func withWindow<Content: View>(
    _ content: Content, action: (UIWindow) async throws -> Void
  ) async throws {
    for _ in 0..<100 where UIApplication.shared.connectedScenes.isEmpty {
      try await Task.sleep(for: .milliseconds(50))
    }
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let previous = scene.keyWindow
    let window = UIWindow(windowScene: scene)
    window.overrideUserInterfaceStyle = .light
    window.rootViewController = UIHostingController(rootView: content)
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
      previous?.makeKey()
    }
    try await settle(window)
    try await action(window)
  }

  private func settle(_ window: UIWindow) async throws {
    try await Task.sleep(for: .milliseconds(400))
    window.layoutIfNeeded()
  }

  @discardableResult
  private func capture(_ window: UIWindow, name: String) -> UIImage {
    let image = UIGraphicsImageRenderer(size: window.bounds.size).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    return image
  }

  private func greenComponent(_ image: UIImage, at point: CGPoint) throws -> Double {
    let pixel = try pixels(image, in: CGRect(origin: point, size: CGSize(width: 1, height: 1)))
    return Double(pixel[1]) / 255
  }

  private func contrast(_ image: UIImage, in rect: CGRect) throws -> Double {
    let values = try pixels(image, in: rect)
    let red = stride(from: 0, to: values.count, by: 4).map { Double(values[$0]) / 255 }
    return try XCTUnwrap(red.max()) - XCTUnwrap(red.min())
  }

  private func pixels(_ image: UIImage, in rect: CGRect) throws -> [UInt8] {
    let crop = try XCTUnwrap(
      image.cgImage?.cropping(
        to: rect.applying(CGAffineTransform(scaleX: image.scale, y: image.scale))))
    var pixels = [UInt8](repeating: 0, count: crop.width * crop.height * 4)
    try pixels.withUnsafeMutableBytes { bytes in
      let context = try XCTUnwrap(
        CGContext(
          data: bytes.baseAddress, width: crop.width, height: crop.height, bitsPerComponent: 8,
          bytesPerRow: crop.width * 4, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      context.draw(crop, in: CGRect(x: 0, y: 0, width: crop.width, height: crop.height))
    }
    return pixels
  }

  private func descendants(_ view: UIView) -> [UIView] {
    view.subviews.flatMap { [$0] + descendants($0) }
  }
}
