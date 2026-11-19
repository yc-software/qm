import SwiftUI
import UIKit

extension EnvironmentValues {
  // True while the drawer animates to a state it was told to take, such as closing over a
  // conversation just chosen from the list.
  @Entry var conversationDrawerSettling = false
}

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
    let settling = isOpen != motion.restingOpen
    GeometryReader { geometry in
      let sidebarWidth = min(geometry.size.width * 0.8, 400)
      let drawer = hasSelection && !showsSidebarPage
      ZStack(alignment: .leading) {
        DrawerSidebarLayer(
          motion: motion, width: sidebarWidth, isDrawer: drawer,
          content: DrawerContent(revision: revision) {
            sidebar()
              .frame(width: drawer ? sidebarWidth : geometry.size.width)
          }
        )
          .allowsHitTesting(!hasSelection || isOpen || showsSidebarPage)
          .accessibilityHidden(hasSelection && !isOpen && !showsSidebarPage)
        if hasSelection {
          DrawerCardLayer(
            motion: motion, width: sidebarWidth,
            content: DrawerContent(revision: revision) {
              detail()
                .environment(\.conversationDrawerSettling, settling)
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
    .onAppear {
      motion.position = isOpen ? 1 : 0
      motion.restingOpen = isOpen
    }
    .onChange(of: isOpen) { _, open in
      // A drag commits `isOpen` only after its spring lands, so the card is already there.
      let target: CGFloat = open ? 1 : 0
      guard motion.dragStart == nil, motion.position != target else { return }
      withAnimation(reduceMotion ? nil : .smooth(duration: 0.32)) {
        motion.position = target
      } completion: {
        if motion.position == target { motion.restingOpen = open }
      }
    }
  }

  private func drawerPan(width: CGFloat, isEnabled: Bool) -> DrawerPan {
    DrawerPan(
      // Read the card's live position: `isOpen` lags until a released drag lands.
      opening: { [motion] in motion.position < 0.5 },
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
    motion.dragStart = nil
    withAnimation(
      reduceMotion
        ? nil
        : .interpolatingSpring(
          duration: 0.38, bounce: 0, initialVelocity: min(max(relative, 0), 12))
    ) {
      motion.position = target
    } completion: {
      // Flipping `isOpen` re-renders the conversation; doing it mid-spring drops frames.
      guard motion.dragStart == nil, motion.position == target else { return }
      motion.restingOpen = open
      if isOpen != open { isOpen = open }
    }
  }
}

@Observable
final class DrawerMotion {
  var position: CGFloat = 0
  // The state the card last came to rest in; only the drawer body reads it, once per settle.
  var restingOpen = false
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
    // A fixed radius, hidden under the display's own corners while closed, keeps the clip
    // path constant during a drag; an animated radius re-rasterizes the mask every frame.
    let shape = RoundedRectangle(cornerRadius: reveal > 0 ? 32 : 0, style: .continuous)
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
      .background(alignment: .leading) {
        // A gradient strip stands in for a blurred shadow, which is costly to redraw per frame.
        LinearGradient(
          colors: [.clear, .black.opacity(0.07 * edge)], startPoint: .leading,
          endPoint: .trailing
        )
        .frame(width: 18)
        .offset(x: -14)
        .ignoresSafeArea(.container, edges: .vertical)
        .allowsHitTesting(false)
      }
      .offset(x: motion.position * width)
      // Drags cross halfway under the finger; flings and taps cross when the target is set.
      .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.6), trigger: reveal > 0.5)
  }
}

// The list trails the card a little, so the two read as one surface.
private struct DrawerSidebarLayer<Content: View>: View {
  let motion: DrawerMotion
  let width: CGFloat
  let isDrawer: Bool
  let content: DrawerContent<Content>

  var body: some View {
    content.equatable()
      .offset(x: isDrawer ? -(1 - motion.position) * width * 0.25 : 0)
  }
}

struct DrawerPan: UIGestureRecognizerRepresentable {
  let opening: @MainActor () -> Bool
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
      // Start from the finger, not from the distance it travelled while the scroll view
      // decided; otherwise the card leaps on the first frame.
      recognizer.setTranslation(.zero, in: recognizer.view)
      onBegan()
    case .changed: onChanged(translation)
    case .ended: onEnded(translation, velocity)
    case .cancelled, .failed: onEnded(translation, 0)
    default: break
    }
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var opening: @MainActor () -> Bool = { true }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
      guard let pan = recognizer as? UIPanGestureRecognizer, let view = pan.view else {
        return false
      }
      let velocity = pan.velocity(in: view)
      let opening = opening()
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
