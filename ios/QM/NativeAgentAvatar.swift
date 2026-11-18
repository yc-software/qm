import CryptoKit
import SwiftUI

struct NativeAgentAvatar: View {
  let sessionID: String
  var returned = false

  nonisolated static func variant(for sessionID: String) -> Int {
    Int(Data(SHA256.hash(data: Data(sessionID.utf8))).first ?? 0)
  }

  var body: some View {
    let variant = Self.variant(for: sessionID)
    let tint: Color = [.teal, .indigo, .orange, .pink, .blue, .purple][variant % 6]
    Canvas { context, size in
      context.scaleBy(x: size.width / 48, y: size.height / 48)
      var outline = Path()
      switch variant % 3 {
      case 0:
        outline.move(to: CGPoint(x: 8, y: 23))
        outline.addQuadCurve(to: CGPoint(x: 16, y: 12), control: CGPoint(x: 7, y: 10))
        outline.addLine(to: CGPoint(x: 20, y: 6))
        outline.addLine(to: CGPoint(x: 25, y: 12))
        outline.addQuadCurve(to: CGPoint(x: 40, y: 25), control: CGPoint(x: 40, y: 10))
        outline.addQuadCurve(to: CGPoint(x: 25, y: 40), control: CGPoint(x: 42, y: 40))
        outline.addQuadCurve(to: CGPoint(x: 8, y: 23), control: CGPoint(x: 8, y: 41))
        outline.closeSubpath()
      case 1:
        outline.addRoundedRect(
          in: CGRect(x: 8, y: 9, width: 32, height: 32),
          cornerSize: CGSize(width: 11, height: 11))
      default:
        outline.move(to: CGPoint(x: 24, y: 7))
        outline.addQuadCurve(to: CGPoint(x: 32, y: 14), control: CGPoint(x: 28, y: 7))
        outline.addLine(to: CGPoint(x: 40, y: 29))
        outline.addQuadCurve(to: CGPoint(x: 34, y: 40), control: CGPoint(x: 45, y: 40))
        outline.addLine(to: CGPoint(x: 14, y: 40))
        outline.addQuadCurve(to: CGPoint(x: 8, y: 29), control: CGPoint(x: 3, y: 40))
        outline.addLine(to: CGPoint(x: 17, y: 14))
        outline.addQuadCurve(to: CGPoint(x: 24, y: 7), control: CGPoint(x: 20, y: 7))
        outline.closeSubpath()
      }
      context.fill(outline, with: .color(tint.opacity(0.16)))
      context.stroke(outline, with: .color(QMTheme.ink), lineWidth: 1.5)
      var face = Path()
      for x: CGFloat in [18, 30] {
        if returned {
          face.move(to: CGPoint(x: x - 3, y: 25))
          face.addQuadCurve(to: CGPoint(x: x + 3, y: 25), control: CGPoint(x: x, y: 20))
        } else if variant / 3 % 3 == 0 {
          face.addEllipse(in: CGRect(x: x - 2.5, y: 21, width: 5, height: 5))
        } else {
          face.move(to: CGPoint(x: x, y: 22))
          face.addLine(to: CGPoint(x: x + (variant / 3 % 3 == 1 ? 0 : 2), y: 25))
        }
      }
      face.move(to: CGPoint(x: 21, y: 31))
      if returned {
        face.addQuadCurve(to: CGPoint(x: 27, y: 31), control: CGPoint(x: 24, y: 35))
      } else {
        face.addLine(to: CGPoint(x: 27, y: 31))
      }
      context.stroke(
        face, with: .color(QMTheme.ink), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
    }
    .accessibilityHidden(true)
  }
}
