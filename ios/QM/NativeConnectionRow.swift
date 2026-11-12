import AVFoundation
import SwiftUI
import WebKit

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

@MainActor @Observable
final class NativeRemoteLogos {
  static let shared = NativeRemoteLogos()
  var images: [URL: UIImage] = [:]
}

private struct NativeRemoteLogo: View {
  let url: URL

  var body: some View {
    if let image = NativeRemoteLogos.shared.images[url] {
      Image(uiImage: image).resizable().scaledToFit()
    } else {
      NativeRemoteLogoPage(url: url)
    }
  }
}

private struct NativeRemoteLogoPage: UIViewRepresentable {
  private static let store = WKWebsiteDataStore.nonPersistent()
  let url: URL

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = Self.store
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.backgroundColor = .clear
    view.scrollView.isScrollEnabled = false
    view.isUserInteractionEnabled = false
    view.navigationDelegate = context.coordinator
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    guard context.coordinator.url != url else { return }
    context.coordinator.url = url
    view.loadHTMLString(
      """
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>html,body{margin:0;height:100%;background:transparent}
      img{width:100%;height:100%;object-fit:contain}</style>
      <img src="\(url.absoluteString)" alt="">
      """, baseURL: nil)
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var url: URL?

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
      guard let url else { return }
      Task {
        do {
          for _ in 0..<20 where NativeRemoteLogos.shared.images[url] == nil && view.window != nil {
            try await Task.sleep(for: .milliseconds(100))
            let image = try await view.takeSnapshot(configuration: nil)
            if let pixels = image.cgImage?.dataProvider?.data as Data?,
              pixels.contains(where: { $0 != 0 })
            {
              NativeRemoteLogos.shared.images[url] = image
            }
          }
        } catch { Log.background.failure("Remote logo snapshot", error) }
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
