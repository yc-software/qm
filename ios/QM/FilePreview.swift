import Foundation
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct FileAttachmentView: View {
  let file: DeliveredFile
  let client: APIClient
  @State private var showingPreview = false

  var body: some View {
    Button {
      showingPreview = true
    } label: {
      HStack(spacing: 12) {
        Image(systemName: "doc").font(.title3)
        VStack(alignment: .leading, spacing: 3) {
          Text(file.name?.isEmpty == false ? file.name! : "Attachment")
            .font(.body).lineLimit(2).multilineTextAlignment(.leading)
          Text(
            FilePreviewResource.path(for: file.artifactId) == nil
              ? "Preview unavailable" : "Open file"
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 4)
        Image(systemName: "chevron.right").font(.caption)
      }
      .padding(12).frame(minHeight: 44)
      .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .sheet(isPresented: $showingPreview) {
      FilePreviewSheet(file: file, client: client)
    }
  }
}

enum FilePreviewResource {
  case file(DeliveredFile)
  case draft(UploadAttachment, account: String)

  var name: String? {
    switch self {
    case .file(let file): file.name
    case .draft(let attachment, _): attachment.name
    }
  }

  var canLoad: Bool {
    switch self {
    case .file(let file): Self.path(for: file.artifactId) != nil
    case .draft(let attachment, _): attachment.localSHA != nil
    }
  }

  var loadingDescription: String {
    switch self {
    case .file: "Downloading file…"
    case .draft: "Opening file…"
    }
  }

  @MainActor
  func load(client: APIClient) async throws -> TemporaryPreviewFile {
    let generation = client.generation
    let loaded: TemporaryPreviewFile
    switch self {
    case .file(let file):
      guard let path = Self.path(for: file.artifactId) else {
        throw QMError.message("This attachment does not have a downloadable file reference.")
      }
      let downloaded = try await client.download(path)
      defer { try? FileManager.default.removeItem(at: downloaded.url) }
      try Task.checkCancellation()
      loaded = try TemporaryPreviewFile(
        moving: downloaded.url,
        name: file.name?.isEmpty == false ? file.name : downloaded.suggestedFilename)
    case .draft(let attachment, let account):
      guard let sha = attachment.localSHA else {
        throw QMError.message(
          "This attachment is no longer available on this device. Remove it and attach the file again."
        )
      }
      let prepared: PreparedAttachment
      do {
        let worker = Task.detached(priority: .userInitiated) {
          try AttachmentCache.read(account: account, sha: sha)
        }
        prepared = try await withTaskCancellationHandler {
          try await worker.value
        } onCancel: {
          worker.cancel()
        }
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        Log.background.failure("Saved attachment preview", error)
        throw QMError.message(
          "Couldn’t open the saved attachment. Remove it and attach the file again.")
      }
      defer { withExtendedLifetime(prepared) {} }
      try Task.checkCancellation()
      loaded = try TemporaryPreviewFile(moving: prepared.url, name: attachment.name)
    }
    guard generation == client.generation else { throw CancellationError() }
    return loaded
  }

  static func attachment(_ url: URL, baseURL: URL? = nil, files: [DeliveredFile]) -> DeliveredFile?
  {
    guard url.query == nil, url.fragment == nil else { return nil }
    if url.scheme?.lowercased() == "attachment" {
      guard url.absoluteString.hasPrefix("attachment://"),
        let name = String(url.absoluteString.dropFirst("attachment://".count))
          .removingPercentEncoding
      else { return nil }
      return files.first { $0.name == name && path(for: $0.artifactId) != nil }
    }
    guard let baseURL, APIClient.sameOrigin(url, baseURL), url.user == nil, url.password == nil
    else {
      return nil
    }
    let pieces = url.path(percentEncoded: true).split(
      separator: "/", omittingEmptySubsequences: false)
    guard [5, 6].contains(pieces.count), pieces[0].isEmpty, pieces[1] == "api",
      pieces[2] == "files", pieces[4] == "content",
      let artifactID = String(pieces[3]).removingPercentEncoding,
      path(for: artifactID) != nil
    else { return nil }
    let name = pieces.count == 6 ? String(pieces[5]).removingPercentEncoding : nil
    return DeliveredFile(
      name: files.first { $0.artifactId == artifactID }?.name ?? name, artifactId: artifactID)
  }

  static func path(for artifactID: String?) -> String? {
    guard let artifactID, !artifactID.isEmpty,
      artifactID.utf8.allSatisfy({
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
          || $0 == 45 || $0 == 95
      })
    else { return nil }
    return "api/files/\(artifactID)/content"
  }

  static func filename(_ name: String?) -> String {
    let leaf =
      (name ?? "Attachment").replacingOccurrences(of: "\\", with: "/")
      .components(separatedBy: "/").last ?? "Attachment"
    let allowed = CharacterSet(
      charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-()")
    let safe = String(
      String.UnicodeScalarView(
        leaf.unicodeScalars.map {
          allowed.contains($0) ? $0 : UnicodeScalar(95)!
        })
    ).trimmingCharacters(in: CharacterSet(charactersIn: ". "))
    return safe.isEmpty ? "Attachment" : String(safe.suffix(180))
  }

  static func typeDescription(_ name: String?) -> String {
    let fileExtension = URL(fileURLWithPath: filename(name)).pathExtension.lowercased()
    guard !fileExtension.isEmpty else { return "File" }
    if let type = UTType(filenameExtension: fileExtension), type.isDeclared,
      let description = type.localizedDescription
    {
      return description
    }
    return "\(fileExtension.uppercased()) file"
  }
}

final class TemporaryPreviewFile {
  let url: URL
  private let directory: URL

  init(data: Data, name: String?) throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString, isDirectory: true)
    url = directory.appendingPathComponent(FilePreviewResource.filename(name), isDirectory: false)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    do {
      try data.write(to: url, options: [.atomic, .completeFileProtection])
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  init(moving source: URL, name: String?) throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString, isDirectory: true)
    url = directory.appendingPathComponent(FilePreviewResource.filename(name), isDirectory: false)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
      try FileManager.default.moveItem(at: source, to: url)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    } catch {
      try? FileManager.default.removeItem(at: directory)
      try? FileManager.default.removeItem(at: source)
      throw error
    }
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }
}

