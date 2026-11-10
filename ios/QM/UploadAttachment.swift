import CryptoKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers
import os

struct UploadedBlob: Codable, Sendable {
  let blobId: String
  let sizeBytes: Int
}

struct UploadAttachment: Codable, Identifiable, Sendable, Equatable {
  let name: String
  let mimetype: String
  let sizeBytes: Int
  let blobId: String
  var localSHA: String? = nil
  var uploadedAt: Double? = nil
  var id: String { blobId }
}

enum AttachmentCache {
  private static let state = OSAllocatedUnfairLock(initialState: UUID())

  static var generation: UUID { state.withLock { $0 } }

  static func write(_ prepared: PreparedAttachment, account: String, generation: UUID) throws {
    defer { withExtendedLifetime(prepared) {} }
    try validateSHA(prepared.sha)
    let staging = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: staging) }
    try FileManager.default.copyItem(at: prepared.url, to: staging)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete], ofItemAtPath: staging.path)
    try state.withLock { current in
      guard current == generation else { throw CancellationError() }
      var folder = try directory(account: account)
      try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try folder.setResourceValues(values)
      let file = folder.appendingPathComponent(prepared.sha, isDirectory: false)
      if FileManager.default.fileExists(atPath: file.path) {
        _ = try FileManager.default.replaceItemAt(file, withItemAt: staging)
      } else {
        try FileManager.default.moveItem(at: staging, to: file)
      }
    }
  }

  static func read(account: String, sha: String) throws -> PreparedAttachment {
    try validateSHA(sha)
    let prepared = try AttachmentUpload.read(
      try directory(account: account).appendingPathComponent(sha))
    guard prepared.sha == sha else {
      throw QMError.message("The saved attachment is damaged. Attach the file again.")
    }
    return prepared
  }

  static func removeAccount(account: String) throws {
    let removed = try state.withLock { current -> URL? in
      current = UUID()
      let folder = try directory(account: account)
      guard FileManager.default.fileExists(atPath: folder.path) else { return nil }
      let removed = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.moveItem(at: folder, to: removed)
      return removed
    }
    if let removed { try FileManager.default.removeItem(at: removed) }
  }

  static func prune(account: String, keeping: Set<String>) throws {
    try state.withLock { _ in
      for sha in keeping { try validateSHA(sha) }
      let folder = try directory(account: account)
      guard FileManager.default.fileExists(atPath: folder.path) else { return }
      for file in try FileManager.default.contentsOfDirectory(
        at: folder,
        includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
      {
        let sha = file.lastPathComponent
        guard (try? validateSHA(sha)) != nil, !keeping.contains(sha) else { continue }
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        if values.isRegularFile == true && values.isSymbolicLink != true {
          try FileManager.default.removeItem(at: file)
        }
      }
    }
  }

  static func directory(account: String) throws -> URL {
    try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true
    )
    .appendingPathComponent("QMAttachments", isDirectory: true)
    .appendingPathComponent(digest(Data(account.utf8)), isDirectory: true)
  }

  private static func validateSHA(_ sha: String) throws {
    guard sha.utf8.count == 64,
      sha.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else {
      throw QMError.message("The attachment reference is invalid. Attach the file again.")
    }
  }

  private static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).hex
  }
}

final class PreparedAttachment: Sendable {
  let name: String
  let mimetype: String
  let url: URL
  let size: Int
  let sha: String

  fileprivate init(name: String, mimetype: String, url: URL, size: Int, sha: String) {
    self.name = name
    self.mimetype = mimetype
    self.url = url
    self.size = size
    self.sha = sha
  }

  deinit { try? FileManager.default.removeItem(at: url) }
}

enum AttachmentUpload {
  static let maximumBytes = 1_000_000_000
  static let maximumFiles = 10

  static func validate(size: Int, name: String) throws {
    guard size > 0 else {
      throw QMError.message("\(name) is empty. Choose a file with content.")
    }
    guard size <= maximumBytes else {
      throw QMError.message(
        "Files up to 1 GB can be attached.")
    }
  }

  static func prepare(_ url: URL) async throws -> PreparedAttachment {
    let worker = Task.detached(priority: .userInitiated) { try read(url) }
    return try await withTaskCancellationHandler {
      try await worker.value
    } onCancel: {
      worker.cancel()
    }
  }

  static func read(_ url: URL, name suppliedName: String? = nil, type: UTType? = nil) throws
    -> PreparedAttachment
  {
    try Task.checkCancellation()
    guard url.isFileURL else { throw QMError.message("Choose a file from Files.") }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentTypeKey])
    let name = suppliedName ?? url.lastPathComponent
    guard values.isRegularFile == true else {
      throw QMError.message("\(name) is not a regular file. Choose a document instead.")
    }
    if let size = values.fileSize { try validate(size: size, name: name) }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var staging = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    guard
      FileManager.default.createFile(
        atPath: staging.path, contents: nil,
        attributes: [.protectionKey: FileProtectionType.complete])
    else { throw QMError.message("Could not prepare this attachment on the device.") }
    var retained = false
    defer { if !retained { try? FileManager.default.removeItem(at: staging) } }
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try staging.setResourceValues(resources)
    let output = try FileHandle(forWritingTo: staging)
    defer { try? output.close() }
    var size = 0
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
      try Task.checkCancellation()
      guard chunk.count <= maximumBytes - size else {
        throw QMError.message(
          "Files up to 1 GB can be attached.")
      }
      try output.write(contentsOf: chunk)
      size += chunk.count
      hash.update(data: chunk)
    }
    try validate(size: size, name: name)
    try output.close()
    retained = true
    return PreparedAttachment(
      name: name,
      mimetype: type?.preferredMIMEType ?? values.contentType?.preferredMIMEType
        ?? UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        ?? "application/octet-stream",
      url: staging, size: size,
      sha: hash.finalize().hex)
  }
}

