import SwiftUI
import UIKit

struct NativeConversationDrawer<Sidebar: View, Detail: View>: View {
  @Binding var isOpen: Bool
  let hasSelection: Bool
  var showsSidebarPage = false
  @ViewBuilder let sidebar: () -> Sidebar
  @ViewBuilder let detail: () -> Detail
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var motion = DrawerMotion()

  var body: some View {
    let revision = UUID()
    GeometryReader { geometry in
      let sidebarWidth = min(geometry.size.width * 0.8, 400)
      let drawer = hasSelection && !showsSidebarPage
      ZStack(alignment: .leading) {
        sidebar()
          .frame(width: drawer ? sidebarWidth : geometry.size.width)
          .allowsHitTesting(!hasSelection || isOpen || showsSidebarPage)
          .accessibilityHidden(hasSelection && !isOpen && !showsSidebarPage)
        if hasSelection {
          DrawerCardLayer(
            motion: motion, width: sidebarWidth,
            content: DrawerContent(revision: revision) {
              detail()
                .frame(width: geometry.size.width)
                .background(QMTheme.paper.ignoresSafeArea(.container, edges: .vertical))
                .disabled(isOpen || showsSidebarPage)
                .accessibilityHidden(isOpen || showsSidebarPage)
                .overlay {
                  if isOpen {
                    Button {
                      isOpen = false
                    } label: {
                      Color.clear.contentShape(Rectangle())
                        .ignoresSafeArea(.container, edges: .vertical)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Return to conversation")
                    .accessibilityIdentifier("closeConversationDrawer")
                  }
                }
            }
          )
          .gesture(drawerPan(width: sidebarWidth, isEnabled: drawer))
          .opacity(showsSidebarPage ? 0 : 1)
          .allowsHitTesting(!showsSidebarPage)
        }
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
      .mask { Rectangle().ignoresSafeArea(.container, edges: .vertical) }
    }
    .background(QMTheme.paper.ignoresSafeArea())
    .sensoryFeedback(trigger: isOpen) { _, _ in
      hasSelection && !showsSidebarPage ? .impact(flexibility: .soft, intensity: 0.7) : nil
    }
    .onAppear { motion.position = isOpen ? 1 : 0 }
    .onChange(of: isOpen) { _, open in
      guard motion.dragStart == nil else { return }
      withAnimation(reduceMotion ? nil : .smooth(duration: 0.32)) {
        motion.position = open ? 1 : 0
      }
    }
  }

  private func drawerPan(width: CGFloat, isEnabled: Bool) -> DrawerPan {
    DrawerPan(
      opening: !isOpen,
      isEnabled: isEnabled,
      onBegan: { motion.dragStart = motion.position },
      onChanged: { motion.track($0, width: width) },
      onEnded: { settle(translation: $0, velocity: $1, width: width) }
    )
  }

  // Carry the fling's speed into the spring so release doesn't jolt or stall.
  private func settle(translation: CGFloat, velocity: CGFloat, width: CGFloat) {
    let projected = motion.position + velocity * 0.15 / width
    let open = projected > 0.5
    let target: CGFloat = open ? 1 : 0
    let remaining = target - motion.position
    let relative = abs(remaining) > 0.001 ? (velocity / width) / remaining : 0
    withAnimation(
      reduceMotion
        ? nil
        : .interpolatingSpring(
          duration: 0.38, bounce: 0, initialVelocity: min(max(relative, 0), 12))
    ) {
      motion.position = target
    }
    motion.dragStart = nil
    if isOpen != open { isOpen = open }
  }
}

@Observable
final class DrawerMotion {
  var position: CGFloat = 0
  @ObservationIgnored var dragStart: CGFloat?

  func track(_ translation: CGFloat, width: CGFloat) {
    let raw = (dragStart ?? position) + translation / width
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) { position = min(max(raw, 0), 1) }
  }
}

// Drag frames change only `DrawerMotion`, which re-renders `DrawerCardLayer` alone; this
// wrapper keeps that from re-rendering the transcript. A new `revision` per drawer body
// lets real content changes through.
private struct DrawerContent<Content: View>: View, Equatable {
  let revision: UUID
  @ViewBuilder let content: () -> Content

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.revision == rhs.revision }

  var body: some View { content() }
}

private struct DrawerCardLayer<Content: View>: View {
  let motion: DrawerMotion
  let width: CGFloat
  let content: DrawerContent<Content>

  var body: some View {
    let reveal = motion.position
    let edge = min(reveal * 4, 1)
    let shape = RoundedRectangle(cornerRadius: 32 * edge, style: .continuous)
    content.equatable()
      .overlay {
        QMTheme.paper.opacity(0.3 * reveal)
          .ignoresSafeArea(.container, edges: .vertical)
          .allowsHitTesting(false)
      }
      .mask { shape.ignoresSafeArea(.container, edges: .vertical) }
      .overlay {
        shape.strokeBorder(QMTheme.border.opacity(edge))
          .ignoresSafeArea(.container, edges: .vertical)
          .allowsHitTesting(false)
      }
      .background {
        shape.fill(QMTheme.paper)
          .shadow(color: .black.opacity(0.08 * edge), radius: 16, x: -4)
          .ignoresSafeArea(.container, edges: .vertical)
      }
      .offset(x: motion.position * width)
  }
}

struct DrawerPan: UIGestureRecognizerRepresentable {
  let opening: Bool
  let isEnabled: Bool
  let onBegan: () -> Void
  let onChanged: (CGFloat) -> Void
  let onEnded: (CGFloat, CGFloat) -> Void

  func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

  func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
    let pan = UIPanGestureRecognizer()
    pan.delegate = context.coordinator
    pan.isEnabled = isEnabled
    context.coordinator.opening = opening
    return pan
  }

  func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
    recognizer.isEnabled = isEnabled
    context.coordinator.opening = opening
  }

  func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
    let translation = recognizer.translation(in: recognizer.view).x
    let velocity = recognizer.velocity(in: recognizer.view).x
    switch recognizer.state {
    case .began:
      onBegan()
      onChanged(translation)
    case .changed: onChanged(translation)
    case .ended: onEnded(translation, velocity)
    case .cancelled, .failed: onEnded(translation, 0)
    default: break
    }
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var opening = true

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
      guard let pan = recognizer as? UIPanGestureRecognizer, let view = pan.view else {
        return false
      }
      let velocity = pan.velocity(in: view)
      let sideways = opening ? velocity.x : -velocity.x
      guard sideways > 0, sideways > abs(velocity.y) * 1.2 else { return false }
      return !opening || !touchesScrolledContent(pan, in: view)
    }

    func gestureRecognizer(
      _ recognizer: UIGestureRecognizer,
      shouldBeRequiredToFailBy other: UIGestureRecognizer
    ) -> Bool { other.view is UIScrollView && other is UIPanGestureRecognizer }

    private func touchesScrolledContent(_ pan: UIPanGestureRecognizer, in view: UIView) -> Bool {
      var current = view.hitTest(pan.location(in: view), with: nil)
      while let candidate = current, candidate !== view {
        if let scroll = candidate as? UIScrollView,
          scroll.contentSize.width > scroll.bounds.width + 1,
          scroll.contentOffset.x > -scroll.adjustedContentInset.left + 1
        {
          return true
        }
        current = candidate.superview
      }
      return false
    }
  }
}
