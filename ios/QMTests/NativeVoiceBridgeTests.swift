import Foundation
import XCTest

@testable import QM

final class NativeVoiceBridgeTests: XCTestCase {
  private func heard(_ text: String, _ start: Double, _ end: Double) -> [String: Any] {
    ["type": "session.input_transcript.delta", "delta": text, "start_ms": start, "end_ms": end]
  }
  private func said(_ text: String, _ start: Double) -> [String: Any] {
    [
      "type": "session.output_transcript.delta", "delta": text, "start_ms": start,
      "end_ms": start + 100,
    ]
  }
  private func delegated(_ id: String, _ offset: Double) -> [String: Any] {
    [
      "type": "session.delegation.created", "offset_ms": offset,
      "delegation": ["id": id, "type": "delegation", "target": "client"],
    ]
  }
  private func parsed(_ json: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }
  private func request(_ words: String, exchange: String = "") -> String {
    NativeVoiceBridge.requestPrefix + words
      + (exchange.isEmpty ? "" : NativeVoiceBridge.exchangeMark + exchange)
      + NativeVoiceBridge.spokenNote
  }

  func testDelegationSilencesTheFillerAndWaitsForTheLastWords() throws {
    var bridge = NativeVoiceBridge()
    XCTAssertEqual(bridge.receive(heard("Check my", 0, 400), now: 0), [])
    XCTAssertEqual(bridge.receive(delegated("d1", 900), now: 1), [])
    let silence = bridge.takeOutgoing(canSend: true)
    XCTAssertEqual(silence.count, 1)
    XCTAssertEqual(silence[0]["type"] as? String, "session.thinking.append")
    XCTAssertEqual(silence[0]["delegation_id"] as? String, "d1")
    XCTAssertEqual(silence[0]["content"] as? String, "")
    XCTAssertNotNil(silence[0]["event_id"] as? String)
    XCTAssertEqual(
      bridge.receive(heard(" open loops", 400, 900), now: 1.1),
      [.submit(text: request("Check my open loops"), delegation: "d1")])
    XCTAssertEqual(bridge.tick(now: 5), [])
  }

  func testDelegationGoesAheadAfterTheSettleDelay() throws {
    var bridge = NativeVoiceBridge()
    _ = bridge.receive(heard("Summarize today", 0, 500), now: 0)
    XCTAssertEqual(bridge.receive(delegated("d1", 2000), now: 1), [])
    XCTAssertEqual(bridge.tick(now: 1.2), [])
    XCTAssertEqual(
      bridge.tick(now: 1.4), [.submit(text: request("Summarize today"), delegation: "d1")])
  }

