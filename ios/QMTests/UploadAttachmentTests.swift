import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import XCTest

@testable import QM

final class UploadAttachmentTests: XCTestCase {
  func testWebParityAttachmentLimitRejectsEmptyAndOversizedFiles() throws {
    XCTAssertEqual(AttachmentUpload.maximumBytes, 1_000_000_000)
    XCTAssertEqual(AttachmentUpload.maximumFiles, 10)
    XCTAssertThrowsError(try AttachmentUpload.validate(size: 0, name: "empty.txt"))
    XCTAssertThrowsError(try AttachmentUpload.validate(size: 1_000_000_001, name: "large.zip")) {
      error in
      XCTAssertEqual(
        error.localizedDescription,
        "Files up to 1 GB can be attached.")
    }
    XCTAssertNoThrow(try AttachmentUpload.validate(size: 1_000_000_000, name: "large.zip"))
  }

  func testPreparedFileUsesItsContentDigestAndMimeType() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("message.txt")
    try Data("abc".utf8).write(to: url)
    let prepared = try await AttachmentUpload.prepare(url)
    XCTAssertEqual(prepared.name, "message.txt")
    XCTAssertEqual(prepared.mimetype, "text/plain")
    XCTAssertEqual(try Data(contentsOf: prepared.url), Data("abc".utf8))
    XCTAssertEqual(prepared.sha, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path), ["message.txt"])
  }

  func testLargeFileIsStagedIndependentlyAndRemovedWhenReleased() throws {
    let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    FileManager.default.createFile(atPath: source.path, contents: nil)
    defer { try? FileManager.default.removeItem(at: source) }
    let handle = try FileHandle(forWritingTo: source)
    try handle.truncate(atOffset: 60_000_000)
    try handle.close()
    var stagedURL: URL!
    do {
      let prepared = try AttachmentUpload.read(source)
      stagedURL = prepared.url
      XCTAssertEqual(prepared.size, 60_000_000)
      XCTAssertNotEqual(prepared.url, source)
      try Data("changed".utf8).write(to: source)
      XCTAssertEqual(try prepared.url.resourceValues(forKeys: [.fileSizeKey]).fileSize, 60_000_000)
      XCTAssertEqual(
        try prepared.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
        true)
      withExtendedLifetime(prepared) {}
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: stagedURL.path))
  }

  func testFoldersAndRemoteURLsAreRejected() throws {
    XCTAssertThrowsError(
      try AttachmentUpload.read(URL(string: "https://example.com/document.pdf")!))
    XCTAssertThrowsError(try AttachmentUpload.read(FileManager.default.temporaryDirectory))
  }

  func testAttachmentRoundTripsWithServerFieldNames() throws {
    let source = UploadAttachment(
      name: "report.pdf", mimetype: "application/pdf", sizeBytes: 123, blobId: "blob-1")
    let data = try JSONEncoder().encode(source)
    let restored = try JSONDecoder().decode(UploadAttachment.self, from: data)
    XCTAssertEqual(restored, source)
    XCTAssertEqual(restored.id, "blob-1")
    let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(Set(fields.keys), ["name", "mimetype", "sizeBytes", "blobId"])
  }

  func testCacheIsAccountScopedProtectedAndExcludedFromBackup() throws {
    let account = "../private/" + UUID().uuidString
    let other = UUID().uuidString
    defer {
      try? AttachmentCache.removeAccount(account: account)
      try? AttachmentCache.removeAccount(account: other)
    }
    let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    try AttachmentCache.write(
      attachmentFixture(), account: account, generation: AttachmentCache.generation)
    XCTAssertEqual(
      try cachedAttachmentData(account: account, sha: sha), Data("abc".utf8))
    XCTAssertThrowsError(try AttachmentCache.read(account: other, sha: sha))
    let folder = try AttachmentCache.directory(account: account)
    XCTAssertEqual(folder.lastPathComponent.count, 64)
    XCTAssertFalse(folder.path.contains(account))
    XCTAssertEqual(
      try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    #if !targetEnvironment(simulator)
      let attrs = try FileManager.default.attributesOfItem(
        atPath: folder.appendingPathComponent(sha).path)
      XCTAssertEqual(attrs[.protectionKey] as? FileProtectionType, .complete)
    #endif
    try AttachmentCache.removeAccount(account: account)
    XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
  }

  func testCacheRejectsUnsafeReferencesAndMismatchedContent() throws {
    let account = UUID().uuidString
    defer { try? AttachmentCache.removeAccount(account: account) }
    for sha in [
      "../secret", "", String(repeating: "a", count: 63), String(repeating: "A", count: 64),
    ] {
      XCTAssertThrowsError(try AttachmentCache.read(account: account, sha: sha))
    }
    let prepared = try attachmentFixture()
    try AttachmentCache.write(prepared, account: account, generation: AttachmentCache.generation)
    let file = try AttachmentCache.directory(account: account).appendingPathComponent(prepared.sha)
    try Data("damaged".utf8).write(to: file)
    XCTAssertThrowsError(try AttachmentCache.read(account: account, sha: prepared.sha))
  }

  func testPrunePreservesReferencesAndUnrecognizedFiles() throws {
    let account = UUID().uuidString
    defer { try? AttachmentCache.removeAccount(account: account) }
    let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    try AttachmentCache.write(
      attachmentFixture(), account: account, generation: AttachmentCache.generation)
    let folder = try AttachmentCache.directory(account: account)
    let unknown = folder.appendingPathComponent("unrecognized")
    try Data("keep".utf8).write(to: unknown)
    try AttachmentCache.prune(account: account, keeping: [sha])
    XCTAssertEqual(
      try cachedAttachmentData(account: account, sha: sha), Data("abc".utf8))
    try AttachmentCache.prune(account: account, keeping: [])
    XCTAssertThrowsError(try AttachmentCache.read(account: account, sha: sha))
    XCTAssertTrue(FileManager.default.fileExists(atPath: unknown.path))
  }

  func testSignOutInvalidatesDelayedWritesWithoutErasingNewAccountFiles() throws {
    let account = UUID().uuidString
    defer { try? AttachmentCache.removeAccount(account: account) }
    let prepared = try attachmentFixture()
    let previous = AttachmentCache.generation
    try AttachmentCache.write(prepared, account: account, generation: previous)
    try AttachmentCache.removeAccount(account: account)
    let folder = try AttachmentCache.directory(account: account)
    XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    XCTAssertThrowsError(
      try AttachmentCache.write(prepared, account: account, generation: previous)
    ) {
      XCTAssertTrue($0 is CancellationError)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    try AttachmentCache.write(prepared, account: account, generation: AttachmentCache.generation)
    XCTAssertThrowsError(
      try AttachmentCache.write(prepared, account: account, generation: previous))
    XCTAssertEqual(try cachedAttachmentData(account: account, sha: prepared.sha), Data("abc".utf8))
  }

  func testPickedMediaIsNamedByKindDateAndPosition() throws {
    let date = try XCTUnwrap(
      Calendar.current.date(
        from: DateComponents(year: 2026, month: 11, day: 10, hour: 14, minute: 3, second: 22)))
    XCTAssertEqual(
      AttachmentSource.mediaName(video: false, ordinal: 0, date: date), "Photo 2026-11-10 14.03.22")
    XCTAssertEqual(
      AttachmentSource.mediaName(video: true, ordinal: 2, date: date),
      "Video 2026-11-10 14.03.22 (3)")
  }

  @MainActor func testPhotoLibrarySelectionKeepsOrderAndReportsItemsThatCannotLoad() async {
    let items = [
      PhotosPickerItem(itemIdentifier: "first"), PhotosPickerItem(itemIdentifier: "second"),
    ]
    let sources = AttachmentSource.photos(items, date: Date(timeIntervalSince1970: 0))
    XCTAssertEqual(sources.count, 2)
    XCTAssertTrue(sources[0].name.hasPrefix("Photo "))
    XCTAssertEqual(sources[1].name, sources[0].name + " (2)")
    do {
      _ = try await sources[0].prepare()
      XCTFail("An item that is not in the photo library cannot be prepared")
    } catch {
      XCTAssertEqual(
        error.localizedDescription, "This item could not be loaded from the photo library.")
    }
  }

  private func libraryFile(_ name: String, bytes: Int) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent(name)
    FileManager.default.createFile(atPath: file.path, contents: nil)
    let handle = try FileHandle(forWritingTo: file)
    try handle.truncate(atOffset: UInt64(bytes))
    try handle.close()
    return file
  }

  @MainActor func testLibraryVideosAndPhotosAreCopiedAsFilesAndStagedFromDisk() async throws {
    for (name, mimetype) in [("IMG_0001.MOV", "video/quicktime"), ("IMG_0002.heic", "image/heic")] {
      let source = try libraryFile(name, bytes: 60_000_000)
      let picked = try await library(source)
      XCTAssertNotEqual(picked.url, source, name)
      XCTAssertEqual(
        try picked.url.resourceValues(forKeys: [.fileSizeKey]).fileSize, 60_000_000, name)
      let prepared = try await AttachmentSource.media(name: "Picked") { picked.url }.prepare()
      let suffix = URL(fileURLWithPath: name).pathExtension.lowercased()
      XCTAssertEqual(prepared.name, "Picked.\(suffix)")
      XCTAssertEqual(prepared.mimetype, mimetype)
      XCTAssertEqual(prepared.size, 60_000_000)
      XCTAssertEqual(
        try prepared.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
        true)
      XCTAssertFalse(FileManager.default.fileExists(atPath: picked.url.path), name)
    }
  }

  @MainActor func testLibraryVideoOverTheLimitIsRefusedByItsFileSizeAndCleanedUp() async throws {
    let source = try libraryFile("IMG_0003.mov", bytes: AttachmentUpload.maximumBytes + 1)
    let picked = try await library(source)
    do {
      _ = try await AttachmentSource.media(name: "Video") { picked.url }.prepare()
      XCTFail("A video over 1 GB cannot be attached")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Files up to 1 GB can be attached.")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: picked.url.path))
  }

  func testCachedAttachmentReferenceRoundTripsAndUncachedAttachmentsDecode() throws {
    let attachment = UploadAttachment(
      name: "report.txt", mimetype: "text/plain", sizeBytes: 3,
      blobId: "staged", localSHA: String(repeating: "a", count: 64), uploadedAt: 1234)
    let restored = try JSONDecoder().decode(
      UploadAttachment.self, from: JSONEncoder().encode(attachment))
    XCTAssertEqual(restored.localSHA, attachment.localSHA)
    XCTAssertEqual(restored.uploadedAt, 1234)
    let uncached = Data(
      #"{"name":"report.txt","mimetype":"text/plain","sizeBytes":3,"blobId":"staged"}"#.utf8)
    XCTAssertNil(try JSONDecoder().decode(UploadAttachment.self, from: uncached).localSHA)
  }

}

private func library(_ file: URL) async throws -> PickedMedia {
  let provider = try XCTUnwrap(NSItemProvider(contentsOf: file))
  return try await withCheckedThrowingContinuation { continuation in
    _ = provider.loadTransferable(type: PickedMedia.self) { continuation.resume(with: $0) }
  }
}

func attachmentFixture() throws -> PreparedAttachment {
  let source = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try Data("abc".utf8).write(to: source)
  defer { try? FileManager.default.removeItem(at: source) }
  return try AttachmentUpload.read(source)
}

func cachedAttachmentData(account: String, sha: String) throws -> Data {
  let prepared = try AttachmentCache.read(account: account, sha: sha)
  return try withExtendedLifetime(prepared) { try Data(contentsOf: prepared.url) }
}
