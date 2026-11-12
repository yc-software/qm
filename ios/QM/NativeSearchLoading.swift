import SwiftUI

@MainActor @Observable
final class NativePeopleSearchModel {
  let client: APIClient
  var query = "" {
    didSet {
      guard query != oldValue else { return }
      loader.cancel()
      matches = []
      error = nil
      completed = false
      loader.loading = query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
    }
  }
  private(set) var matches: [DirectoryPerson] = []
  private(set) var error: String?
  private(set) var completed = false
  private let loader = LoadGuard()
  var searching: Bool { loader.loading }

  init(client: APIClient) { self.client = client }

  func cancel() { loader.cancel() }

  func search() async {
    guard !Task.isCancelled else { return }
    let query = self.query
    matches = []
    error = nil
    completed = false
    guard query.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else {
      loader.cancel()
      return
    }
    await loader.run {
      try await Task.sleep(for: .milliseconds(250))
      return try await client.fetch(
        "api/directory/resolve", query: [.init(name: "q", value: query)]) as DirectoryMatches
    } apply: { result in
      matches = result.matches
      completed = true
    } failed: {
      error = $0.localizedDescription
    }
  }
}

struct NativePeopleSearchLoading: View {
  let label: String
  @ScaledMetric(relativeTo: .body) private var avatarSize: CGFloat = 32

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(label).font(.subheadline).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 18) {
        ForEach(0..<3) { row in
          HStack(spacing: 12) {
            Circle().fill(QMTheme.ink.opacity(0.10))
              .frame(width: avatarSize, height: avatarSize)
            VStack(alignment: .leading, spacing: 8) {
              NativeSkeletonLine(fraction: [0.64, 0.49, 0.72][row])
              NativeSkeletonLine(fraction: [0.82, 0.68, 0.56][row], height: 7)
                .opacity(0.6)
            }
          }
          .modifier(NativeLoadingPulse(phaseOffset: Double(row) * 0.15))
        }
      }.accessibilityHidden(true)
    }
    .padding(.vertical, 8)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }
}

struct NativeCatalogLoading: View {
  let label: String
  @ScaledMetric(relativeTo: .headline) private var titleHeight: CGFloat = 13
  @ScaledMetric(relativeTo: .caption) private var detailHeight: CGFloat = 8
  @ScaledMetric(relativeTo: .body) private var actionHeight: CGFloat = 10

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(label).font(.subheadline).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 0) {
        ForEach(0..<2) { row in
          VStack(alignment: .leading, spacing: 8) {
            NativeSkeletonLine(fraction: row == 0 ? 0.43 : 0.58, height: titleHeight)
            NativeSkeletonLine(fraction: 0.90, height: detailHeight)
            NativeSkeletonLine(fraction: row == 0 ? 0.62 : 0.77, height: detailHeight)
            NativeSkeletonLine(fraction: 0.25, height: actionHeight)
              .padding(.top, 8)
          }
          .padding(.vertical, 12)
          .modifier(NativeLoadingPulse(phaseOffset: Double(row) * 0.18))
          if row == 0 { Divider() }
        }
      }.accessibilityHidden(true)
    }
    .padding(.vertical, 6)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }
}

struct NativeAppCollectionLoading: View {
  let label: String
  @ScaledMetric(relativeTo: .headline) private var titleHeight: CGFloat = 13
  @ScaledMetric(relativeTo: .caption) private var detailHeight: CGFloat = 8

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(label).font(.subheadline).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 0) {
        ForEach(0..<3) { row in
          VStack(alignment: .leading, spacing: 6) {
            NativeSkeletonLine(fraction: [0.52, 0.67, 0.43][row], height: titleHeight)
            NativeSkeletonLine(fraction: 0.68, height: detailHeight).opacity(0.6)
          }
          .padding(.vertical, 12)
          .modifier(NativeLoadingPulse(phaseOffset: Double(row) * 0.15))
          if row < 2 { Divider() }
        }
      }.accessibilityHidden(true)
    }
    .padding(.vertical, 8)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }
}
