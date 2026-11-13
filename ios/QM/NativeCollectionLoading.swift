import SwiftUI

struct NativeLoopCollectionLoading: View {
  @ScaledMetric(relativeTo: .headline) private var titleHeight: CGFloat = 16
  @ScaledMetric(relativeTo: .subheadline) private var textHeight: CGFloat = 12

  var body: some View {
    Text("Loading loops").font(.subheadline).foregroundStyle(.secondary)
      .listRowSeparator(.hidden)
    ForEach(0..<4) { index in
      HStack {
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Image(systemName: "repeat").frame(width: 24, height: 24)
            NativeSkeletonLine(
              fraction: index.isMultiple(of: 2) ? 0.62 : 0.48, height: titleHeight)
          }
          NativeSkeletonLine(fraction: 0.96, height: textHeight)
          NativeSkeletonLine(fraction: 0.78, height: textHeight)
          NativeSkeletonLine(fraction: 0.36, height: textHeight * 0.75)
        }.padding(.vertical, 6)
        Spacer(minLength: 8)
        Image(systemName: "chevron.right").font(.caption)
      }
      .redacted(reason: .placeholder)
      .modifier(NativeLoadingPulse(phaseOffset: Double(index) * 0.22))
      .accessibilityHidden(true)
      .allowsHitTesting(false)
    }
  }
}

struct NativeCollectionLoading: View {
  let label: LocalizedStringKey
  var symbol: String? = nil
  var rows = 4
  @ScaledMetric(relativeTo: .headline) private var titleHeight: CGFloat = 16
  @ScaledMetric(relativeTo: .subheadline) private var textHeight: CGFloat = 12

  var body: some View {
    Text(label).font(.subheadline).foregroundStyle(.secondary)
      .listRowSeparator(.hidden)
    ForEach(0..<rows, id: \.self) { index in
      HStack(alignment: .top, spacing: 14) {
        if let symbol {
          Image(systemName: symbol).font(.title3).frame(width: 28)
        }
        VStack(alignment: .leading, spacing: 9) {
          NativeSkeletonLine(fraction: index.isMultiple(of: 2) ? 0.62 : 0.48, height: titleHeight)
          NativeSkeletonLine(fraction: index.isMultiple(of: 2) ? 0.9 : 0.78, height: textHeight)
          NativeSkeletonLine(fraction: 0.36, height: textHeight * 0.75)
        }
      }
      .padding(.vertical, 10)
      .redacted(reason: .placeholder)
      .modifier(NativeLoadingPulse(phaseOffset: Double(index) * 0.22))
      .accessibilityHidden(true)
      .allowsHitTesting(false)
    }
  }
}

struct NativeParagraphLoading: View {
  let label: LocalizedStringKey
  var pages = 1

  var body: some View {
    Text(label).font(.subheadline).foregroundStyle(.secondary)
      .listRowSeparator(.hidden)
    ForEach(0..<pages, id: \.self) { page in
      VStack(alignment: .leading, spacing: 22) {
        NativeSkeletonLine(fraction: 0.42, height: 18)
        ForEach(0..<3) { paragraph in
          VStack(alignment: .leading, spacing: 10) {
            ForEach(0..<3) { line in
              NativeSkeletonLine(fraction: line == 2 ? 0.58 : (line == 0 ? 0.96 : 0.86))
                .modifier(
                  NativeLoadingPulse(phaseOffset: Double(page + paragraph + line) * 0.22))
            }
          }
        }
      }
      .padding(.vertical, 16)
      .accessibilityHidden(true)
      .allowsHitTesting(false)
    }
  }
}

struct NativeCollectionRefreshHeader: View {
  let label: LocalizedStringKey

  var body: some View {
    VStack(spacing: 0) {
      NativeLoadingRail()
    }
    .padding(.horizontal, 20).padding(.vertical, 8)
    .background(QMTheme.paper)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .allowsHitTesting(false)
  }
}

struct NativeCollectionRefresh: ViewModifier {
  let active: Bool
  let label: LocalizedStringKey

  func body(content: Content) -> some View {
    content.safeAreaInset(edge: .top, spacing: 0) {
      if active { NativeCollectionRefreshHeader(label: label) }
    }
  }
}
