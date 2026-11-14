import ImageIO
import MarkdownUI
import SwiftUI

enum MarkdownImageResource {
  static func path(_ url: URL, baseURL: URL, files: [DeliveredFile] = []) -> String? {
    guard let file = FilePreviewResource.attachment(url, baseURL: baseURL, files: files) else {
      return nil
    }
    return FilePreviewResource.path(for: file.artifactId)
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
  @State private var showingPreview = false
  @State private var seen = false

  nonisolated init(url: URL?, client: APIClient, files: [DeliveredFile]) {
    self.url = url
    self.client = client
    self.files = files
  }

  private var file: DeliveredFile? {
    url.flatMap { FilePreviewResource.attachment($0, baseURL: client.baseURL, files: files) }
  }

  @ViewBuilder
  private var content: some View {
    Group {
      if let image {
        Image(image, scale: 1, label: Text("Image")).resizable()
          .aspectRatio(CGFloat(image.width) / CGFloat(image.height), contentMode: .fit)
      } else if let error {
        VStack(alignment: .leading, spacing: 8) {
          Label(error, systemImage: "photo.badge.exclamationmark").font(.callout)
          Text("Open image").font(.callout.weight(.medium)).underline()
        }
      } else if let url,
        MarkdownImageResource.path(url, baseURL: client.baseURL, files: files) != nil
      {
        NativeMarkdownImageLoading()
      } else if let url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        Link(destination: url) { Label("Open external image", systemImage: "photo") }
      } else {
        Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
      }
    }
  }

  var body: some View {
    Group {
      if let file {
        Button {
          showingPreview = true
        } label: {
          content.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(file.name?.isEmpty == false ? file.name! : "image")")
        .accessibilityHint(error ?? "View the full image")
      } else {
        content
      }
    }
    .sheet(isPresented: $showingPreview) {
      if let file { FilePreviewSheet(file: file, client: client) }
    }
    .onScrollVisibilityChange(threshold: 0.01) { visible in
      if visible { seen = true }
    }
    .task(id: seen ? url : nil) {
      guard seen, let url,
        let path = MarkdownImageResource.path(url, baseURL: client.baseURL, files: files)
      else {
        return
      }
      image = nil
      error = nil
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

struct NativeMarkdownImageLoading: View {
  var body: some View {
    ZStack(alignment: .bottomLeading) {
      Color.clear.aspectRatio(1.6, contentMode: .fit)
      Text("Loading image…").font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true).padding(16)
    }
    .frame(maxWidth: .infinity)
    .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 8))
    .overlay {
      RoundedRectangle(cornerRadius: 8).strokeBorder(QMTheme.border, lineWidth: 1)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading image")
  }
}

struct WorkspaceInlineImages: InlineImageProvider {
  let client: APIClient
  let files: [DeliveredFile]
  var dark = false
  var pointSize: CGFloat = 16

  func image(with url: URL, label: String) async throws -> Image {
    if url.scheme == GitHubLinkMark.scheme {
      return GitHubLinkMark.image(dark: dark, pointSize: pointSize)
    }
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
