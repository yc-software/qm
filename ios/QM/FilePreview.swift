import Foundation
import QuickLook
import SwiftUI

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
  static func attachment(_ url: URL, files: [DeliveredFile]) -> DeliveredFile? {
    guard url.scheme?.lowercased() == "attachment", url.query == nil, url.fragment == nil,
      url.absoluteString.hasPrefix("attachment://"),
      let name = String(url.absoluteString.dropFirst("attachment://".count)).removingPercentEncoding
    else { return nil }
    return files.first { $0.name == name && path(for: $0.artifactId) != nil }
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
  let file: DeliveredFile
  let client: APIClient
  @Environment(\.dismiss) private var dismiss
  @State private var preview: TemporaryPreviewFile?
  @State private var markdown: String?
  @State private var showingSource = false
  @State private var error: String?
  @State private var attempt = 0

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
            if FilePreviewResource.path(for: file.artifactId) != nil {
              Button("Try again") { attempt += 1 }.buttonStyle(.borderedProminent)
            }
          }
        } else {
          ProgressView("Downloading file…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .navigationTitle(file.name?.isEmpty == false ? file.name! : "Attachment")
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
    guard let path = FilePreviewResource.path(for: file.artifactId) else {
      error = "This attachment does not have a downloadable file reference."
      return
    }
    do {
      let downloaded = try await client.download(path)
      defer { try? FileManager.default.removeItem(at: downloaded) }
      try Task.checkCancellation()
      let loaded = try TemporaryPreviewFile(moving: downloaded, name: file.name)
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
