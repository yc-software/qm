import SwiftUI
import UniformTypeIdentifiers
import XCTest

@testable import QM

@MainActor
final class AttachmentPickerTests: XCTestCase {
  private func withChat(_ action: (ChatModel) async throws -> Void) async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AttachmentSubmissionProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(UUID().uuidString).example.test")!,
      configuration: configuration)
    let conversation = Conversation(
      id: "draft", scopeId: "personal:test", threadRef: "web:test:draft", surface: "web",
      localOnly: true)
    let chat = ChatModel(
      conversation: conversation, client: client, user: "test", knownSession: false)
    defer { DraftStore.removeAccount(chat.attachmentAccount) }
    try await action(chat)
  }

  private func picked(_ text: String, suffix: String = "jpeg") -> @Sendable () throws -> URL {
    {
      let url = PickedMedia.scratch(suffix)
      try Data(text.utf8).write(to: url)
      return url
    }
  }

  func testSelectionUploadsAndSavesAttachmentWithoutChangingDraft() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let selected = directory.appendingPathComponent("selected-release-notes.txt")
    try Data("abc".utf8).write(to: selected)

    try await withChat { chat in
      chat.draft = "Keep this paragraph and its selection."
      await chat.uploadAttachments([.file(selected)])
      XCTAssertEqual(chat.attachments.map(\.name), [selected.lastPathComponent])
      XCTAssertFalse(chat.uploading)
      XCTAssertNil(chat.uploadingName)
      XCTAssertNil(chat.error)
      let restored = ChatModel(
        conversation: chat.conversation, client: chat.client, user: "test", knownSession: false)
      XCTAssertEqual(restored.draft, chat.draft)
      XCTAssertEqual(restored.attachments, chat.attachments)

      await chat.uploadAttachments([.file(directory.appendingPathComponent("missing.txt"))])
      XCTAssertEqual(chat.attachments.count, 1)
      XCTAssertFalse(chat.uploading)
      XCTAssertNil(chat.uploadingName)
      XCTAssertNotNil(chat.error)
    }
  }

  func testCancelledSelectionClearsPendingFilenameWithoutUploading() async throws {
    try await withChat { chat in
      let request = Task {
        await chat.uploadAttachments([.file(URL(fileURLWithPath: "/cancelled-selection.txt"))])
      }
      request.cancel()
      await request.value
      XCTAssertFalse(chat.uploading)
      XCTAssertNil(chat.uploadingName)
      XCTAssertNil(chat.error)
      XCTAssertTrue(chat.attachments.isEmpty)
    }
  }

  func testPastedImageKeepsBytesAndProvidesPreviewableFilename() async throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { context in
      UIColor.blue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
    }
    let bytes = try XCTUnwrap(image.pngData())
    let provider = NSItemProvider()
    provider.suggestedName = "Copied screenshot"
    provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all)
    {
      completion in
      completion(bytes, nil)
      return nil
    }
    let attachment = try await AttachmentSource.image(provider).prepare()
    XCTAssertEqual(attachment.name, "Copied screenshot.png")
    XCTAssertEqual(attachment.mimetype, "image/png")
    XCTAssertEqual(attachment.size, bytes.count)
    XCTAssertEqual(try Data(contentsOf: attachment.url), bytes)
    XCTAssertNotNil(UIImage(contentsOfFile: attachment.url.path))
  }

  func testCopiedUIImageProviderCanBePrepared() async throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { context in
      UIColor.orange.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
    }
    let attachment = try await AttachmentSource.image(NSItemProvider(object: image)).prepare()
    XCTAssertTrue(attachment.mimetype.hasPrefix("image/"))
    XCTAssertFalse(URL(fileURLWithPath: attachment.name).pathExtension.isEmpty)
    XCTAssertNotNil(UIImage(contentsOfFile: attachment.url.path))
  }

  func testTextProviderDoesNotBecomeAnAttachment() async throws {
    try await withChat { chat in
      chat.draft = "Keep the original draft"
      await chat.uploadAttachments([.image(NSItemProvider(object: "Pasted text" as NSString))])
      XCTAssertTrue(chat.attachments.isEmpty)
      XCTAssertEqual(chat.draft, "Keep the original draft")
      XCTAssertNotNil(chat.error)
      XCTAssertFalse(chat.uploading)
    }
  }

  func testCancelledProviderCannotClearReplacementUpload() async throws {
    func provider(name: String, delay: Double, started: XCTestExpectation) -> NSItemProvider {
      let provider = NSItemProvider()
      provider.suggestedName = name
      provider.registerDataRepresentation(
        forTypeIdentifier: UTType.png.identifier, visibility: .all
      ) {
        completion in
        started.fulfill()
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
          completion(Data("abc".utf8), nil)
        }
        return nil
      }
      return provider
    }
    try await withChat { chat in
      let firstStarted = expectation(description: "First image provider started")
      chat.addAttachments([.image(provider(name: "Cancelled", delay: 0.2, started: firstStarted))])
      await fulfillment(of: [firstStarted], timeout: 2)
      let cancelled = try XCTUnwrap(chat.attachmentUploadTask)
      chat.cancelAttachmentUpload()
      XCTAssertFalse(chat.uploading)
      XCTAssertNil(chat.attachmentUploadTask)

      let secondStarted = expectation(description: "Replacement image provider started")
      chat.addAttachments([.image(provider(name: "Kept", delay: 0.6, started: secondStarted))])
      await fulfillment(of: [secondStarted], timeout: 2)
      let replacement = try XCTUnwrap(chat.attachmentUploadTask)
      await cancelled.value
      XCTAssertTrue(chat.uploading)
      XCTAssertEqual(chat.uploadingName, "Kept")
      XCTAssertNotNil(chat.attachmentUploadTask)
      await replacement.value
      XCTAssertFalse(chat.uploading)
      XCTAssertNil(chat.attachmentUploadTask)
      XCTAssertEqual(chat.attachments.map(\.name), ["Kept.png"])
      XCTAssertNil(chat.error)
    }
  }

  func testPhotoSelectionAttachesLoadedItemsAndReportsTheOneThatFailed() async throws {
    try await withChat { chat in
      await chat.uploadAttachments([
        .media(name: "Photo 1", load: picked("first")),
        .media(name: "Photo 2") { throw QMError.message("Could not load") },
        .media(name: "Video 3", load: picked("third", suffix: "mp4")),
      ])
      XCTAssertEqual(chat.attachments.map(\.name), ["Photo 1.jpeg", "Video 3.mp4"])
      XCTAssertEqual(chat.attachments.map(\.mimetype), ["image/jpeg", "video/mp4"])
      XCTAssertEqual(chat.attachments.map(\.sizeBytes), [5, 5])
      XCTAssertEqual(chat.error, "Photo 2: Could not load")
      XCTAssertFalse(chat.uploading)
      XCTAssertNil(chat.uploadingName)
    }
  }

  func testPhotoSelectionStopsAtTheAttachmentLimitWithOneMessage() async throws {
    try await withChat { chat in
      await chat.uploadAttachments(
        (1...12).map { .media(name: "Photo \($0)", load: picked("photo \($0)")) })
      XCTAssertEqual(chat.attachments.map(\.name), (1...10).map { "Photo \($0).jpeg" })
      XCTAssertEqual(
        chat.error, "Up to 10 files can be attached. Remove an attachment before adding more.")
    }
  }

  func testSameAssetSelectedTwiceIsAttachedAndUploadedOnce() async throws {
    try await withChat { chat in
      await chat.uploadAttachments([
        .media(name: "Photo 1", load: picked("same photo")),
        .media(name: "Photo 2", load: picked("same photo")),
      ])
      XCTAssertEqual(chat.attachments.map(\.name), ["Photo 1.jpeg"])
      XCTAssertNil(chat.error)
      let host = chat.client.baseURL.host
      XCTAssertEqual(
        AttachmentSubmissionProtocol.requests.withLock {
          $0.filter { $0.url?.host == host && $0.url?.path == "/api/blobs" }.count
        }, 1)
    }
  }

  func testCameraCaptureBecomesAJPEGAttachmentAndCancellingAttachesNothing() async throws {
    var selected: [[AttachmentSource]] = []
    var dismissals = 0
    let picker = CameraPicker(onSelect: { selected.append($0) }, dismiss: { dismissals += 1 })
    let coordinator = picker.makeCoordinator()
    let controller = UIImagePickerController()
    coordinator.imagePickerControllerDidCancel(controller)
    XCTAssertTrue(selected.isEmpty)
    XCTAssertEqual(dismissals, 1)
    let image = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { context in
      UIColor.red.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
    }
    coordinator.imagePickerController(
      controller, didFinishPickingMediaWithInfo: [.originalImage: image])
    XCTAssertEqual(dismissals, 2)
    XCTAssertEqual(selected.count, 1)
    let prepared = try await XCTUnwrap(selected.first?.first).prepare()
    XCTAssertEqual(prepared.mimetype, "image/jpeg")
    XCTAssertTrue(prepared.name.hasPrefix("Photo "))
    XCTAssertEqual(URL(fileURLWithPath: prepared.name).pathExtension, "jpeg")
    XCTAssertEqual(try Data(contentsOf: prepared.url).prefix(2), Data([0xFF, 0xD8]))
    XCTAssertNotNil(UIImage(contentsOfFile: prepared.url.path))
  }

  func testACameraCaptureWithoutAPhotoIsReportedInsteadOfAttachingNothingSilently() async throws {
    var selected: [AttachmentSource] = []
    let picker = CameraPicker(onSelect: { selected += $0 }, dismiss: {})
    picker.makeCoordinator().imagePickerController(
      UIImagePickerController(), didFinishPickingMediaWithInfo: [:])
    let source = try XCTUnwrap(selected.first)
    try await withChat { chat in
      await chat.uploadAttachments([source])
      XCTAssertTrue(chat.attachments.isEmpty)
      XCTAssertEqual(chat.error, "\(source.name): The photo could not be read. Take it again.")
    }
  }
}
