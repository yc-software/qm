import SwiftUI

struct NativeWebhook: Decodable, Identifiable {
  struct Verification: Decodable {
    let scheme: String
    let secret: String?
  }
  struct Filter: Decodable, Hashable {
    let path: String
    let values: [String]
    enum CodingKeys: String, CodingKey {
      case path
      case values = "in"
    }
  }
  let id: String
  let action: String
  let verification: Verification
  let filters: [Filter]?
  let enabled: Bool
  let createdAt: Double
  let lastFiredAt: Double?
  let lastError: String?
  let url: String?
}
struct NativeWebhookList: Decodable { let webhooks: [NativeWebhook] }
struct NativeWebhookCreated: Decodable {
  let webhook: NativeWebhook
  let url: String
}
struct NativeWebhookEvent: Decodable {
  let receivedAt: Double
  let payload: String
  let sessionId: String?
}
struct NativeWebhookEvents: Decodable { let events: [NativeWebhookEvent] }

struct NativeWebhookScheme: Identifiable {
  let id: String
  let label: String
  let guidance: String
}

@MainActor @Observable
final class WebhooksModel {
  static let verificationSchemes = [
    NativeWebhookScheme(
      id: "hmac-sha256", label: "HMAC-SHA256", guidance: "Leave blank to generate a signing secret."
    ),
    NativeWebhookScheme(
      id: "github", label: "GitHub", guidance: "Leave blank to generate a signing secret."),
    NativeWebhookScheme(
      id: "slack", label: "Slack", guidance: "Use your Slack app signing secret."),
    NativeWebhookScheme(
      id: "stripe", label: "Stripe", guidance: "Use the endpoint signing secret from Stripe."),
    NativeWebhookScheme(
      id: "linear", label: "Linear", guidance: "Use the webhook signing secret shown by Linear."),
  ]
  let client: APIClient
  var webhooks: [NativeWebhook] = []
  var loaded = false
  var busy = false
  var error: String?
  private let loader = LoadGuard()
  var loading: Bool { loader.loading }
  init(client: APIClient) { self.client = client }
  func load(afterMutation: Bool = false) async {
    guard !busy || afterMutation else { return }
    await loader.run {
      try await client.fetch("api/webhooks") as NativeWebhookList
    } apply: { result in
      webhooks = result.webhooks
      loaded = true
      error = nil
    } failed: {
      error = $0.localizedDescription
    }
  }
  func setEnabled(_ webhook: NativeWebhook) async {
    guard !busy else { return }
    busy = true
    error = nil
    loader.cancel()
    defer { busy = false }
    do {
      let _: MutationReceipt = try await client.fetch(
        "api/webhooks/\(webhook.id.apiComponent)/\(webhook.enabled ? "disable" : "enable")",
        body: [:])
      await load(afterMutation: true)
    } catch { self.error = error.localizedDescription }
  }
  func create(action: String, scheme: String, secret: String, filters: String) async
    -> NativeWebhookCreated?
  {
    guard !busy else { return nil }
    busy = true
    error = nil
    loader.cancel()
    defer { busy = false }
    do {
      var verification = ["scheme": scheme]
      if !secret.isEmpty { verification["secret"] = secret }
      let result: NativeWebhookCreated = try await client.fetch(
        "api/webhooks",
        body: [
          "action": action, "verification": verification, "filters": try Self.parseFilters(filters),
        ])
      error = nil
      return result
    } catch {
      self.error = error.localizedDescription
      return nil
    }
  }
  static func parseFilters(_ text: String) throws -> [[String: Any]] {
    try text.split(separator: "\n").compactMap { raw in
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.isEmpty { return nil }
      guard let colon = line.firstIndex(of: ":") else {
        throw QMError.message("Use path: value1, value2 for each filter.")
      }
      let path = line[..<colon].trimmingCharacters(in: .whitespaces)
      let values = line[line.index(after: colon)...].split(separator: ",").map {
        $0.trimmingCharacters(in: .whitespaces)
      }.filter { !$0.isEmpty }
      guard !path.isEmpty, !values.isEmpty else {
        throw QMError.message("Every filter needs a path and at least one value.")
      }
      return ["path": path, "in": values]
    }
  }
}

