import XCTest

@testable import QM

final class RuntimeControlsTests: XCTestCase {
  private func configuration() throws -> RuntimeConfiguration {
    try JSONDecoder().decode(
      RuntimeConfiguration.self,
      from: Data(
        #"{"scopeId":"personal:alice","models":["dynamic","plain"],"modelCatalog":{"dynamic":{"id":"dynamic","label":"New server model","provider":"openai","reasoning":true,"effortLevels":["auto","adaptive","low","high","max"]},"plain":{"id":"plain","label":"Plain","effortLevels":["auto","low"]}},"orgDefault":{"modelId":"dynamic","revision":3},"scopeOverride":null,"effective":{"modelId":"dynamic","effortLevel":"max","fastMode":true},"fastModeModelIds":["dynamic"]}"#
          .utf8))
  }

  func testModelsAndLabelsComeFromTheServer() throws {
    let config = try configuration()
    XCTAssertEqual(config.models, ["dynamic", "plain"])
    XCTAssertEqual(config.modelCatalog["dynamic"]?.label, "New server model")
  }

  func testEffortsComeFromTheModelCatalog() throws {
    let config = try configuration()
    XCTAssertEqual(config.efforts(model: "dynamic"), ["auto", "adaptive", "low", "high", "max"])
    XCTAssertEqual(config.efforts(model: "plain"), ["auto", "low"])
  }

  func testSwitchingModelRemovesUnsupportedEffortAndFastMode() throws {
    let config = try configuration()
    var draft = RuntimeDraft(config.effective)
    draft.normalize(using: config)
    XCTAssertEqual(draft.effort, "max")
    XCTAssertTrue(draft.fast)
    draft.model = "plain"
    draft.normalize(using: config)
    XCTAssertEqual(draft.effort, "auto")
    XCTAssertFalse(draft.fast)
  }

  func testSavedSelectionCarriesScopeAndExplicitFalseFastMode() throws {
    let config = try configuration()
    var draft = RuntimeDraft(config.effective)
    draft.fast = false
    let body = draft.body(scopeID: "channel:team")
    XCTAssertEqual(body["scopeId"] as? String, "channel:team")
    XCTAssertEqual(body["modelId"] as? String, "dynamic")
    XCTAssertEqual(body["fastMode"] as? Bool, false)
    XCTAssertEqual(body["effortLevel"] as? String, "max")
    XCTAssertNil(body["harnessId"])
  }

  func testConversationSelectionUsesTurnOptionsWithoutScopeMutation() {
    let selected = RuntimeSelection(modelId: "chosen", effortLevel: "high", fastMode: false)
    XCTAssertEqual(selected.turnOptions["model"] as? String, "chosen")
    XCTAssertNil(selected.turnOptions["harness"])
    XCTAssertEqual(selected.turnOptions["thinkingLevel"] as? String, "high")
    XCTAssertEqual(selected.turnOptions["fastMode"] as? Bool, false)
    XCTAssertNil(selected.turnOptions["scopeId"])
  }

  func testSkillCompletionOnlyReplacesTheTrailingSlashToken() {
    XCTAssertEqual(NativeSkillCompletion.query(in: "/"), "")
    XCTAssertEqual(NativeSkillCompletion.query(in: "Please use /summ"), "summ")
    XCTAssertEqual(NativeSkillCompletion.query(in: "Next line\n/check-it"), "check-it")
    XCTAssertNil(NativeSkillCompletion.query(in: "https://example.com/path"))
    XCTAssertNil(NativeSkillCompletion.query(in: "/skill already chosen"))
    XCTAssertNil(NativeSkillCompletion.query(in: "path/to/file"))
    XCTAssertEqual(
      NativeSkillCompletion.inserting("summarize", into: "Please use /summ"),
      "Please use /summarize ")
    XCTAssertEqual(
      NativeSkillCompletion.inserting("check", into: "Draft stays intact"),
      "/check Draft stays intact")
  }

}
