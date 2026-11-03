import XCTest

@testable import QM

final class NativeAdminModelTests: XCTestCase {
  private func configuration() throws -> NativeAdminModelConfiguration {
    try JSONDecoder().decode(
      NativeAdminModelConfiguration.self,
      from: Data(
        #"{"runtime":{"harnessId":"pi","modelId":"fast","effortLevel":"max","fastMode":true},"baseModelDefault":"base","harnessDefault":"pi","harnessOptions":["pi","codex"],"modelsByHarness":{"pi":[{"id":"fast","name":"Fast"}],"codex":[{"id":"other","name":"Other"}]},"thinkingLevelsByHarness":{"pi":["auto","max"],"codex":["auto","high"]},"fastModeModelIds":["fast"],"fastModeHarnessIds":["pi"],"browseModelOptions":[],"webuiModels":["unavailable","fast"]}"#
          .utf8))
  }
  func testChangingRuntimeNormalizesUnsupportedModelEffortAndFastMode() throws {
    let config = try configuration()
    var draft = NativeAdminRuntimeDraft(config)
    draft.harness = "codex"
    draft.changedHarness(config)
    XCTAssertEqual(draft.model, "other")
    XCTAssertEqual(draft.effort, "auto")
    XCTAssertFalse(draft.fast)
    let body = try draft.payload(config)
    XCTAssertEqual(body["harnessId"] as? String, "codex")
    XCTAssertEqual(body["modelId"] as? String, "other")
    XCTAssertEqual(body["fastMode"] as? Bool, false)
  }
  func testInheritClearsSelectionWithoutSendingStaleFields() throws {
    let config = try configuration()
    var draft = NativeAdminRuntimeDraft(config)
    draft.inherit = true
    let body = try draft.payload(config)
    XCTAssertEqual(body.count, 1)
    XCTAssertEqual(body["inherit"] as? Bool, true)
  }
  func testUnavailableModelCannotBeSavedAsRuntime() throws {
    let config = try configuration()
    var draft = NativeAdminRuntimeDraft(config)
    draft.model = "missing"
    XCTAssertThrowsError(try draft.payload(config))
    XCTAssertEqual(config.webuiModels, ["unavailable", "fast"])
  }
  func testLegacyBaseModelIsAnOverrideThatCanBeCleared() throws {
    let data = try JSONEncoder().encode(["baseModel": "legacy"])
    var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    object.merge([
      "baseModelDefault": "default", "harnessDefault": "pi", "harnessOptions": ["pi"],
      "modelsByHarness": [:], "thinkingLevelsByHarness": [:], "fastModeModelIds": [],
      "fastModeHarnessIds": [], "browseModelOptions": [],
    ]) { _, next in next }
    let config = try JSONDecoder().decode(
      NativeAdminModelConfiguration.self, from: JSONSerialization.data(withJSONObject: object))
    var draft = NativeAdminRuntimeDraft(config)
    XCTAssertFalse(draft.inherit)
    XCTAssertEqual(draft.model, "legacy")
    draft.inherit = true
    XCTAssertEqual(try draft.payload(config)["inherit"] as? Bool, true)
  }
  func testDisabledProviderRequiresExplicitReactivation() throws {
    let provider = NativeCustomProvider(
      id: "private", name: "Private", protocol: "openai", baseUrl: "https://provider.example",
      models: [.init(id: "model")], disabled: true, hasKey: true)
    XCTAssertThrowsError(try provider.requireActivationConsent(false))
    XCTAssertNoThrow(try provider.requireActivationConsent(true))
    let enabled = NativeCustomProvider(
      id: "private", name: "Private", protocol: "openai", baseUrl: "https://provider.example",
      models: [.init(id: "model")], disabled: false, hasKey: true)
    XCTAssertNoThrow(try enabled.requireActivationConsent(false))
  }
  func testRegistryVerificationPreservesTierPricesAndAvailabilityFlags() throws {
    let source =
      #"{"id":"custom","name":"Custom","provider":"anthropic","template":"template","contextWindow":200000,"maxTokens":10000,"cost":{"input":1,"output":2,"cacheRead":0.1,"cacheWrite":1.2,"tiers":[{"inputTokensAbove":100000,"input":3,"output":4,"cacheRead":0.3,"cacheWrite":3.2}]},"fastMode":true,"base":false,"webui":false,"auxiliary":true}"#
    var spec = try JSONDecoder().decode(NativeRegistrySpec.self, from: Data(source.utf8))
    spec.name = "Renamed"
    let payload = try spec.verifiedPayload()
    XCTAssertEqual(payload["verify"] as? Bool, true)
    XCTAssertEqual(payload["base"] as? Bool, false)
    XCTAssertEqual(payload["webui"] as? Bool, false)
    XCTAssertEqual(payload["auxiliary"] as? Bool, true)
    let cost = try XCTUnwrap(payload["cost"] as? [String: Any])
    let tiers = try XCTUnwrap(cost["tiers"] as? [[String: Any]])
    XCTAssertEqual(tiers.first?["cacheWrite"] as? Double, 3.2)
    spec.cost?.tiers?.append(
      .init(inputTokensAbove: 90000, input: 1, output: 1, cacheRead: 1, cacheWrite: 1))
    XCTAssertThrowsError(try spec.verifiedPayload())
    spec.cost?.tiers = nil
    spec.cost?.input = nil
    XCTAssertThrowsError(try spec.verifiedPayload())
  }

  func testMCPEditsPreserveDisabledReadOnlyAndStoredSecrets() throws {
    let original = NativeMCPServer(
      id: "test", name: "Test", url: "https://tools.example/mcp", auth: "client-credentials",
      credentialScope: "per-user", credentialHost: "api.example", credentialAccountType: "company",
      clientId: "client", readOnly: false, enabled: false, hasBearerToken: false,
      hasClientSecret: true)
    var draft = NativeMCPDraft(original)
    draft.server.name = "Renamed"
    let body = try draft.payload()
    XCTAssertEqual(body["enabled"] as? Bool, false)
    XCTAssertEqual(body["readOnly"] as? Bool, false)
    XCTAssertEqual(body["credentialAccountType"] as? String, "company")
    XCTAssertEqual(body["clientId"] as? String, "client")
    XCTAssertNil(body["clientSecret"])
    draft.server.url = "https://user:password@tools.example/mcp"
    XCTAssertThrowsError(try draft.payload())
    draft.server.url = "https://tools.example/mcp?key=secret"
    XCTAssertThrowsError(try draft.payload())
  }

}
