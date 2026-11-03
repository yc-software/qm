import XCTest

@testable import QM

final class StreamTests: XCTestCase {
  func event(_ json: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
  }

  func testUTF16OffsetsAndDuplicateDeltas() throws {
    var text = StreamText()
    try text.apply(event(#"{"type":"CUSTOM","name":"run","value":{"partial":"Hi 👋"}}"#))
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
    try text.apply(event(#"{"type":"CUSTOM","name":"run","value":{"partial":"👋 hello"}}"#))
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":3,"delta":"hello world 🌍"}}"#))
    XCTAssertEqual(text.text, "👋 hello world 🌍")
    try text.apply(event(#"{"type":"CUSTOM","name":"run","value":{"partial":"new"}}"#))
    try text.apply(
      event(#"{"type":"CUSTOM","name":"delta","value":{"offset":3,"delta":" answer"}}"#))
    XCTAssertEqual(text.text, "new answer")
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
