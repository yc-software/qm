import QuickLook
import UIKit
import UniformTypeIdentifiers
import XCTest

@testable import QM

final class FilePreviewTests: XCTestCase {
  func testAttachmentLinksUseOnlyMatchingDeliveredMetadata() {
    let files = [DeliveredFile(name: "Quarterly Report.png", artifactId: "file-1")]
    XCTAssertEqual(
      FilePreviewResource.attachment(
        URL(string: "attachment://Quarterly%20Report.png")!, files: files)?.artifactId,
      "file-1")
    for raw in [
      "attachment://other.png", "attachment://Quarterly%20Report.png?download=1",
      "attachment://Quarterly%20Report.png#fragment", "https://Quarterly%20Report.png",
      "attachment://file-1", "attachment://../Quarterly%20Report.png",
    ] {
      XCTAssertNil(FilePreviewResource.attachment(URL(string: raw)!, files: files))
    }
    XCTAssertNil(
      FilePreviewResource.attachment(
        URL(string: "attachment://Quarterly%20Report.png")!,
        files: [DeliveredFile(name: "Quarterly Report.png", artifactId: "../private")]))
  }

  func testArtifactPathCannotEscapeAuthenticatedFileEndpoint() {
    XCTAssertEqual(FilePreviewResource.path(for: "abc-123_4"), "api/files/abc-123_4/content")
    for id in [
      nil, "", "../secrets", "a/b", "a%2Fb", "a?raw=1", "a#fragment", "https://other.test/file",
    ] {
      XCTAssertNil(FilePreviewResource.path(for: id))
    }
  }

  func testWorkspaceLinksResolveNamedFilesAndDeliveredMetadata() throws {
    let base = URL(string: "https://qm.example")!
    let linked = try XCTUnwrap(
      FilePreviewResource.attachment(
        URL(string: "https://qm.example/api/files/report-1/content/Quarterly%20Report.pdf")!,
        baseURL: base, files: []))
    XCTAssertEqual(linked.name, "Quarterly Report.pdf")
    XCTAssertEqual(linked.artifactId, "report-1")
    let delivered = try XCTUnwrap(
      FilePreviewResource.attachment(
        URL(string: "https://qm.example:443/api/files/report-1/content")!, baseURL: base,
        files: [DeliveredFile(name: "Original.pdf", artifactId: "report-1")]))
    XCTAssertEqual(delivered.name, "Original.pdf")
    XCTAssertEqual(delivered.artifactId, "report-1")
    for raw in [
      "https://other.example/api/files/report-1/content/report.pdf",
      "http://qm.example/api/files/report-1/content/report.pdf",
      "https://qm.example:444/api/files/report-1/content/report.pdf",
      "https://user@qm.example/api/files/report-1/content/report.pdf",
      "https://qm.example/api/files/report-1/content/report.pdf?download=1",
      "https://qm.example/api/files/report-1/content/report.pdf#page=1",
      "https://qm.example/api/files/a%2Fb/content/report.pdf",
      "https://qm.example/api/files/report-1/content/report.pdf/extra",
      "https://qm.example//api/files/report-1/content/report.pdf",
    ] {
      XCTAssertNil(
        FilePreviewResource.attachment(URL(string: raw)!, baseURL: base, files: []), raw)
    }
  }

  @MainActor
  func testAuthenticatedPreviewUsesServerFilenameWhenLinkHasNoName() async throws {
    let server = NativeRouteProtocol.Server()
    let client = server.client([
      "GET /api/files/server-report/content": [
        .init(
          body: "A server attachment",
          headers: [
            "Content-Type": "text/plain",
            "Content-Disposition": "inline; filename*=UTF-8''Server%20Report.txt",
          ])
      ]
    ])
    try client.saveSession("preview-test")
    defer { client.signOut() }
    let file = try XCTUnwrap(
      FilePreviewResource.attachment(
        client.url("api/files/server-report/content"), baseURL: client.baseURL, files: []))

    let preview = try await FilePreviewResource.file(file).load(client: client)

    XCTAssertEqual(server.calls.count, 1)
    XCTAssertEqual(server.calls.first?.headers["Cookie"], "portal_session=preview-test")
    XCTAssertEqual(server.calls.first?.headers["Accept"], "*/*")
    XCTAssertEqual(preview.url.lastPathComponent, "Server Report.txt")
    XCTAssertEqual(try String(contentsOf: preview.url, encoding: .utf8), "A server attachment")
    XCTAssertTrue(QLPreviewController.canPreview(preview.url as NSURL))
  }

