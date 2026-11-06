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
