import SwiftUI

struct NativeLoadingPulse: ViewModifier {
  var active = true
  var phaseOffset: Double = 0
  var minimumOpacity: Double = 0.4
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @State private var visible = false

  func body(content: Content) -> some View {
    let moving = active && visible && !reduceMotion && scenePhase == .active
    TimelineView(.animation(minimumInterval: 1.0 / 24, paused: !moving)) { context in
      let phase = (context.date.timeIntervalSinceReferenceDate + phaseOffset) / 1.8
      let opacity = minimumOpacity + (1 - minimumOpacity) * (1 + sin(phase * 2 * .pi)) / 2
      content.opacity(moving ? opacity : 1)
    }
    .onAppear { visible = true }
    .onDisappear { visible = false }
  }
}

struct NativeLoadingRail: View {
  var tint: Color?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @State private var visible = false

  var body: some View {
    let moving = visible && !reduceMotion && scenePhase == .active
    TimelineView(.animation(minimumInterval: 1.0 / 24, paused: !moving)) { context in
      GeometryReader { geometry in
        let phase = moving ? (1 + sin(context.date.timeIntervalSinceReferenceDate * 2.2)) / 2 : 0.5
        let color = tint ?? QMTheme.ink
        ZStack(alignment: .leading) {
          Capsule().fill(color.opacity(0.08))
          Capsule().fill(color.opacity(0.4))
            .frame(width: geometry.size.width * 0.24)
            .offset(x: geometry.size.width * 0.76 * phase)
        }
      }
    }
    .frame(height: 3)
    .clipped()
    .accessibilityHidden(true)
    .onAppear { visible = true }
    .onDisappear { visible = false }
  }
}

struct NativeSkeletonLine: View {
  var fraction: CGFloat = 1
  var height: CGFloat = 10

  var body: some View {
    GeometryReader { geometry in
      RoundedRectangle(cornerRadius: 3)
        .fill(QMTheme.ink.opacity(0.14))
        .frame(width: geometry.size.width * fraction)
    }
    .frame(height: height)
    .accessibilityHidden(true)
  }
}

struct NativeConversationListLoading: View {
  @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 48

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(0..<6) { index in
        NativeSkeletonLine(fraction: [0.72, 0.56, 0.8, 0.64, 0.48, 0.7][index], height: 14)
          .frame(height: rowHeight)
          .modifier(NativeLoadingPulse(phaseOffset: Double(index) * 0.18))
      }
    }
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading conversations")
  }
}
