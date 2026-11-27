import CryptoKit
import ImageIO
import UniformTypeIdentifiers
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
    try thumbnail(CGImageSourceCreateWithData(data as CFData, nil), maximumPixels: maximumPixels)
  }

  static func thumbnail(contentsOf url: URL, maximumPixels: Int) throws -> CGImage {
    try thumbnail(CGImageSourceCreateWithURL(url as CFURL, nil), maximumPixels: maximumPixels)
  }

  private static func thumbnail(_ source: CGImageSource?, maximumPixels: Int) throws -> CGImage {
    guard let source,
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

struct WorkspaceMarkdownImage: View {
  let url: URL?
  let client: APIClient
  let files: [DeliveredFile]
  let maximumPixels: Int
  let fill: Bool
  @State private var image: CGImage?
  @State private var error: String?
  @State private var showingPreview = false
  @State private var seen = false

  nonisolated init(
    url: URL?, client: APIClient, files: [DeliveredFile], maximumPixels: Int = 1200,
    fill: Bool = false
  ) {
    self.url = url
    self.client = client
    self.files = files
    self.maximumPixels = maximumPixels
    self.fill = fill
    if let url, let path = MarkdownImageResource.path(url, baseURL: client.baseURL, files: files) {
      let key = InlineImageCache.key(
        baseURL: client.baseURL, path: path, maximumPixels: maximumPixels)
      _image = State(initialValue: InlineImageCache.memoryImage(key))
    }
  }

  private var file: DeliveredFile? {
    url.flatMap { FilePreviewResource.attachment($0, baseURL: client.baseURL, files: files) }
  }

  @ViewBuilder
  private var content: some View {
    Group {
      if let image, fill {
        Color.clear.overlay {
          Image(image, scale: 1, label: Text("Image")).resizable().scaledToFill()
        }
        .clipped()
      } else if let image {
        Image(image, scale: 1, label: Text("Image")).resizable()
          .aspectRatio(CGFloat(image.width) / CGFloat(image.height), contentMode: .fit)
      } else if fill {
        if error != nil {
          ZStack {
            QMTheme.surface
            Image(systemName: "photo.badge.exclamationmark").foregroundStyle(.secondary)
          }
        } else {
          UploadingImageTile(phase: Double(maximumPixels % 7), cornerRadius: 0)
        }
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
      if image != nil { return }
      error = nil
      do {
        let decoded = try await InlineImageLoader.load(
          path: path, client: client, maximumPixels: maximumPixels)
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

struct DraftImageThumbnail: View {
  let attachment: UploadAttachment
  let account: String
  @State private var image: CGImage?

  var body: some View {
    ZStack {
      Color.primary.opacity(0.08)
      if let image {
        Image(image, scale: 1, label: Text(attachment.name)).resizable().scaledToFill()
      }
    }
    .task(id: attachment.localSHA) {
      guard let sha = attachment.localSHA else { return }
      let account = account
      let worker = Task.detached(priority: .userInitiated) {
        try AttachmentCache.read(account: account, sha: sha)
      }
      guard let prepared = try? await worker.value else { return }
      defer { withExtendedLifetime(prepared) {} }
      image = try? MarkdownImageResource.thumbnail(contentsOf: prepared.url, maximumPixels: 240)
    }
  }
}

/// Sendable wrapper so decoded images can cross from background decoding to the view.
final class DecodedImage: @unchecked Sendable {
  let image: CGImage
  init(_ image: CGImage) { self.image = image }
}

/// Downscaled copies of inline images, in memory and on disk. Files are immutable once
/// delivered, so a cached thumbnail never goes stale; reopening a conversation shows its
/// images immediately instead of downloading the originals again.
enum InlineImageCache {
  nonisolated(unsafe) private static let memory: NSCache<NSString, DecodedImage> = {
    let cache = NSCache<NSString, DecodedImage>()
    cache.totalCostLimit = 64 * 1024 * 1024
    return cache
  }()
  static let maximumDiskFiles = 400

  static func key(baseURL: URL, path: String, maximumPixels: Int) -> String {
    let digest = SHA256.hash(
      data: Data("\(baseURL.absoluteString)|\(path)#\(maximumPixels)".utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  static func memoryImage(_ key: String) -> CGImage? {
    memory.object(forKey: key as NSString)?.image
  }

  private static func remember(_ image: CGImage, key: String) {
    memory.setObject(
      DecodedImage(image), forKey: key as NSString, cost: image.bytesPerRow * image.height)
  }

  private static func directory() throws -> URL {
    try FileManager.default.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("InlineImages", isDirectory: true)
  }

  static func diskImage(_ key: String) -> CGImage? {
    guard let file = try? directory().appendingPathComponent(key),
      let source = CGImageSourceCreateWithURL(file as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(
        source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    else { return nil }
    remember(image, key: key)
    return image
  }

  static func store(_ image: CGImage, key: String) {
    remember(image, key: key)
    do {
      var folder = try directory()
      try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try? folder.setResourceValues(values)
      let data = NSMutableData()
      guard
        let destination = CGImageDestinationCreateWithData(
          data, UTType.jpeg.identifier as CFString, 1, nil)
      else { return }
      CGImageDestinationAddImage(
        destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { return }
      try (data as Data).write(
        to: folder.appendingPathComponent(key), options: [.atomic, .completeFileProtection])
      prune(folder)
    } catch {}
  }

  private static func prune(_ folder: URL) {
    guard
      let files = try? FileManager.default.contentsOfDirectory(
        at: folder, includingPropertiesForKeys: [.contentModificationDateKey]),
      files.count > maximumDiskFiles
    else { return }
    let dated = files.map {
      ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate ?? .distantPast)
    }
    for (file, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(files.count - maximumDiskFiles) {
      try? FileManager.default.removeItem(at: file)
    }
  }

  static func clear() {
    memory.removeAllObjects()
    if let folder = try? directory() { try? FileManager.default.removeItem(at: folder) }
  }
}

enum InlineImageLoader {
  @MainActor
  static func load(path: String, client: APIClient, maximumPixels: Int) async throws -> CGImage {
    let key = InlineImageCache.key(
      baseURL: client.baseURL, path: path, maximumPixels: maximumPixels)
    if let image = InlineImageCache.memoryImage(key) { return image }
    if let cached = await Task.detached(priority: .userInitiated, operation: {
      InlineImageCache.diskImage(key).map(DecodedImage.init)
    }).value {
      return cached.image
    }
    let data = try await client.imageData(path)
    return try await decode(data, maximumPixels: maximumPixels, key: key)
  }

  private static func decode(_ data: Data, maximumPixels: Int, key: String) async throws
    -> CGImage
  {
    try await Task.detached(priority: .userInitiated) {
      let image = try MarkdownImageResource.thumbnail(data, maximumPixels: maximumPixels)
      InlineImageCache.store(image, key: key)
      return DecodedImage(image)
    }.value.image
  }
}

/// How a message lays out several inline images:
/// - 1: the image at its own aspect ratio (up to 280×360).
/// - 2: two squares side by side.
/// - 3: one tall image on the left, two squares stacked on the right.
/// - 4: a 2×2 grid.
/// - 5 or more: a three-column grid of squares, at most 9 tiles; the last tile shows "+N"
///   for the images that don't fit.
/// Tapping any tile opens that image full screen. Other files keep their file cards.
enum InlineImageLayout {
  static let width: CGFloat = 280
  static let spacing: CGFloat = 3

  static func columns(_ count: Int) -> Int { count <= 1 ? 1 : count <= 4 ? 2 : 3 }
  static func visibleCount(_ count: Int) -> Int { count <= 4 ? count : min(count, 9) }
  static func overflow(_ count: Int) -> Int { count - visibleCount(count) }
  static func tileSide(columns: Int) -> CGFloat {
    (width - spacing * CGFloat(columns - 1)) / CGFloat(columns)
  }
}

struct AttachmentImageGrid: View {
  let files: [DeliveredFile]
  let client: APIClient

  var body: some View {
    Group {
      if files.count == 3 {
        let side = InlineImageLayout.tileSide(columns: 2)
        HStack(spacing: InlineImageLayout.spacing) {
          tile(0, width: side, height: side * 2 + InlineImageLayout.spacing)
          VStack(spacing: InlineImageLayout.spacing) {
            tile(1, width: side, height: side)
            tile(2, width: side, height: side)
          }
        }
      } else {
        let columns = InlineImageLayout.columns(files.count)
        let visible = InlineImageLayout.visibleCount(files.count)
        let side = InlineImageLayout.tileSide(columns: columns)
        VStack(alignment: .leading, spacing: InlineImageLayout.spacing) {
          ForEach(Array(stride(from: 0, to: visible, by: columns)), id: \.self) { start in
            HStack(spacing: InlineImageLayout.spacing) {
              ForEach(start..<min(start + columns, visible), id: \.self) { index in
                tile(
                  index, width: side, height: side,
                  more: index == visible - 1 ? InlineImageLayout.overflow(files.count) : 0)
              }
            }
          }
        }
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 12))
  }

  private func tile(_ index: Int, width: CGFloat, height: CGFloat, more: Int = 0) -> some View {
    let file = files[index]
    let url = FilePreviewResource.path(for: file.artifactId).map { client.url($0) }
    return Group {
      if url == nil {
        // Just sent: the server hasn't returned the file yet.
        UploadingImageTile(phase: Double(index), cornerRadius: 0)
      } else {
        WorkspaceMarkdownImage(
          url: url, client: client, files: [file], maximumPixels: 600, fill: true)
      }
    }
    .frame(width: width, height: height)
    .overlay {
      if more > 0 {
        ZStack {
          Color.black.opacity(0.45)
          Text("+\(more)").font(.title2.weight(.semibold)).foregroundStyle(.white)
        }
        .allowsHitTesting(false)
      }
    }
  }
}
