import XCTest

@testable import QM

final class RuntimeControlsTests: XCTestCase {
  private func configuration() throws -> RuntimeConfiguration {
    try JSONDecoder().decode(
      RuntimeConfiguration.self,
      from: Data(
        #"{"scopeId":"personal:alice","approvedHarnesses":["pi","codex","other"],"modelsByHarness":{"pi":["dynamic","dynamic","missing","mismatch"],"codex":["dynamic"],"other":[]},"modelCatalog":{"dynamic":{"id":"dynamic","label":"New server model","provider":"openai","reasoning":true},"mismatch":{"id":"different","label":"Wrong model"}},"orgDefault":{"harnessId":"pi","modelId":"dynamic"},"scopeOverride":null,"effective":{"harnessId":"pi","modelId":"dynamic","effortLevel":"ultracode","fastMode":true},"fastModeModelIds":["dynamic"]}"#
          .utf8))
  }

  func testOnlyAdvertisedModelsWithMatchingMetadataAreSelectable() throws {
    let config = try configuration()
    XCTAssertEqual(config.harnesses, ["pi", "codex"])
    XCTAssertEqual(config.models(for: "pi"), ["dynamic"])
    XCTAssertEqual(config.modelCatalog["dynamic"]?.label, "New server model")
  }

  func testSwitchingHarnessRemovesUnsupportedEffortAndFastMode() throws {
    let config = try configuration()
    var draft = RuntimeDraft(config.effective)
    draft.harness = "codex"
    draft.normalize(using: config)
    XCTAssertEqual(draft.effort, "auto")
    XCTAssertTrue(draft.fast)
    draft.harness = "opencode"
    draft.normalize(using: config)
    XCTAssertFalse(draft.fast)
    XCTAssertEqual(RuntimeDraft.efforts(for: "opencode"), ["auto"])
  }

  func testSwitchingModelClearsUnsupportedFastMode() throws {
    let config = try configuration()
    var draft = RuntimeDraft(config.effective)
    draft.model = "not-fast"
    draft.normalize(using: config)
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
    XCTAssertEqual(body["effortLevel"] as? String, "ultracode")
  }
  func testAdvertisedProviderEffortsOverrideLegacyHarnessList() throws {
    let data = Data(
      #"{"scopeId":"personal:test","approvedHarnesses":["claude"],"modelsByHarness":{"claude":["model"]},"modelCatalog":{"model":{"id":"model","label":"Model","effortLevelsByHarness":{"claude":["adaptive","low","high"]}}},"orgDefault":{"harnessId":"claude","modelId":"model"},"effective":{"harnessId":"claude","modelId":"model","effortLevel":"adaptive"}}"#
        .utf8)
    let config = try JSONDecoder().decode(RuntimeConfiguration.self, from: data)
    XCTAssertEqual(
      config.efforts(harness: "claude", model: "model"), ["auto", "adaptive", "low", "high"])
    var draft = RuntimeDraft(config.effective)
    draft.normalize(using: config)
    XCTAssertEqual(draft.effort, "adaptive")
    draft.effort = "max"
    draft.normalize(using: config)
    XCTAssertEqual(draft.effort, "auto")
  }

  func testConversationSelectionUsesTurnOptionsWithoutScopeMutation() {
    let selected = RuntimeSelection(
      harnessId: "codex", modelId: "chosen", effortLevel: "high", fastMode: false)
    XCTAssertEqual(selected.turnOptions["model"] as? String, "chosen")
    XCTAssertEqual(selected.turnOptions["harness"] as? String, "codex")
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
