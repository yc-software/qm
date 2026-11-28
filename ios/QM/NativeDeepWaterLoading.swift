import SwiftUI

/// Launch loader: slow deep-water currents in QM navy behind a small wordmark, no caption.
struct NativeDeepWaterLoading: View {
  let label: LocalizedStringKey
  @Environment(\.colorScheme) private var colorScheme
  @State private var start = Date()

  private static let speed = 0.4
  private static let light: [Color] = [
    Color(red: 1, green: 1, blue: 1),
    Color(red: 0xE6 / 255, green: 0xEE / 255, blue: 0xF6 / 255),
    Color(red: 0xA2 / 255, green: 0xC0 / 255, blue: 0xE2 / 255),
    Color(red: 0x5F / 255, green: 0x84 / 255, blue: 0xAE / 255),
  ]
  private static let dark: [Color] = [
    Color(red: 0x07 / 255, green: 0x0F / 255, blue: 0x18 / 255),
    Color(red: 0x12 / 255, green: 0x24 / 255, blue: 0x3A / 255),
    Color(red: 0x2B / 255, green: 0x4E / 255, blue: 0x73 / 255),
    Color(red: 0xA2 / 255, green: 0xC0 / 255, blue: 0xE2 / 255),
  ]

  var body: some View {
    let palette = colorScheme == .dark ? Self.dark : Self.light
    ZStack {
      NativeAnimationTimeline(minimumInterval: 1.0 / 60) { date, moving in
        let time = Float(7.3 + (moving ? date.timeIntervalSince(start) : 0) * Self.speed)
        Rectangle()
          .visualEffect { content, proxy in
            content.colorEffect(
              ShaderLibrary.qmDeepWater(
                .float2(proxy.size), .float(time),
                .color(palette[0]), .color(palette[1]), .color(palette[2]), .color(palette[3])))
          }
      }
      .ignoresSafeArea()
      Image("QMWordmark")
        .resizable()
        .renderingMode(.template)
        .scaledToFit()
        .frame(width: 72)
        .foregroundStyle(QMTheme.ink)
    }
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }
}

#Preview {
  NativeDeepWaterLoading(label: "Loading your workspace")
}
