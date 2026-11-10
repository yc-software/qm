import UIKit
import XCTest

@testable import QM

final class MarkdownImageProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "portal_session=image-test")
    let declared = request.url!.path.contains("declared")
    let status = request.url!.path.contains("redirect") ? 302 : 200
    client?.urlProtocol(
      self,
      didReceive: HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: declared ? ["Content-Length": "100"] : [:])!,
      cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("0123456789".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@MainActor
final class MarkdownImagesTests: XCTestCase {
  func testOnlyCanonicalWorkspaceFileURLsAreAuthenticated() {
    let base = URL(string: "https://qm.example")!
    XCTAssertEqual(
      MarkdownImageResource.path(
        URL(string: "https://qm.example/api/files/abc-123/content")!, baseURL: base),
      "api/files/abc-123/content")
    for value in [
      "https://other.example/api/files/abc/content", "http://qm.example/api/files/abc/content",
      "https://qm.example:444/api/files/abc/content", "https://qm.example/api/admin/reset",
      "https://qm.example/api/files/abc/content?other=1", "file:///api/files/abc/content",
      "https://user@qm.example/api/files/abc/content", "https://qm.example/api/files/a%2Fb/content",
    ] {
      XCTAssertNil(MarkdownImageResource.path(URL(string: value)!, baseURL: base), value)
    }
  }

  func testThumbnailLimitsDecodedDimensions() throws {
    let data = UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 100)).pngData { context in
      UIColor.blue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 2400, height: 100))
    }
    let image = try MarkdownImageResource.thumbnail(data, maximumPixels: 128)
    XCTAssertLessThanOrEqual(image.width, 128)
    XCTAssertLessThanOrEqual(image.height, 128)
    XCTAssertThrowsError(
      try MarkdownImageResource.thumbnail(Data("not an image".utf8), maximumPixels: 128))
  }

  func testImageTransferRejectsDeclaredAndStreamingOversizeAndRedirects() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MarkdownImageProtocol.self]
    let client = APIClient(
      baseURL: URL(string: "https://\(UUID().uuidString).example")!, configuration: config)
    try client.saveSession("image-test")
    defer { client.signOut() }
    for path in ["declared", "streamed", "redirect"] {
      do {
        _ = try await client.imageData(path, maximumBytes: 4)
        XCTFail("Expected rejection for \(path)")
      } catch {}
    }
    let data = try await client.imageData("valid", maximumBytes: 10)
    XCTAssertEqual(String(decoding: data, as: UTF8.self), "0123456789")
  }
}
