import SwiftUI

struct NativeChatHistoryPlaceholder: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      NativeChatMessagePlaceholder(isUser: true)
        .modifier(NativeLoadingPulse(phaseOffset: 0))
      NativeChatMessagePlaceholder(isUser: false)
        .modifier(NativeLoadingPulse(phaseOffset: 0.45))
      NativeChatMessagePlaceholder(isUser: true)
        .modifier(NativeLoadingPulse(phaseOffset: 0.9))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 12)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading conversation history")
  }
}

private struct NativeChatMessagePlaceholder: View {
  let isUser: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      NativeSkeletonLine(fraction: 0.76)
      NativeSkeletonLine(fraction: isUser ? 0.43 : 0.58)
    }
    .frame(maxWidth: .infinity, minHeight: isUser ? 40 : 56, alignment: .leading)
    .padding(isUser ? 14 : 0)
    .background(isUser ? QMTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 20))
    .padding(.leading, isUser ? 28 : 0)
    .accessibilityHidden(true)
  }
}

struct NativeChatUploadStatus: View {
  let filename: String
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(spacing: 5) {
        Image(systemName: "doc").font(.system(size: 18))
        Capsule().fill(QMTheme.ink).frame(width: 20, height: 2)
          .modifier(NativeLoadingPulse())
      }
      .frame(width: 24, height: 36)
      .accessibilityHidden(true)
      if dynamicTypeSize.isAccessibilitySize {
        Text("Uploading \(filename)")
          .font(.caption).lineLimit(2).truncationMode(.middle)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        VStack(alignment: .leading, spacing: 4) {
          Text(filename).font(.footnote.weight(.medium))
            .lineLimit(1).truncationMode(.middle)
          Text("Uploading…").font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Uploading \(filename)")
  }
}
