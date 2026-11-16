import SwiftUI

struct NativeConnectionLoading: View {
  let status: String

  var body: some View {
    VStack(spacing: 16) {
      HStack(alignment: .top, spacing: 18) {
        VStack(spacing: 8) {
          Image(systemName: "bubble.left.and.bubble.right")
            .font(.system(size: 24)).frame(width: 52, height: 52)
            .background(QMTheme.paper, in: RoundedRectangle(cornerRadius: 8))
          Text("QM").font(.caption.weight(.semibold))
        }
        Image(systemName: "link")
          .font(.system(size: 24)).foregroundStyle(.teal)
          .modifier(NativeLoadingPulse())
          .frame(width: 40, height: 52)
        VStack(spacing: 8) {
          NativeServiceLogo(service: "openai", size: 28)
            .frame(width: 52, height: 52)
            .background(QMTheme.paper, in: RoundedRectangle(cornerRadius: 8))
          Text("ChatGPT").font(.caption.weight(.semibold))
        }
      }
      .accessibilityHidden(true)
      Text("Connect ChatGPT").font(.headline)
      Text(status).font(.subheadline).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .multilineTextAlignment(.center)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }
}