struct FilePreviewSheet: View {
  let resource: FilePreviewResource
  let client: APIClient
  @Environment(\.dismiss) private var dismiss
  @State private var preview: TemporaryPreviewFile?
  @State private var markdown: String?
  @State private var showingSource = false
  @State private var error: String?
  @State private var attempt = 0

  init(file: DeliveredFile, client: APIClient) {
    resource = .file(file)
    self.client = client
  }

  init(attachment: UploadAttachment, account: String, client: APIClient) {
    resource = .draft(attachment, account: account)
    self.client = client
  }

  var body: some View {
    NavigationStack {
      Group {
        if let preview {
          if let markdown, !showingSource {
            ScrollView {
              MessageMarkdown(text: markdown, client: client)
                .padding(20)
                .frame(maxWidth: QMTheme.conversationWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .background(QMTheme.paper)
          } else {
            NativeFilePreview(file: preview)
          }
        } else if let error {
          ContentUnavailableView {
            Label("Couldn’t open file", systemImage: "doc.badge.ellipsis")
          } description: {
            Text(error)
          } actions: {
            if resource.canLoad {
              Button("Try again") { attempt += 1 }.buttonStyle(.borderedProminent)
            }
          }
        } else {
          NativeFileTransferLoading(name: resource.name, label: resource.loadingDescription)
        }
      }
      .navigationTitle(resource.name?.isEmpty == false ? resource.name! : "Attachment")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
        if markdown != nil {
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              Toggle("Show Markdown source", isOn: $showingSource)
            } label: {
              Image(systemName: "ellipsis.circle")
            }.accessibilityLabel("Preview options")
          }
        }
        if let preview {
          ToolbarItem(placement: .topBarLeading) {
            ShareLink(item: preview.url) { Label("Share file", systemImage: "square.and.arrow.up") }
          }
        }
      }
      .task(id: attempt) { await load() }
    }
  }

  private func load() async {
    error = nil
    do {
      let loaded = try await resource.load(client: client)
      if ["md", "markdown"].contains(loaded.url.pathExtension.lowercased()),
        let size = try loaded.url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
        size <= 2_000_000
      {
        markdown = try? String(contentsOf: loaded.url, encoding: .utf8)
      }
      preview = loaded
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private struct NativeFileTransferLoading: View {
  let name: String?
  let label: String

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          HStack(alignment: .top, spacing: 16) {
            Image(systemName: "doc")
              .font(.system(size: 34)).foregroundStyle(.teal)
              .frame(width: 44, height: 48).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
              Text(name?.isEmpty == false ? name! : "Attachment")
                .font(.headline).fixedSize(horizontal: false, vertical: true)
              Text(FilePreviewResource.typeDescription(name))
                .font(.subheadline).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Divider()
          VStack(alignment: .leading, spacing: 14) {
            Text(label).font(.subheadline)
            NativeLoadingRail(tint: .teal)
          }
        }
        .frame(maxWidth: 440)
        .padding(28)
        .frame(maxWidth: .infinity)
        .frame(minHeight: geometry.size.height)
        .accessibilityElement(children: .combine)
      }
    }
    .background(QMTheme.surface)
  }
}

private struct NativeFilePreview: UIViewControllerRepresentable {
  let file: TemporaryPreviewFile

  func makeCoordinator() -> Coordinator { Coordinator(file: file) }

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let file: TemporaryPreviewFile

    init(file: TemporaryPreviewFile) { self.file = file }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> any QLPreviewItem
    {
      file.url as NSURL
    }
  }
}

struct NativePlaygroundCard: View {
  let artifact: NativePlayground
  let client: APIClient
  @State private var showingSource = false
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(artifact.title, systemImage: "app.dashed").font(.headline)
      Text("Interactive content created by QM").font(.caption).foregroundStyle(.secondary)
      HStack {
        Link(
          "Open in browser",
          destination: client.url("api/playgrounds/\(artifact.artifactId.apiComponent)"))
        Spacer()
        Button("HTML file") { showingSource = true }
      }
    }.padding().background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      .sheet(isPresented: $showingSource) {
        FilePreviewSheet(
          file: .init(name: artifact.title + ".html", artifactId: artifact.artifactId),
          client: client)
      }
  }
}
