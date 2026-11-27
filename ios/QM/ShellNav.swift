import SwiftUI
import UIKit

/// Small icon-only nav under the main screen, in the style of the ChatGPT app.
enum ShellNavItem {
  case conversations, new, voice, more
}

struct ShellNav: View {
  /// Room kept above the home indicator: a 52pt glass island plus a little air.
  static let height: CGFloat = 60

  // Read here rather than in RootView, so opening or closing the list re-renders only the nav.
  @Binding var showingConversations: Bool
  let showingMore: Bool
  let showingVoice: Bool
  let blankChat: Bool
  let waiting: Int
  let onNew: () -> Void
  let onVoice: () -> Void
  let onMore: () -> Void

  private var selected: ShellNavItem {
    showingConversations
      ? .conversations
      : showingVoice ? .voice : showingMore ? .more : blankChat ? .new : .conversations
  }

  var body: some View {
    // A floating Liquid Glass island; content scrolls freely behind it.
    HStack(spacing: 2) {
      item(.conversations, icon: "line.3.horizontal", label: "Conversations")
      item(.new, icon: "square.and.pencil", label: "New chat")
      item(.voice, icon: "waveform", label: "Talk to QM")
      item(.more, icon: "square.grid.2x2", selectedIcon: "square.grid.2x2.fill", label: "More")
    }
    .padding(4)
    .modifier(GlassPill())
    .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
    .frame(maxWidth: .infinity)
    .padding(.top, 6)
    .padding(.bottom, 2)
  }

  private func item(
    _ target: ShellNavItem, icon: String, selectedIcon: String? = nil, label: String
  ) -> some View {
    let isSelected = selected == target
    return Button {
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      switch target {
      case .conversations: showingConversations = true
      case .new: onNew()
      case .voice: onVoice()
      case .more: onMore()
      }
    } label: {
      Image(systemName: isSelected ? selectedIcon ?? icon : icon)
        .font(.system(size: 19, weight: .medium))
        .frame(width: 60, height: 44)
        .background {
          if isSelected { Capsule().fill(QMTheme.ink.opacity(0.1)) }
        }
        .overlay(alignment: .topTrailing) {
          if target == .conversations, waiting > 0 {
            Circle().fill(QMTheme.unread).frame(width: 8, height: 8).offset(x: -12, y: 6)
          }
        }
        .contentShape(Rectangle())
    }
    .buttonStyle(NavPressStyle())
    .foregroundStyle(QMTheme.ink.opacity(isSelected ? 1 : 0.6))
    .accessibilityLabel(label)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  /// The keyboard's own duration as a smooth curve, so the nav and the room it leaves move
  /// with the keyboard.
  static func keyboardAnimation(_ note: Notification) -> Animation {
    let duration =
      (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
    return .smooth(duration: max(duration, 0.25))
  }
}

/// Keeps scrolling content clear of the bottom nav, which floats above every screen.
struct NavRoom: ViewModifier {
  /// The main chat pads its own composer instead (see `shellNavRoom`).
  var composer = false
  @Environment(\.shellNavHeight) private var height
  func body(content: Content) -> some View {
    if composer {
      content.environment(\.shellNavRoom, height)
    } else {
      content.safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: height) }
    }
  }
}

extension EnvironmentValues {
  /// Room the bottom nav takes right now: zero while it hides for the keyboard or signed out.
  @Entry var shellNavHeight: CGFloat = 0
  /// Room the composer keeps under itself for the bottom nav. A safe-area inset on the
  /// conversation's NavigationStack doesn't reach the composer, so it pads itself instead.
  @Entry var shellNavRoom: CGFloat = 0
}

/// The app shell around the list and main screen: the bottom nav, the launch loader, keyboard
/// tracking and restore-on-foreground, so RootView keeps to the conversation list.
struct ShellChrome: ViewModifier {
  let model: AppModel
  @Binding var showingConversations: Bool
  @Binding var showingMore: Bool
  @Binding var showingVoice: Bool
  let blankChat: Bool
  let onNew: () -> Void
  @State private var keyboardUp = false
  @Environment(\.scenePhase) private var phase

  private var showsNav: Bool { model.identity != nil && model.client != nil && !keyboardUp }

  /// Signed in and waiting for the workspace: the launch loader shows.
  private var launching: Bool {
    model.identity == nil && model.client?.hasSession == true && model.error == nil
  }

  /// The workspace to connect to whenever the app comes to the front. Launch opens on a
  /// conversation rather than the list, so the list's own sync can't be what connects.
  private var foregroundURL: URL? { phase == .active ? model.client?.baseURL : nil }

  func body(content: Content) -> some View {
    content
      .environment(\.shellNavHeight, showsNav ? ShellNav.height : 0)
      // One nav for the whole app, drawn above both the list and the main screen so it stays
      // put while they slide underneath it. A TabView can't: its bar belongs to one tab's
      // content, and the list here is a drawer layered over every section, not a tab.
      .overlay(alignment: .bottom) {
        if showsNav {
          ShellNav(
            showingConversations: $showingConversations, showingMore: showingMore,
            showingVoice: showingVoice, blankChat: blankChat,
            waiting: model.conversations.filter(ConversationFilter.waiting.includes).count,
            onNew: onNew,
            onVoice: {
              showingVoice = true
              showingMore = false
              showingConversations = false
            }
          ) {
            showingMore = true
            showingVoice = false
            showingConversations = false
          }
          .transition(.opacity.combined(with: .offset(y: 24)))
        }
      }
      // The launch loader sits above everything and fades away once the workspace arrives, so
      // the app is revealed underneath it instead of cutting in.
      .overlay {
        if launching {
          NativeDeepWaterLoading(label: "Loading your workspace")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(QMTheme.paper.ignoresSafeArea())
            .transition(
              .opacity.combined(with: .scale(scale: 1.04)).animation(.smooth(duration: 0.7)))
        }
      }
      // Hide and restore the nav in step with the keyboard, so the room it leaves (and anything
      // centred in that room, like the new-chat greeting) glides instead of jumping.
      .onReceive(
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
      ) { note in withAnimation(ShellNav.keyboardAnimation(note)) { keyboardUp = true } }
      .onReceive(
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
      ) { note in withAnimation(ShellNav.keyboardAnimation(note)) { keyboardUp = false } }
      .task(id: foregroundURL) {
        if foregroundURL != nil, model.identity == nil { await model.restore() }
      }
  }
}

/// Shrinks on touch-down so a tap registers immediately.
private struct NavPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.88 : 1)
      .opacity(configuration.isPressed ? 0.7 : 1)
      .animation(.snappy(duration: 0.12), value: configuration.isPressed)
  }
}

/// Liquid Glass capsule on iOS 26, material before it.
struct GlassPill: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content
        .foregroundStyle(QMTheme.ink)
        .glassEffect(.regular.interactive(), in: .capsule)
    } else {
      content
        .foregroundStyle(QMTheme.ink)
        .background(.thinMaterial, in: Capsule())
    }
  }
}
