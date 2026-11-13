import XCTest

@testable import QM

final class StreamTests: XCTestCase {
  func event(_ json: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
  }

  func testUTF16OffsetsAndDuplicateDeltas() throws {
    var text = StreamText()
    try text.apply(
      event(#"{"type":"CUSTOM","name":"run","value":{"status":"running","partial":"Hi 👋"}}"#))
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":5,"delta":" there"}}"#))
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":5,"delta":" there"}}"#))
    XCTAssertEqual(text.text, "Hi 👋 there")
    XCTAssertThrowsError(
      try text.apply(
        event(#"{"type":"CUSTOM","name":"delta","value":{"offset":100,"delta":"gap"}}"#)))
  }

  func testReconnectSnapshotReplacesPartialAndFinishes() throws {
    var text = StreamText()
    try text.apply(event(#"{"type":"CUSTOM","name":"delta","value":{"offset":0,"delta":"old"}}"#))
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"partial":"authoritative","status":"done","result":{"status":"ok","reply":"authoritative"}}}"#
      ))
    XCTAssertEqual(text.text, "authoritative")
  }

  func testOverlappingReplayAfterUnicodeSnapshotAppendsOnlyNewText() throws {
    var text = StreamText()
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","partial":"👋 hello"}}"#))
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":3,"delta":"hello world 🌍"}}"#))
    XCTAssertEqual(text.text, "👋 hello world 🌍")
    try text.apply(
      event(#"{"type":"CUSTOM","name":"run","value":{"status":"running","partial":"new"}}"#))
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":3,"delta":" answer"}}"#))
    XCTAssertEqual(text.text, "new answer")
  }

  func testRetainedTailUsesAbsoluteUTF16Offsets() throws {
    var text = StreamText()
    let tail = String(repeating: "x", count: 99_998) + "👋"
    let snapshot = try JSONSerialization.data(withJSONObject: [
      "type": "CUSTOM", "name": "run",
      "value": [
        "status": "running", "attempt": 1, "partial": tail, "partialStartOffset": 100_001,
      ],
    ])
    try text.apply(JSONDecoder().decode(StreamEvent.self, from: snapshot))
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"delta","value":{"offset":200001,"startOffset":100001,"delta":" more"}}"#
      ))
    let replay = try event(
      #"{"type":"CUSTOM","name":"delta","value":{"offset":199999,"startOffset":100001,"delta":"👋 more text"}}"#
    )
    try text.apply(replay)
    try text.apply(replay)
    XCTAssertEqual(text.text, tail + " more text")
    XCTAssertThrowsError(
      try text.apply(
        event(
          #"{"type":"CUSTOM","name":"delta","value":{"offset":300000,"startOffset":100001,"delta":"gap"}}"#
        )))
    XCTAssertEqual(text.text, tail + " more text")
  }

  func testDeltaAdvancesRetainedWindowWithoutTreatingItAsALostFrame() throws {
    var text = StreamText()
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":1,"partial":"AB👩","partialStartOffset":100}}"#
      ))
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"delta","value":{"offset":104,"startOffset":102,"delta":"🏽‍💻"}}"#
      ))
    XCTAssertEqual(text.text, "👩🏽‍💻")
    let advanced = try event(
      #"{"type":"CUSTOM","name":"delta","value":{"offset":120,"startOffset":120,"delta":"next"}}"#
    )
    try text.apply(advanced)
    try text.apply(advanced)
    XCTAssertEqual(text.text, "next")
    XCTAssertThrowsError(
      try text.apply(
        event(
          #"{"type":"CUSTOM","name":"delta","value":{"offset":126,"startOffset":120,"delta":"gap"}}"#
        )))
    XCTAssertEqual(text.text, "next")
  }

  func testNewAttemptWithoutPartialClearsPreviousTextAndCursor() throws {
    var text = StreamText()
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":1,"partial":"STALE ANSWER FROM ATTEMPT ONE"}}"#
      ))
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":2,"result":null}}"#
      ))
    XCTAssertEqual(text.text, "")
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":0,"delta":"NEW"}}"#))
    XCTAssertEqual(text.text, "NEW")
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":2,"result":null}}"#
      ))
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":0,"delta":"NEW TEXT"}}"#))
    XCTAssertEqual(text.text, "NEW TEXT")
  }

  func testNewAttemptReplacesRetainedOriginAndFinalReplyRestoresFullText() throws {
    var text = StreamText()
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":1,"partial":"old","partialStartOffset":100}}"#
      ))
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":2,"partial":"é","partialStartOffset":500}}"#
      ))
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"delta","value":{"offset":502,"startOffset":500,"delta":"!"}}"#
      ))
    XCTAssertEqual(text.text, "e\u{301}!")
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"done","attempt":2,"partial":"é!","partialStartOffset":500,"result":{"status":"ok","reply":"Full answer é!"}}}"#
      ))
    XCTAssertEqual(text.text, "Full answer e\u{301}!")
  }

  func testSameAttemptWithoutPartialPreservesTextAndReplayCursor() throws {
    var text = StreamText()
    try text.apply(
      event(
        #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":1,"partial":"Hi 👋"}}"#
      ))
    for snapshot in [
      #"{"type":"CUSTOM","name":"run","value":{"status":"running","attempt":1,"result":null}}"#,
      #"{"type":"CUSTOM","name":"run","value":{"status":"running","result":null}}"#,
    ] {
      try text.apply(event(snapshot))
      XCTAssertEqual(text.text, "Hi 👋")
    }
    let replay = try event(
      #"{"type":"CUSTOM","name":"delta","value":{"offset":3,"delta":"👋 there"}}"#)
    try text.apply(replay)
    try text.apply(replay)
    XCTAssertEqual(text.text, "Hi 👋 there")
  }

  @MainActor
  func testDeploymentURLValidation() {
    XCTAssertTrue(AppModel.allowedURL(URL(string: "https://qm.example.com")!))
    for value in [
      "https://user:password@qm.example.com", "https://qm.example.com/path",
      "https://qm.example.com?redirect=evil", "http://qm.example.com",
    ] {
      XCTAssertFalse(AppModel.allowedURL(URL(string: value)!))
    }
  }

  func testPendingSendSurvivesRelaunchWithoutChangingItsIdentity() throws {
    let account = "test-\(UUID())"
    defer { DraftStore.removeAccount(account) }
    let store = DraftStore(account: account, thread: "web:test:thread")
    let pending = PendingSend(text: "Run the report", idempotencyKey: UUID().uuidString)
    try store.write(.init(text: pending.text, pending: pending))
    let restored = DraftStore(account: account, thread: "web:test:thread").read()
    XCTAssertEqual(restored.pending?.idempotencyKey, pending.idempotencyKey)
    XCTAssertEqual(restored.text, pending.text)
    XCTAssertEqual(
      DraftStore(account: account + "different", thread: "web:test:thread").read().text, "")
  }
}
