import SwiftUI

struct NativeTwinSailsLoading: View {
  let label: LocalizedStringKey

  var body: some View {
    let ink = QMTheme.ink
    VStack(spacing: 24) {
      NativeAnimationTimeline(minimumInterval: 1.0 / 60) { date, moving in
        let time = moving ? date.timeIntervalSinceReferenceDate : 0
        let cycle = time.truncatingRemainder(dividingBy: 3.2) / 3.2
        Canvas { context, size in
          context.scaleBy(x: size.width / 302, y: size.height / 56)
          var horizon = Path()
          horizon.move(to: CGPoint(x: 0, y: 40))
          horizon.addLine(to: CGPoint(x: 84, y: 40))
          horizon.move(to: CGPoint(x: 218, y: 40))
          horizon.addLine(to: CGPoint(x: 302, y: 40))
          context.stroke(horizon, with: .color(ink.opacity(0.19)), lineWidth: 0.75)

          for side in [-1.0, 1.0] {
            let phase = (cycle + (side < 0 ? 0.2 : 0.06))
              .truncatingRemainder(dividingBy: 1)
            let progress = moving ? phase : 0.5
            let x = side < 0 ? 75 - 66 * progress : 227 + 66 * progress
            let opacity =
              moving
              ? Self.smooth(progress / 0.23) * Self.smooth((1 - progress) / 0.23) * 0.9
              : 0.8
            var boat = context
            boat.opacity = opacity
            boat.translateBy(x: x, y: 38 + (moving ? 0.7 * sin(time * .pi / 0.8) : 0))
            boat.rotate(by: .radians(moving ? 0.023 * sin(time * .pi / 0.8 + 0.4) : 0))
            boat.scaleBy(x: side * 0.83, y: 0.83)
            boat.fill(Self.hull, with: .color(ink))
            boat.fill(Self.mainSail, with: .color(ink))
            boat.fill(Self.jib, with: .color(ink.opacity(0.76)))
            boat.stroke(Self.mast, with: .color(ink), lineWidth: 0.8)
          }

          var logo = context.resolve(Image("QMWordmark"))
          logo.shading = .color(ink)
          context.opacity = moving ? 0.73 + 0.27 * (0.5 + 0.5 * cos(cycle * 2 * .pi)) : 1
          context.draw(
            logo,
            in: CGRect(x: 101.5, y: 0, width: 99, height: 99 * logo.size.height / logo.size.width))
        }
      }
      .aspectRatio(302.0 / 56, contentMode: .fit)
      .frame(maxWidth: 302)
      .accessibilityHidden(true)
      Text(label)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 48)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }

  private static func smooth(_ value: Double) -> Double {
    let value = min(1, max(0, value))
    return value * value * (3 - 2 * value)
  }

  private static let hull = Path { path in
    path.move(to: CGPoint(x: -11, y: -3.1))
    path.addLine(to: CGPoint(x: 12, y: -3.1))
    path.addQuadCurve(to: CGPoint(x: 5, y: 1.5), control: CGPoint(x: 8, y: 1.1))
    path.addLine(to: CGPoint(x: -6, y: 1.5))
    path.closeSubpath()
  }

  private static let mainSail = Path { path in
    path.move(to: CGPoint(x: -1.6, y: -24))
    path.addLine(to: CGPoint(x: -1.6, y: -5.9))
    path.addLine(to: CGPoint(x: -10.5, y: -5.9))
    path.addQuadCurve(to: CGPoint(x: -1.6, y: -24), control: CGPoint(x: -8, y: -14.3))
    path.closeSubpath()
  }

  private static let jib = Path { path in
    path.move(to: CGPoint(x: 1, y: -21.2))
    path.addLine(to: CGPoint(x: 1, y: -5.9))
    path.addLine(to: CGPoint(x: 10.7, y: -5.9))
    path.addQuadCurve(to: CGPoint(x: 1, y: -21.2), control: CGPoint(x: 5, y: -12.8))
    path.closeSubpath()
  }

  private static let mast = Path { path in
    path.move(to: CGPoint(x: -0.2, y: -24.5))
    path.addLine(to: CGPoint(x: -0.2, y: -2.4))
  }
}

#Preview("Twin sails") {
  NativeTwinSailsLoading(label: "Loading your workspace")
    .padding(.horizontal, 24)
    .frame(maxHeight: .infinity)
    .background(QMTheme.paper)
}
