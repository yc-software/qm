import ImageIO
import MarkdownUI
import SwiftUI

enum MarkdownImageResource {
  static func path(_ url: URL, baseURL: URL, files: [DeliveredFile] = []) -> String? {
    if let file = FilePreviewResource.attachment(url, files: files) {
      return FilePreviewResource.path(for: file.artifactId)
    }
    guard url.scheme == baseURL.scheme, url.host == baseURL.host,
      url.port == baseURL.port, url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil
    else { return nil }
    let pieces = url.path.split(separator: "/")
    guard pieces.count == 4, pieces[0] == "api", pieces[1] == "files",
      pieces[3] == "content",
      let path = FilePreviewResource.path(for: String(pieces[2])), "/" + path == url.path
    else { return nil }
    return path
  }

  static func thumbnail(_ data: Data, maximumPixels: Int) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 100_000, height <= 100_000,
      Double(width) * Double(height) <= 100_000_000,
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: maximumPixels,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary)
    else { throw QMError.message("This image cannot be previewed inline.") }
    return image
  }
}

struct WorkspaceMarkdownImages: MarkdownUI.ImageProvider {
  let client: APIClient
  let files: [DeliveredFile]

  func makeImage(url: URL?) -> some View {
    WorkspaceMarkdownImage(url: url, client: client, files: files)
  }
}

private struct WorkspaceMarkdownImage: View {
  let url: URL?
  let client: APIClient
  let files: [DeliveredFile]
  @State private var image: CGImage?
  @State private var error: String?

  nonisolated init(url: URL?, client: APIClient, files: [DeliveredFile]) {
    self.url = url
    self.client = client
    self.files = files
  }

  var body: some View {
    Group {
      if let image {
        Image(image, scale: 1, label: Text("Image")).resizable().scaledToFit()
      } else if let error {
        Label(error, systemImage: "photo.badge.exclamationmark").font(.callout)
      } else if let url,
        MarkdownImageResource.path(url, baseURL: client.baseURL, files: files) != nil
      {
        ProgressView("Loading image…")
      } else if let url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        Link(destination: url) { Label("Open external image", systemImage: "photo") }
      } else {
        Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
      }
    }
    .task(id: url) {
      image = nil
      error = nil
      guard let url,
        let path = MarkdownImageResource.path(url, baseURL: client.baseURL, files: files)
      else {
        return
      }
      do {
        let data = try await client.imageData(path)
        let decoded = try MarkdownImageResource.thumbnail(data, maximumPixels: 1200)
        try Task.checkCancellation()
        image = decoded
      } catch {
        if !Task.isCancelled {
          if case QMError.rejected = error {
            self.error = "This image is unavailable or you no longer have access."
          } else {
            self.error = error.localizedDescription
          }
        }
      }
    }
  }
}

struct WorkspaceInlineImages: InlineImageProvider {
  let client: APIClient
  let files: [DeliveredFile]

  func image(with url: URL, label: String) async throws -> Image {
    guard let path = MarkdownImageResource.path(url, baseURL: client.baseURL, files: files) else {
      return Image(systemName: "photo")
    }
    do {
      let data = try await client.imageData(path)
      let image = try MarkdownImageResource.thumbnail(data, maximumPixels: 128)
      try Task.checkCancellation()
      return Image(image, scale: 1, label: Text(label))
    } catch {
      return Image(systemName: "photo.badge.exclamationmark")
    }
  }
}
