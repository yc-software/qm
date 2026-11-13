import SwiftUI

struct MemoryFact: Decodable, Identifiable, Equatable {
  let id: String
  let text: String
  let createdAt: Double
  var captured: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

struct MemoryFacts: Decodable { let facts: [MemoryFact] }

@MainActor @Observable
final class MemoryModel {
  let client: APIClient
  var facts: [MemoryFact] = []
  var query = ""
  var loaded = false
  var loading = false
  var saving = false
  var error: String?
  var busy: Bool { loading || saving }
  var visible: [MemoryFact] {
    facts.filter { query.isEmpty || $0.text.localizedCaseInsensitiveContains(query) }
  }

  init(client: APIClient) { self.client = client }

  func load() async {
    guard !busy else { return }
    loading = true
    defer { loading = false }
    await apply { try await client.fetch("api/memory") }
  }

  @discardableResult
  func edit(_ fact: MemoryFact, text: String) async -> Bool {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return false }
    return await change(["facts": [["id": fact.id, "text": text]]], method: "PATCH")
  }

  @discardableResult
  func forget(_ fact: MemoryFact) async -> Bool {
    await change(["ids": [fact.id]], method: "DELETE")
  }

  private func change(_ body: [String: Any], method: String) async -> Bool {
    guard !busy else { return false }
    saving = true
    defer { saving = false }
    return await apply { try await client.fetch("api/memory", body: body, method: method) }
  }

  private func apply(_ request: () async throws -> MemoryFacts) async -> Bool {
    do {
      let result = try await request()
      try Task.checkCancellation()
      facts = result.facts.sorted { $0.createdAt > $1.createdAt }
      loaded = true
      error = nil
      return true
    } catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
      return false
    }
  }
}

struct NativeMemoryView: View {
  @State private var model: MemoryModel
  @State private var editing: MemoryFact?
  @State private var forgetting: MemoryFact?
  init(client: APIClient) { _model = State(initialValue: MemoryModel(client: client)) }

  var body: some View {
    @Bindable var model = self.model
    QMList {
      QMPageHeading(title: "Memory", subtitle: "Facts QM remembers for your future conversations.")
      if let error = model.error {
        Text(error).foregroundStyle(.red)
        Button("Try again") { Task { await model.load() } }.disabled(model.busy)
      }
      if model.loading && !model.loaded && model.error == nil {
        NativeParagraphLoading(label: "Loading memory")
      } else if model.loaded && model.visible.isEmpty {
        if model.query.isEmpty {
          ContentUnavailableView(
            "Nothing remembered yet", systemImage: "book.closed",
            description: Text("QM notes facts here as you work together."))
        } else {
          ContentUnavailableView.search(text: model.query)
        }
      }
      ForEach(model.visible) { fact in
        VStack(alignment: .leading, spacing: 4) {
          Text(fact.text)
          Text("Captured \(fact.captured, format: .dateTime.year().month().day())").font(.caption)
            .foregroundStyle(.secondary)
        }
        .swipeActions(allowsFullSwipe: false) {
          Button("Forget") { forgetting = fact }.tint(.red).disabled(model.busy)
          Button("Edit") { editing = fact }
        }
        .contextMenu {
          Button("Edit", systemImage: "pencil") { editing = fact }
          Button("Forget", systemImage: "trash", role: .destructive) { forgetting = fact }
            .disabled(model.busy)
        }
      }
    }
    .searchable(text: $model.query, prompt: "Search remembered facts")
    .navigationTitle("Memory").navigationBarTitleDisplayMode(.inline)
    .modifier(
      NativeCollectionRefresh(
        active: model.loading && (model.loaded || model.error != nil), label: "Refreshing memory")
    )
    .refreshable { await model.load() }.task { await model.load() }
    .sheet(item: $editing) { fact in MemoryFactEditor(model: model, fact: fact) }
    .confirmationDialog(
      "Forget this fact?",
      isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } })
    ) {
      if let forgetting {
        Button("Forget", role: .destructive) { Task { await model.forget(forgetting) } }
      }
    } message: {
      Text("This can’t be undone.")
    }
  }
}

struct MemoryFactEditor: View {
  let model: MemoryModel
  let fact: MemoryFact
  @Environment(\.dismiss) private var dismiss
  @State private var text: String

  init(model: MemoryModel, fact: MemoryFact) {
    self.model = model
    self.fact = fact
    _text = State(initialValue: fact.text)
  }

  var body: some View {
    NavigationStack {
      QMForm {
        TextField("Fact", text: $text, axis: .vertical).lineLimit(3...12)
        if let error = model.error { Text(error).foregroundStyle(.red) }
      }
      .disabled(model.saving)
      .navigationTitle("Edit fact").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }.disabled(model.saving)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            Task { if await model.edit(fact, text: text) { dismiss() } }
          } label: {
            NativeActionLabel(
              title: "Save", busyTitle: "Saving…", busy: model.saving, compact: true)
          }.disabled(model.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .interactiveDismissDisabled(model.saving)
    }
  }
}
