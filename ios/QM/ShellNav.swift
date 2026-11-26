import SwiftUI
import UIKit

/// Small icon-only nav under the main screen, in the style of the ChatGPT app.
enum ShellNavItem {
  case conversations, new, more
}

struct ShellNav: View {
  /// Room kept above the home indicator: a 52pt glass island plus a little air.
  static let height: CGFloat = 60

  // Read here rather than in RootView, so opening or closing the list re-renders only the nav.
  @Binding var showingConversations: Bool
  let showingMore: Bool
  let blankChat: Bool
  let waiting: Int
  let onNew: () -> Void
  let onMore: () -> Void

  private var selected: ShellNavItem {
    showingConversations ? .conversations : showingMore ? .more : blankChat ? .new : .conversations
  }

  var body: some View {
    // A floating Liquid Glass island; content scrolls freely behind it.
    HStack(spacing: 2) {
      item(.conversations, icon: "line.3.horizontal", label: "Conversations")
      item(.new, icon: "square.and.pencil", label: "New chat")
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
  let height: CGFloat
  func body(content: Content) -> some View {
    content.safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: height) }
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