struct NativeWebhooksView: View {
  let user: String
  @State private var model: WebhooksModel
  @State private var query = ""
  @State private var creating = false
  init(client: APIClient, user: String) {
    self.user = user
    _model = State(initialValue: WebhooksModel(client: client))
  }
  private var webhooks: [NativeWebhook] {
    model.webhooks
      .filter { query.isEmpty || $0.action.localizedCaseInsensitiveContains(query) }
      .sorted { $0.createdAt > $1.createdAt }
  }
  var body: some View {
    QMList {
      if let error = model.error { Text(error).foregroundStyle(.red) }
      ForEach(webhooks) { webhook in
        NavigationLink {
          NativeWebhookDetail(model: model, original: webhook, user: user)
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text(webhook.action).font(.headline).lineLimit(3)
            Text("\(webhook.verification.scheme) · \(webhook.enabled ? "Active" : "Disabled")")
              .font(.caption).foregroundStyle(.secondary)
          }.padding(.vertical, 6)
        }
      }
      if model.loading && !model.loaded && model.error == nil {
        NativeCollectionLoading(label: "Loading webhooks", symbol: "bolt.horizontal")
      } else if webhooks.isEmpty && !query.isEmpty && model.loaded && model.error == nil {
        ContentUnavailableView.search(text: query)
      } else if model.webhooks.isEmpty && model.loaded && model.error == nil {
        ContentUnavailableView(
          "No webhooks", systemImage: "bolt.horizontal",
          description: Text("Let incoming events trigger work in QM."))
      }
    }
    .navigationTitle("Webhooks").searchable(text: $query)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .toolbar { Button("New webhook", systemImage: "plus") { creating = true } }
    .modifier(
      NativeCollectionRefresh(
        active: model.loading && (model.loaded || model.error != nil) && !model.busy,
        label: "Refreshing webhooks")
    )
    .task { await model.load() }.refreshable { await model.load() }
    .sheet(
      isPresented: $creating, onDismiss: { Task { await model.load() } },
      content: {
        NativeWebhookCreation(model: model)
      })
  }
}

struct NativeWebhookDetail: View {
  @Bindable var model: WebhooksModel
  let original: NativeWebhook
  let user: String
  @State private var events: [NativeWebhookEvent] = []
  @State private var eventLoads = 0
  @State private var eventsLoaded = false
  @State private var expandedEvents = Set<Int>()
  @State private var error: String?
  private var webhook: NativeWebhook { model.webhooks.first { $0.id == original.id } ?? original }
  var body: some View {
    QMList {
      Section("Instructions") { Text(webhook.action).textSelection(.enabled) }
      Section("Endpoint") {
        if let url = webhook.url {
          Text(url).font(.footnote.monospaced()).textSelection(.enabled)
          ShareLink("Share URL", item: url)
        }
        LabeledContent("Signature", value: webhook.verification.scheme)
        LabeledContent("Status", value: webhook.enabled ? "Active" : "Disabled")
        if let last = webhook.lastFiredAt {
          LabeledContent("Last event", value: Date(timeIntervalSince1970: last / 1000).formatted())
        }
        if let error = webhook.lastError { Text(error).foregroundStyle(.red) }
        Button {
          Task { await model.setEnabled(webhook) }
        } label: {
          NativeActionLabel(
            title: webhook.enabled ? "Disable webhook" : "Enable webhook",
            busyTitle: "Updating…", busy: model.busy)
        }.disabled(model.busy)
        if let error = model.error { Text(error).foregroundStyle(.red) }
      }
      if let filters = webhook.filters, !filters.isEmpty {
        Section("Filters") {
          ForEach(filters, id: \.self) { filter in
            LabeledContent(filter.path, value: filter.values.joined(separator: ", "))
          }
        }
      }
      Section {
        if let error { Text(error).foregroundStyle(.red) }
        if eventLoads > 0 && !eventsLoaded && error == nil {
          NativeCollectionLoading(label: "Loading events", rows: 3)
        } else if events.isEmpty && eventsLoaded && error == nil {
          Text("No messages recorded yet.").foregroundStyle(.secondary)
        }
        ForEach(Array(events.enumerated()), id: \.offset) { offset, event in
          NativeDisclosureRow(expanded: expandedEvents.contains(offset)) {
            expandedEvents.formSymmetricDifference([offset])
          } label: {
            Text(Date(timeIntervalSince1970: event.receivedAt / 1000).formatted())
          }
          if expandedEvents.contains(offset) {
            Text(event.payload).font(.footnote.monospaced()).textSelection(.enabled)
            if let id = event.sessionId {
              NavigationLink("Open conversation") {
                NativeConversationDestination(client: model.client, user: user, sessionID: id)
              }
            }
          }
        }
        Button("Refresh events") { Task { await loadEvents() } }
      } header: {
        Text("Message history")
      } footer: {
        Text(
          "Latest 50 accepted events. Payloads show what was passed to QM, capped at 16,000 characters."
        )
      }
    }
    .navigationTitle("Webhook").navigationBarTitleDisplayMode(.inline)
    .scrollContentBackground(.hidden).background(QMTheme.paper)
    .modifier(
      NativeCollectionRefresh(
        active: (model.loading && !model.busy)
          || (eventLoads > 0 && (eventsLoaded || error != nil)),
        label: "Refreshing webhook")
    )
    .task { await loadEvents() }.refreshable {
      await model.load()
      await loadEvents()
    }
  }
  private func loadEvents() async {
    eventLoads += 1
    defer { eventLoads -= 1 }
    do {
      let result: NativeWebhookEvents = try await model.client.fetch(
        "api/webhooks/\(webhook.id.apiComponent)/events")
      try Task.checkCancellation()
      events = result.events
      eventsLoaded = true
      error = nil
    } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
  }
}

