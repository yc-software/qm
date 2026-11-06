import XCTest

@testable import QM

final class EventStreamDecoderTests: XCTestCase {
  func events(_ stream: String) -> [String] {
    var decoder = EventStreamDecoder()
    return Array(stream.utf8).compactMap { decoder.push($0) }.map {
      String(decoding: $0, as: UTF8.self)
    }
  }

  func testSingleLineEventsDispatchOnBlankLines() {
    XCTAssertEqual(
      events("id: 1\ndata: {\"a\":1}\n\nevent: run\ndata:{\"b\":2}\n\n"),
      [#"{"a":1}"#, #"{"b":2}"#])
  }

  func testMultiLineDataIsJoinedWithNewlines() {
    XCTAssertEqual(
      events("data: {\"text\":\ndata:  \"two\"}\ndata\n\n"),
      ["{\"text\":\n \"two\"}\n"])
  }

  func testCommentsOtherFieldsAndLineEndingsAreHandled() {
    XCTAssertEqual(
      events(": keepalive\r\n\r\nretry: 10\rdata: one\r\rdata: two\r\ndata: three\r\n\r\n"),
      ["one", "two\nthree"])
  }

  func testIncompleteTrailingEventIsNotDispatched() {
    XCTAssertEqual(events("data: done\n\ndata: partial\n"), ["done"])
  }
}
