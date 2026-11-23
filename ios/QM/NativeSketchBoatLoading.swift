import SwiftUI

struct NativeSketchBoatLoading: View {
  static let frameCount = 4
  static let frameDuration: TimeInterval = 0.22
  let label: String

  var body: some View {
    VStack(spacing: 20) {
      NativeAnimationTimeline(minimumInterval: Self.frameDuration) { date, moving in
        Self.frame(moving ? Int(date.timeIntervalSinceReferenceDate / Self.frameDuration) : 0)
          .foregroundStyle(QMTheme.ink)
      }
      .frame(maxWidth: 240)
      .accessibilityHidden(true)
      NativeThinkingLabel(text: label)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 48)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }

  static func frame(_ tick: Int) -> some View {
    Image("SketchBoat-\(tick % frameCount)")
      .renderingMode(.template)
      .resizable()
      .scaledToFit()
  }
}

#Preview("Sketch boat") {
  NativeSketchBoatLoading(label: "Weighing anchor")
    .padding(.horizontal, 24)
    .frame(maxHeight: .infinity)
    .background(QMTheme.paper)
}