  @MainActor
  func testDraftPreviewUsesOriginalFilenameAndPreservesCachedUpload() async throws {
    let client = APIClient(baseURL: URL(string: "https://\(UUID().uuidString).example.test")!)
    let account = client.baseURL.absoluteString + "test"
    defer { try? AttachmentCache.removeAccount(account: account) }
    let data = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).pdfData {
      context in
      context.beginPage()
      ("Draft attachment" as NSString).draw(at: CGPoint(x: 20, y: 20), withAttributes: nil)
    }
    let source = try TemporaryPreviewFile(data: data, name: "Draft Report.pdf")
    let prepared = try await AttachmentUpload.prepare(source.url)
    try AttachmentCache.write(prepared, account: account, generation: AttachmentCache.generation)
    let attachment = UploadAttachment(
      name: prepared.name, mimetype: prepared.mimetype, sizeBytes: prepared.size,
      blobId: "draft-blob", localSHA: prepared.sha)

    var preview: TemporaryPreviewFile? = try await FilePreviewResource.draft(
      attachment, account: account
    ).load(client: client)
    let previewURL = try XCTUnwrap(preview?.url)
    XCTAssertEqual(previewURL.lastPathComponent, "Draft Report.pdf")
    XCTAssertEqual(try Data(contentsOf: previewURL), data)
    XCTAssertTrue(QLPreviewController.canPreview(previewURL as NSURL))
    preview = nil

    XCTAssertFalse(FileManager.default.fileExists(atPath: previewURL.path))
    let cached = try AttachmentCache.read(account: account, sha: prepared.sha)
    XCTAssertEqual(try Data(contentsOf: cached.url), data)
  }

  @MainActor
  func testMissingDraftCopyExplainsHowToAttachItAgain() async throws {
    let client = APIClient(baseURL: URL(string: "https://\(UUID().uuidString).example.test")!)
    for sha in [nil, String(repeating: "f", count: 64)] as [String?] {
      let attachment = UploadAttachment(
        name: "report.pdf", mimetype: "application/pdf", sizeBytes: 3,
        blobId: "draft-blob", localSHA: sha)
      do {
        _ = try await FilePreviewResource.draft(
          attachment, account: client.baseURL.absoluteString
        ).load(client: client)
        XCTFail("A missing cached attachment cannot be previewed")
      } catch {
        XCTAssertTrue(error.localizedDescription.contains("attach the file again"))
      }
    }
  }

  func testFilenameKeepsExtensionWithoutDirectoryOrControlCharacters() {
    XCTAssertEqual(FilePreviewResource.filename("../../report.pdf"), "report.pdf")
    XCTAssertEqual(FilePreviewResource.filename("C:\\private\\report.pdf"), "report.pdf")
    XCTAssertEqual(FilePreviewResource.filename(".."), "Attachment")
    XCTAssertEqual(FilePreviewResource.filename("report\n.pdf"), "report_.pdf")
    XCTAssertEqual(FilePreviewResource.filename(nil), "Attachment")
    let long = FilePreviewResource.filename(String(repeating: "a", count: 400) + ".pdf")
    XCTAssertLessThanOrEqual(long.utf8.count, 180)
    XCTAssertTrue(long.hasSuffix(".pdf"))
  }

  func testTransferTypeUsesTheFileExtensionAndFallsBackWithoutInventingAType() {
    XCTAssertEqual(
      FilePreviewResource.typeDescription("report.PDF"), UTType.pdf.localizedDescription)
    XCTAssertEqual(
      FilePreviewResource.typeDescription("image.png"), UTType.png.localizedDescription)
    XCTAssertEqual(
      FilePreviewResource.typeDescription("preview.html"), UTType.html.localizedDescription)
    XCTAssertEqual(FilePreviewResource.typeDescription("archive.qmunknown"), "QMUNKNOWN file")
    XCTAssertEqual(FilePreviewResource.typeDescription("README"), "File")
    XCTAssertEqual(FilePreviewResource.typeDescription(nil), "File")
  }

  func testSameNamedPreviewsAreIsolatedAndDeletedAfterRelease() throws {
    var first: TemporaryPreviewFile? = try TemporaryPreviewFile(
      data: Data("first".utf8), name: "../report.txt")
    let firstURL = try XCTUnwrap(first?.url)
    let second = try TemporaryPreviewFile(data: Data("second".utf8), name: "report.txt")
    XCTAssertNotEqual(firstURL.deletingLastPathComponent(), second.url.deletingLastPathComponent())
    XCTAssertEqual(firstURL.lastPathComponent, "report.txt")
    XCTAssertEqual(try Data(contentsOf: firstURL), Data("first".utf8))
    first = nil
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: firstURL.deletingLastPathComponent().path))
    XCTAssertEqual(try Data(contentsOf: second.url), Data("second".utf8))
  }
}