  func testWireNumbersParsedFromJSONAreAccepted() throws {
    var bridge = NativeVoiceBridge()
    _ = bridge.receive(
      try parsed(
        #"{"type":"session.input_transcript.delta","delta":"Hi there","start_ms":0,"end_ms":300}"#),
      now: 0)
    XCTAssertEqual(
      bridge.receive(
        try parsed(
          #"{"type":"session.delegation.created","offset_ms":300,"delegation":{"id":"d1","type":"delegation","target":"client"}}"#
        ), now: 0.5),
      [.submit(text: request("Hi there"), delegation: "d1")])
  }

  func testRequestCarriesTheSpokenExchangeAndOnlyNewWords() {
    var bridge = NativeVoiceBridge()
    _ = bridge.receive(heard("Draft an email", 0, 800), now: 0)
    _ = bridge.receive(said("Who should it go to?", 1000), now: 1)
    _ = bridge.receive(heard("To the team", 3000, 3600), now: 3)
    XCTAssertEqual(
      bridge.receive(delegated("d1", 3600), now: 4),
      [
        .submit(
          text: request(
            "To the team",
            exchange: "- User: Draft an email\n- You (voice): Who should it go to?"),
          delegation: "d1")
      ])
    bridge.finish(run: nil, delegation: "d1", status: "ok", reply: "Sent.", reason: nil)
    _ = bridge.receive(heard("Thanks", 9000, 9300), now: 9)
    XCTAssertEqual(
      bridge.receive(delegated("d2", 9300), now: 10),
      [.submit(text: request("Thanks"), delegation: "d2")])
  }

  func testWorkingRunIsSteeredWithEveryHandOff() {
    var bridge = NativeVoiceBridge()
    bridge.started(run: "run1", delegation: "d0")
    bridge.progress("Searching Slack", run: "run1")
    _ = bridge.takeOutgoing(canSend: true)
    _ = bridge.receive(heard("Also include email", 0, 500), now: 0)
    XCTAssertEqual(
      bridge.receive(delegated("d1", 500), now: 1),
      [.steer(text: request("Also include email"), delegation: "d1", remark: false)])
    _ = bridge.receive(heard("How's it going?", 1000, 1500), now: 2)
    XCTAssertEqual(
      bridge.receive(delegated("d2", 1500), now: 2.5),
      [.steer(text: request("How's it going?"), delegation: "d2", remark: false)])
  }

  func testWordsNotHandedOffWhileWorkingBecomeARemark() {
    var bridge = NativeVoiceBridge()
    bridge.started(run: "run1", delegation: "d0")
    _ = bridge.receive(heard("Use the newer draft", 0, 900), now: 10)
    XCTAssertEqual(bridge.tick(now: 13), [])
    XCTAssertEqual(
      bridge.tick(now: 13.6),
      [
        .steer(
          text: NativeVoiceBridge.remarkPrefix + "Use the newer draft", delegation: "d0",
          remark: true)
      ])
    XCTAssertEqual(bridge.tick(now: 20), [])
    _ = bridge.takeOutgoing(canSend: true)
    XCTAssertEqual(bridge.receive(delegated("d1", 900), now: 21), [])
    XCTAssertEqual(
      bridge.takeOutgoing(canSend: true).last?["content"] as? String,
      "Already added to the running task.")
  }

  func testResultsAreSpokenForTheirDelegationWithoutClaimingUnconfirmedWork() {
    var bridge = NativeVoiceBridge()
    bridge.started(run: "run1", delegation: "d1")
    _ = bridge.receive(heard("thanks", 0, 300), now: 0)
    _ = bridge.takeOutgoing(canSend: true)
    bridge.finish(
      run: "run1", status: "ok",
      reply: "Done, see [the doc](https://example.com/a) at https://example.com/b.",
      reason: nil)
    XCTAssertFalse(bridge.busy)
    let events = bridge.takeOutgoing(canSend: true)
    XCTAssertEqual(
      events.map { $0["type"] as? String },
      ["session.thinking.append", "session.commentary.append"])
    XCTAssertTrue((events[0]["content"] as? String)?.contains("did not reach the task") == true)
    XCTAssertEqual(events[1]["delegation_id"] as? String, "d1")
    XCTAssertEqual(events[1]["content"] as? String, "Done, see the doc at (link)")

    bridge.observe(run: "run2")
    bridge.finish(run: "run2", status: "pending_approval", reply: "Done", reason: nil)
    let approval = bridge.takeOutgoing(canSend: true)
    XCTAssertTrue(approval[0]["delegation_id"] is NSNull)
    XCTAssertEqual(approval[0]["content"] as? String, NativeVoiceBridge.approval)

    bridge.observe(run: "run3")
    bridge.finish(run: "run3", status: "silent", reply: nil, reason: nil)
    XCTAssertTrue(bridge.outgoing.isEmpty)
    XCTAssertEqual(
      NativeVoiceBridge.result(status: "failed", reply: "Done", reason: "Denied", requested: true),
      "QM could not finish: Denied")
    XCTAssertEqual(
      NativeVoiceBridge.result(status: "ok", reply: " ", reason: nil, requested: true),
      "QM finished without a reply to read out. The details are in the QM conversation.")
  }

  func testOutgoingWaitsUntilAudioCanResumeAndEventIDsAreUnique() throws {
    var bridge = NativeVoiceBridge()
    bridge.unconfirmed(delegation: "d1")
    bridge.say("One", delegation: nil)
    XCTAssertTrue(bridge.takeOutgoing(canSend: false).isEmpty)
    let events = bridge.takeOutgoing(canSend: true)
    XCTAssertEqual(events.count, 2)
    XCTAssertEqual(Set(events.compactMap { $0["event_id"] as? String }).count, 2)
    XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: events))
    XCTAssertTrue(bridge.takeOutgoing(canSend: true).isEmpty)
    XCTAssertNotEqual(
      bridge.event("session.input_audio.mute")["event_id"] as? String,
      events[1]["event_id"] as? String)
  }

  func testAppendsAndBriefingStayBounded() throws {
    let long = String(repeating: "word ", count: 2000)
    XCTAssertLessThan(NativeVoiceBridge.spoken(long).count, long.count / 4)
    XCTAssertEqual(NativeVoiceBridge.clip("short text", tokens: 400), "short text")
    let messages = (0..<200).map { (user: $0 % 2 == 0, text: "Message \($0) " + long) }
    let briefing = try XCTUnwrap(NativeVoiceBridge.briefing(messages, working: true))
    XCTAssertLessThan(briefing.count, 6300)
    XCTAssertTrue(briefing.contains("Message 199"))
    XCTAssertFalse(briefing.contains("Message 0 "))
    XCTAssertTrue(briefing.hasSuffix("QM is working on a request in this conversation right now."))
    XCTAssertNil(NativeVoiceBridge.briefing([], working: false))
  }

  func testRepeatedHandOffWithoutNewWordsIsNotSubmittedAgain() {
    var bridge = NativeVoiceBridge()
    _ = bridge.receive(heard("Send the email", 0, 600), now: 0)
    XCTAssertEqual(
      bridge.receive(delegated("d1", 600), now: 1),
      [.submit(text: request("Send the email"), delegation: "d1")])
    XCTAssertEqual(bridge.receive(delegated("d2", 600), now: 1.1), [])
    XCTAssertEqual(
      bridge.takeOutgoing(canSend: true).last?["content"] as? String,
      "That request is already with QM; its result arrives as an update.")
    bridge.finish(run: nil, delegation: "d1", status: "ok", reply: "Sent.", reason: nil)
    _ = bridge.takeOutgoing(canSend: true)
    XCTAssertEqual(bridge.receive(delegated("d3", 600), now: 9), [])
    XCTAssertEqual(
      bridge.takeOutgoing(canSend: true).last?["content"] as? String,
      "No request was heard for this hand-off; ask the user to repeat it.")
  }

  func testUnconfirmedSteerDoesNotTakeOverTheRunningResult() {
    var bridge = NativeVoiceBridge()
    bridge.started(run: "run1", delegation: "d0")
    _ = bridge.receive(heard("Also do B", 0, 500), now: 0)
    _ = bridge.receive(delegated("d2", 500), now: 1)
    _ = bridge.takeOutgoing(canSend: true)
    bridge.finish(run: "run1", status: "ok", reply: "A is done.", reason: nil)
    XCTAssertEqual(bridge.takeOutgoing(canSend: true).last?["delegation_id"] as? String, "d0")
  }

  func testQueuedRunStaysActiveAfterTheEarlierRunFinishes() {
    var bridge = NativeVoiceBridge()
    bridge.observe(run: "other")
    bridge.started(run: "mine", delegation: "d1")
    XCTAssertEqual(bridge.activeRun, "other")
    _ = bridge.takeOutgoing(canSend: true)
    bridge.finish(run: "other", status: "failed", reply: nil, reason: "Stopped")
    XCTAssertEqual(bridge.activeRun, "mine")
    XCTAssertTrue(bridge.busy)
  }
}