@MainActor enum AttachmentSource {
  case file(URL)
  case image(NSItemProvider)

  var name: String {
    switch self {
    case .file(let url): return url.lastPathComponent
    case .image(let provider): return provider.suggestedName ?? "Pasted image"
    }
  }

  func prepare() async throws -> PreparedAttachment {
    switch self {
    case .file(let url):
      return try await AttachmentUpload.prepare(url)
    case .image(let provider):
      guard
        let type = provider.registeredTypeIdentifiers.compactMap(UTType.init)
          .first(where: { $0.conforms(to: .image) })
      else { throw QMError.message("The clipboard does not contain a supported image.") }
      var filename = FilePreviewResource.filename(provider.suggestedName ?? "Pasted image")
      if URL(fileURLWithPath: filename).pathExtension.isEmpty,
        let suffix = type.preferredFilenameExtension
      {
        filename += ".\(suffix)"
      }
      let name = filename
      return try await withCheckedThrowingContinuation { continuation in
        provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
          do {
            guard let url else {
              throw error ?? QMError.message("The image could not be read. Copy it and try again.")
            }
            continuation.resume(returning: try AttachmentUpload.read(url, name: name, type: type))
          } catch {
            continuation.resume(throwing: error)
          }
        }
      }
    }
  }
}

struct AttachmentPicker: View {
  let uploading: Bool
  @Binding var error: String?
  let onSelect: ([AttachmentSource]) -> Void
  @State private var showingImporter = false

  var body: some View {
    Menu {
      Button("Choose files", systemImage: "doc") { showingImporter = true }
      PasteButton(supportedContentTypes: [.image]) { providers in
        onSelect(providers.map(AttachmentSource.image))
      }
    } label: {
      Image(systemName: "paperclip").font(.system(size: 20)).frame(width: 44, height: 44)
    }
    .accessibilityLabel(uploading ? "Uploading attachments" : "Attach files")
    .disabled(uploading)
    .fileImporter(
      isPresented: $showingImporter, allowedContentTypes: [.item], allowsMultipleSelection: true
    ) {
      result in
      switch result {
      case .success(let urls):
        guard !urls.isEmpty, !uploading else { return }
        onSelect(urls.map(AttachmentSource.file))
      case .failure(let failure):
        let nsError = failure as NSError
        if nsError.domain != NSCocoaErrorDomain || nsError.code != NSUserCancelledError {
          error = failure.localizedDescription
        }
      }
    }
  }
}

extension ChatModel {
  func addAttachments(_ sources: [AttachmentSource]) {
    guard !conversation.isSubagent, attachmentUploadTask == nil, !sending, !uploading,
      !sources.isEmpty
    else { return }
    attachmentUploadTask = Task {
      await uploadAttachments(sources)
      if !Task.isCancelled { attachmentUploadTask = nil }
    }
  }

  func cancelAttachmentUpload() {
    attachmentUploadTask?.cancel()
    attachmentUploadTask = nil
    uploading = false
    uploadingName = nil
  }

  func uploadAttachments(_ sources: [AttachmentSource]) async {
    guard !conversation.isSubagent, !Task.isCancelled, !sending, !uploading else { return }
    uploading = true
    defer {
      if !Task.isCancelled {
        uploading = false
        uploadingName = nil
      }
    }
    error = nil
    let generation = client.generation
    let cacheGeneration = AttachmentCache.generation
    let account = attachmentAccount
    var failures: [String] = []
    for source in sources {
      do {
        try Task.checkCancellation()
        guard generation == client.generation else { break }
        guard attachments.count < AttachmentUpload.maximumFiles else {
          failures.append(
            "Up to 10 files can be attached. Remove an attachment before adding more.")
          break
        }
        uploadingName = source.name
        let prepared = try await source.prepare()
        try Task.checkCancellation()
        guard generation == client.generation else { break }
        try await Task.detached {
          try AttachmentCache.write(prepared, account: account, generation: cacheGeneration)
        }.value
        try Task.checkCancellation()
        guard generation == client.generation else { break }
        let blob = try await client.upload(prepared)
        try Task.checkCancellation()
        guard generation == client.generation else { break }
        guard !blob.blobId.isEmpty, blob.sizeBytes == prepared.size else {
          throw QMError.message(
            "The server could not confirm this upload. Try attaching the file again.")
        }
        if !attachments.contains(where: { $0.blobId == blob.blobId }) {
          attachments.append(
            UploadAttachment(
              name: prepared.name, mimetype: prepared.mimetype,
              sizeBytes: blob.sizeBytes, blobId: blob.blobId, localSHA: prepared.sha,
              uploadedAt: Date().timeIntervalSince1970))
          saveDraft()
        }
      } catch is CancellationError {
        break
      } catch {
        guard generation == client.generation else { break }
        failures.append("\(source.name): \(error.localizedDescription)")
      }
    }
    if !Task.isCancelled, !failures.isEmpty { error = failures.joined(separator: "\n") }
  }
}
