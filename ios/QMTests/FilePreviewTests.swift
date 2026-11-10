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
