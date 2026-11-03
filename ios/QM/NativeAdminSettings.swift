import SwiftUI

struct NativeAdminConfiguration: Decodable {
  struct ApprovalModes: Codable, Equatable {
    var session: Bool
    var always: Bool
  }
  struct Egress: Codable, Equatable {
    var allowedHosts: [String]
    var deniedHosts: [String]
  }
  struct Branding: Codable, Equatable {
    var accent: String?
    var mark: String?
    var markUrl: String?
    var selfLabel: String?
    var orgName: String?
  }
  struct Command: Codable, Equatable {
    struct Rule: Codable, Equatable {
      var pattern: String
      var decision: String
      var reason: String?
    }
    var mode: String
    var rules: [Rule]
  }
  let securityPosture: String?
  let sharingPosture: String?
  let sharingPostureOverride: String?
  let approvalGrantModes: ApprovalModes?
  let commandPolicy: Command?
  let egress: Egress?
  let soul: String?
  let soulVersion: Int?
  let branding: Branding?
  let unfulfilledInsights: Bool?
  let externalSlackParticipants: Bool?
  let channelHeaderPinDefault: Bool?
  let orgAmbient: Bool?
  let interactiveFastMode: Bool?
  let individualModelAuth: Bool?
  let internalMemberOverrides: [String]?
  let ackEmoji: [String]?
  let turnWallClockSec: Int?
  let browseMaxSteps: Int?
}

enum NativeAdminSetting: String, CaseIterable, Identifiable {
  case security = "security-posture"
  case sharing = "sharing-posture"
  case approvals = "approval-grant-modes"
  case commands = "command-policy"
  case egress, soul, branding
  case insights = "unfulfilled-insights"
  case externalSlack = "external-slack-participants"
  case header = "channel-header-pin-default"
  case ambient = "org-ambient"
  case fast = "interactive-fast-mode"
  case individual = "individual-model-auth"
  case members = "internal-member-overrides"
  case emoji = "ack-emoji"
  case timeout = "turn-wall-clock"
  case steps = "browse-max-steps"
  var id: String { rawValue }
  var title: String {
    switch self {
    case .security: "Security posture"
    case .sharing: "Cross-context sharing"
    case .approvals: "Standing approvals"
    case .commands: "Command policy"
    case .egress: "Network access"
    case .soul: "Personality and instructions"
    case .branding: "Organization branding"
    case .insights: "Unfulfilled insights"
    case .externalSlack: "External Slack rooms"
    case .header: "Pinned channel headers"
    case .ambient: "Ambient behavior"
    case .fast: "Interactive fast mode"
    case .individual: "Individual model accounts"
    case .members: "Internal member overrides"
    case .emoji: "Acknowledgement emoji"
    case .timeout: "Turn time limit"
    case .steps: "Browser step limit"
    }
  }
  var organizationOnly: Bool {
    [
      .branding, .externalSlack, .header, .ambient, .fast, .individual, .members, .emoji, .timeout,
      .steps,
    ].contains(self)
  }
  var boolean: Bool {
    [.insights, .externalSlack, .header, .ambient, .fast, .individual].contains(self)
  }
  var explanation: String {
    switch self {
    case .security:
      "The organization sets the minimum posture. Narrower scopes may tighten it. Strict requires tool approval; Auto screens external input and blocks private networks; Dangerous disables those protections."
    case .sharing:
      "Open allows personally entitled sources from other contexts to inform replies here. Isolated restricts that cross-context access. The organization sets a ceiling."
    case .approvals:
      "Choose whether people may allow actions for the rest of a session or always. Disabling a mode also suspends existing grants of that mode until it is enabled again."
    case .commands:
      "Rules are evaluated in order and compose with the organization policy. Patterns are regular expressions. Organization restrictions still apply."
    case .egress:
      "Enter one host per line. Denied hosts take precedence over allowed hosts. Enforcement depends on the configured sandbox backend."
    case .soul:
      "Instructions for QM in this scope. Saving checks the loaded version to prevent overwriting newer edits."
    case .branding:
      "Appearance and names used across the organization. Empty values restore deployment defaults."
    case .insights: "Record insights about work QM could not fulfill."
    case .externalSlack:
      "Allow internal members to interact with QM in Slack rooms that include external users. External users still cannot interact."
    case .header:
      "Post and pin a model header in Slack channels unless a channel overrides this default."
    case .ambient:
      "When disabled, QM does not act on overheard messages anywhere in the organization."
    case .fast:
      "Use fast mode for human turns on supported models. Requires provider fast-mode quota."
    case .individual:
      "Require each person to connect their own model account before using QM. Shared organization model credentials will not be used for their turns."
    case .members:
      "One email or Slack user ID per line. These accounts are treated as internal even if Slack marks them as guests or the directory sync removed them."
    case .emoji: "One Slack emoji name per line."
    case .timeout:
      "Seconds per turn: 60–86400, or 0 for no limit. Leave empty to use the deployment default."
    case .steps: "Maximum browser steps per task: 1–500. Leave empty for the default of 50."
    }
  }
}

