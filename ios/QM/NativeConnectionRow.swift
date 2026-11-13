import AVFoundation
import SVGView
import SwiftUI

struct NativeServiceLogo: View {
  let service: String
  var remote: URL? = nil
  var size: CGFloat = 28
  private static var marks: [String: UIImage] = [:]

  nonisolated static func key(_ service: String) -> String {
    service.lowercased().replacingOccurrences(of: "_", with: "")
      .replacingOccurrences(of: "-", with: "")
  }

  static func mark(_ service: String, size: CGFloat) -> UIImage? {
    let name = "Service-\(key(service))"
    if let drawn = marks["\(name) \(size)"] { return drawn }
    guard let asset = UIImage(named: name) else { return nil }
    let bounds = CGRect(x: 0, y: 0, width: size, height: size)
    let drawn = UIGraphicsImageRenderer(bounds: bounds).image { _ in
      asset.draw(in: AVMakeRect(aspectRatio: asset.size, insideRect: bounds))
    }.withRenderingMode(.alwaysTemplate)
    marks["\(name) \(size)"] = drawn
    return drawn
  }

  var body: some View {
    Group {
      if let mark = Self.mark(service, size: size) {
        Image(uiImage: mark)
      } else if let remote {
        NativeRemoteLogo(url: remote)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

private struct NativeRemoteLogo: View {
  let url: URL
  @State private var vector: SVGView?
  @State private var bitmap: UIImage?

  var body: some View {
    Group {
      if let bitmap { Image(uiImage: bitmap).resizable().scaledToFit() } else { vector }
    }
    .task(id: url) {
      do {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let response = response as? HTTPURLResponse else {
          throw URLError(.badServerResponse)
        }
        guard response.statusCode == 200 else {
          throw QMError.message(
            "App logo HTTP \(response.statusCode) from \(url.host() ?? "unknown host")")
        }
        try Task.checkCancellation()
        if let loaded = UIImage(data: data) {
          bitmap = loaded
          vector = nil
        } else {
          let loaded = SVGView(data: data)
          guard loaded.svg != nil else {
            throw QMError.message("The app logo is not a supported image.")
          }
          vector = loaded
          bitmap = nil
        }
      } catch {
        Log.background.failure("App logo", error)
      }
    }
  }
}

extension View {
  func primaryConnectionAction() -> some View {
    buttonStyle(.borderedProminent).foregroundStyle(QMTheme.paper)
  }
}

struct NativeServiceLabel<Title: View>: View {
  let service: String
  @ViewBuilder let title: Title

  var body: some View {
    if NativeServiceLogo.mark(service, size: 20) == nil {
      title
    } else {
      Label {
        title
      } icon: {
        NativeServiceLogo(service: service, size: 20)
      }
    }
  }
}

extension NativeServiceLabel where Title == Text {
  init(title: String, service: String) {
    self.init(service: service) { Text(title) }
  }
}

struct NativeConnectionRow<Actions: View>: View {
  let service: String
  var logo: URL? = nil
  let name: String
  let detail: String
  var needsAttention = false
  @ViewBuilder let actions: Actions

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      NativeServiceLogo(service: service, remote: logo)
      VStack(alignment: .leading, spacing: 6) {
        Text(name).font(.headline)
        Text(detail).font(.caption)
          .foregroundStyle(
            needsAttention ? AnyShapeStyle(QMTheme.warning) : AnyShapeStyle(.secondary)
          )
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 10) { actions }
          .buttonStyle(.bordered).controlSize(.small)
          .padding(.top, 2)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 6)
  }
}