struct NativeWebhookCreation: View {
  @Bindable var model: WebhooksModel
  @Environment(\.dismiss) private var dismiss
  @State private var action = ""
  @State private var scheme = "hmac-sha256"
  @State private var secret = ""
  @State private var filters = ""
  @State private var created: NativeWebhookCreated?
  @State private var reveal = false
  var body: some View {
    NavigationStack {
      QMForm {
        if let created {
          Section("Webhook created") {
            Text("Copy the signing secret now. It will not be shown again.")
            Text(created.url).font(.footnote.monospaced()).textSelection(.enabled)
            ShareLink("Share URL", item: created.url)
            if let value = created.webhook.verification.secret, value != "***" {
              Button(reveal ? "Hide signing secret" : "Reveal signing secret") { reveal.toggle() }
              if reveal { Text(value).font(.footnote.monospaced()).textSelection(.enabled) }
              Button("Copy signing secret") {
                UIPasteboard.general.setItems(
                  [[UIPasteboard.typeAutomatic: value]],
                  options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
              }
            }
          }
        } else {
          Section("Instructions") {
            TextEditor(text: $action).frame(minHeight: 140)
            Text("What should QM do when an event arrives?").font(.caption)
          }
          Section("Verification") {
            Picker("Provider", selection: $scheme) {
              ForEach(WebhooksModel.verificationSchemes) {
                NativeServiceLabel(title: $0.label, service: $0.id).tag($0.id)
              }
            }
            SecureField("Signing secret (optional)", text: $secret).textInputAutocapitalization(
              .never
            ).autocorrectionDisabled()
            Text(
              WebhooksModel.verificationSchemes.first { $0.id == scheme }?.guidance
                ?? "Leave blank to generate a signing secret."
            ).font(.caption)
          }
          Section("Filters (optional)") {
            TextEditor(text: $filters).font(.body.monospaced()).frame(minHeight: 100)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
            Text("One filter per line: path: value1, value2").font(.caption)
          }
          if let error = model.error { Text(error).foregroundStyle(.red) }
        }
      }
      .disabled(model.busy).navigationTitle(created == nil ? "New webhook" : "Webhook ready")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(created == nil ? "Cancel" : "Done") { dismiss() }.disabled(model.busy)
        }
        if created == nil {
          ToolbarItem(placement: .confirmationAction) {
            Button {
              Task {
                created = await model.create(
                  action: action.trimmingCharacters(in: .whitespacesAndNewlines), scheme: scheme,
                  secret: secret.trimmingCharacters(in: .whitespacesAndNewlines), filters: filters)
                if created != nil { secret = "" }
              }
            } label: {
              NativeActionLabel(
                title: "Create", busyTitle: "Creating…", busy: model.busy, compact: true)
            }
            .disabled(model.busy || action.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
      }.interactiveDismissDisabled(model.busy || created != nil)
    }
  }
}