struct NativeAdminSettings: View {
  let client: APIClient
  let scope: String
  @State private var configuration: NativeAdminConfiguration?
  @State private var error: String?
  var body: some View {
    QMList {
      Text(scope).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      if let configuration {
        NavigationLink("Models and runtime") { NativeAdminModels(client: client, scope: scope) }
        if scope.hasPrefix("org:") {
          NavigationLink("Feature rollout") { NativeAdminFlags(client: client, scope: scope) }
          NavigationLink("Auto screening") { NativeAutoFlagger(client: client, scope: scope) }
        }
        ForEach(
          NativeAdminSetting.allCases.filter { !$0.organizationOnly || scope.hasPrefix("org:") }
        ) { setting in
          NavigationLink(setting.title) {
            NativeAdminSettingEditor(
              client: client, scope: scope, setting: setting, configuration: configuration)
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red) }
      if configuration == nil && error == nil { ProgressView() }
    }.navigationTitle("Governance and settings").navigationBarTitleDisplayMode(.inline)
      .task { await load() }.refreshable { await load() }
  }
  private func load() async {
    do {
      configuration = try await client.fetch("admin/api/scopes/\(scope.apiComponent)")
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

struct NativeAdminSettingDraft: Equatable {
  var choice = ""
  var text = ""
  var secondary = ""
  var enabled = false
  var session = true
  var always = true
  var brand = NativeAdminConfiguration.Branding()
  var command = NativeAdminConfiguration.Command(mode: "denylist", rules: [])
  init(_ setting: NativeAdminSetting, _ value: NativeAdminConfiguration) {
    switch setting {
    case .security: choice = value.securityPosture ?? "auto"
    case .sharing: choice = value.sharingPostureOverride ?? "inherit"
    case .approvals:
      session = value.approvalGrantModes?.session ?? true
      always = value.approvalGrantModes?.always ?? true
    case .commands: command = value.commandPolicy ?? .init(mode: "denylist", rules: [])
    case .egress:
      text = (value.egress?.allowedHosts ?? []).joined(separator: "\n")
      secondary = (value.egress?.deniedHosts ?? []).joined(separator: "\n")
    case .soul: text = value.soul ?? ""
    case .branding: brand = value.branding ?? .init()
    case .insights: enabled = value.unfulfilledInsights ?? false
    case .externalSlack: enabled = value.externalSlackParticipants ?? false
    case .header: enabled = value.channelHeaderPinDefault ?? false
    case .ambient: enabled = value.orgAmbient ?? false
    case .fast: enabled = value.interactiveFastMode ?? false
    case .individual: enabled = value.individualModelAuth ?? false
    case .members: text = (value.internalMemberOverrides ?? []).joined(separator: "\n")
    case .emoji: text = (value.ackEmoji ?? []).joined(separator: "\n")
    case .timeout: text = value.turnWallClockSec.map(String.init) ?? ""
    case .steps: text = value.browseMaxSteps.map(String.init) ?? ""
    }
  }
  static func lines(_ value: String) -> [String] {
    value.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter
    { !$0.isEmpty }
  }
  func payload(_ setting: NativeAdminSetting, version: Int?) throws -> [String: Any] {
    if setting.boolean { return ["on": enabled] }
    switch setting {
    case .security: return ["posture": choice]
    case .sharing: return choice == "inherit" ? ["inherit": true] : ["posture": choice]
    case .approvals: return ["session": session, "always": always]
    case .commands: return try object(command)
    case .egress: return ["allowedHosts": Self.lines(text), "deniedHosts": Self.lines(secondary)]
    case .soul:
      guard let version else {
        throw QMError.message(
          "Reload the instructions before saving; the current version is unavailable.")
      }
      return ["content": text, "expectedVersion": version]
    case .branding: return try object(brand)
    case .members: return ["members": Self.lines(text)]
    case .emoji: return ["names": Self.lines(text)]
    case .timeout: return ["sec": text]
    case .steps: return ["steps": text]
    default: throw QMError.message("Unsupported setting.")
    }
  }
  private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
    guard
      let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
        as? [String: Any]
    else {
      throw QMError.message("Could not encode this setting.")
    }
    return object
  }
}

struct NativeAdminSettingEditor: View {
  let client: APIClient
  let scope: String
  let setting: NativeAdminSetting
  let configuration: NativeAdminConfiguration
  @State private var draft: NativeAdminSettingDraft
  @State private var baseline: NativeAdminSettingDraft
  @State private var busy = false
  @State private var confirming = false
  @State private var discarding = false
  @State private var error: String?
  @State private var command = ""
  @State private var simulation: String?
  @Environment(\.dismiss) private var dismiss
  init(
    client: APIClient, scope: String, setting: NativeAdminSetting,
    configuration: NativeAdminConfiguration
  ) {
    self.client = client
    self.scope = scope
    self.setting = setting
    self.configuration = configuration
    var value = NativeAdminSettingDraft(setting, configuration)
    if setting == .sharing && scope.hasPrefix("org:") {
      value.choice = configuration.sharingPosture ?? "isolated"
    }
    _draft = State(initialValue: value)
    _baseline = State(initialValue: value)
  }
  private var missingCommandDefaults: Bool {
    setting == .commands && scope.hasPrefix("org:") && configuration.commandPolicy == nil
  }
  var body: some View {
    QMForm {
      Section {
        Text(scope).font(.caption).textSelection(.enabled)
        Text(setting.explanation).font(.subheadline).foregroundStyle(.secondary)
      }
      Section {
        if setting.boolean {
          Toggle("Enabled", isOn: $draft.enabled)
        } else {
          if missingCommandDefaults {
            Text(
              "This server did not provide the organization’s effective command rules. Update QM before editing this policy."
            )
          } else {
            fields
          }
        }
      }
      if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
    }.disabled(busy).navigationTitle(setting.title).navigationBarTitleDisplayMode(.inline)
      .navigationBarBackButtonHidden(draft != baseline || busy)
      .toolbar {
        if draft != baseline || busy {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { discarding = true }.disabled(busy)
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Apply") { confirming = true }.disabled(
            busy || draft == baseline || missingCommandDefaults)
        }
      }
      .confirmationDialog("Apply \(setting.title.lowercased())?", isPresented: $confirming) {
        Button("Apply to scope") { Task { await save() } }
      } message: {
        Text("This changes \(scope). \(setting.explanation)")
      }
      .confirmationDialog("Discard unsaved changes?", isPresented: $discarding) {
        Button("Discard", role: .destructive) { dismiss() }
      }
  }
  @ViewBuilder private var fields: some View {
    switch setting {
    case .security:
      Picker("Posture", selection: $draft.choice) {
        Text("Strict").tag("strict")
        Text("Auto").tag("auto")
        Text("Dangerous").tag("dangerous")
      }
    case .sharing:
      Picker("Access", selection: $draft.choice) {
        if !scope.hasPrefix("org:") { Text("Inherit").tag("inherit") }
        Text("Isolated").tag("isolated")
        Text("Open").tag("open")
      }
    case .approvals:
      Toggle("Allow session", isOn: $draft.session)
      Toggle("Allow always", isOn: $draft.always)
    case .commands:
      Picker("Mode", selection: $draft.command.mode) {
        Text("Denylist").tag("denylist")
        Text("Allowlist").tag("allowlist")
      }
      ForEach(draft.command.rules.indices, id: \.self) { index in
        VStack(alignment: .leading, spacing: 10) {
          TextField("Pattern", text: $draft.command.rules[index].pattern).font(
            .system(.body, design: .monospaced)
          ).autocorrectionDisabled().textInputAutocapitalization(.never)
          Picker("Decision", selection: $draft.command.rules[index].decision) {
            Text("Allow").tag("allow")
            Text("Deny").tag("deny")
            Text("Require approval").tag("require_approval")
          }
          TextField(
            "Reason",
            text: Binding(
              get: { draft.command.rules[index].reason ?? "" },
              set: { draft.command.rules[index].reason = $0 }))
          Button("Remove rule", role: .destructive) { draft.command.rules.remove(at: index) }
        }
      }.onMove { draft.command.rules.move(fromOffsets: $0, toOffset: $1) }
      Button("Add rule") {
        draft.command.rules.append(.init(pattern: "", decision: "require_approval", reason: ""))
      }
      EditButton()
      TextField("Command to test", text: $command, axis: .vertical).autocorrectionDisabled()
        .textInputAutocapitalization(.never)
      Button("Test draft policy") { Task { await simulate() } }.disabled(
        command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      if let simulation { Text(simulation).textSelection(.enabled) }
    case .egress:
      Text("Allowed hosts").font(.headline)
      TextEditor(text: $draft.text).frame(minHeight: 100).autocorrectionDisabled()
        .textInputAutocapitalization(.never)
      Text("Denied hosts").font(.headline)
      TextEditor(text: $draft.secondary).frame(minHeight: 100).autocorrectionDisabled()
        .textInputAutocapitalization(.never)
    case .branding:
      brandField("Organization name", \.orgName)
      brandField("Assistant name", \.selfLabel)
      brandField("Mark", \.mark)
      brandField("Mark image URL", \.markUrl)
      brandField("Accent hex color", \.accent)
    case .soul, .members, .emoji:
      TextEditor(text: $draft.text).frame(minHeight: 300).autocorrectionDisabled()
    case .timeout, .steps:
      TextField("Deployment default", text: $draft.text).keyboardType(.numberPad)
    default: EmptyView()
    }
  }
  private func brandField(
    _ title: String, _ key: WritableKeyPath<NativeAdminConfiguration.Branding, String?>
  ) -> some View {
    TextField(
      title,
      text: Binding(
        get: { draft.brand[keyPath: key] ?? "" }, set: { draft.brand[keyPath: key] = $0 })
    )
    .autocorrectionDisabled()
  }
  private func save() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)/\(setting.rawValue)",
        body: draft.payload(setting, version: configuration.soulVersion), method: "PUT")
      baseline = draft
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
  private func simulate() async {
    struct Result: Decodable {
      let decision: String
      let reason: String?
      let matched: String?
    }
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let result: Result = try await client.fetch(
        "admin/api/scopes/\(scope.apiComponent)/command-policy-simulate",
        body: ["command": command, "policy": try draft.payload(.commands, version: nil)],
        method: "PUT")
      simulation = [result.decision, result.reason, result.matched].compactMap { $0 }.joined(
        separator: "\n")
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}
