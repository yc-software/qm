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
}
