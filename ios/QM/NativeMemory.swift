import SwiftUI

struct MemoryFact: Decodable, Identifiable, Equatable {
  let id: String
  let text: String
  let createdAt: Double
}

@MainActor @Observable
final class MemoryModel {
  private struct Facts: Decodable { let facts: [MemoryFact]? }
  let client: APIClient
  var facts: [MemoryFact] = []
  var loaded = false
  var busy = false
  var error: String?

  init(client: APIClient) { self.client = client }

  func load() async {
    guard !busy else { return }
    await apply { try await self.client.fetch("api/memory") }
  }

  func edit(_ fact: MemoryFact, text: String) async -> Bool {
    await apply {
      try await self.client.fetch(
        "api/memory", body: ["facts": [["id": fact.id, "text": text]]], method: "PATCH")
    }
  }

  func forget(_ fact: MemoryFact) async -> Bool {
    await apply {
      try await self.client.fetch("api/memory", body: ["ids": [fact.id]], method: "DELETE")
    }
  }

  @discardableResult
  private func apply(_ request: @escaping () async throws -> Facts) async -> Bool {
    busy = true
    defer { busy = false }
    do {
      let result = try await request()
      try Task.checkCancellation()
      facts = result.facts ?? []
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
  @State private var query = ""
  @State private var editing: MemoryFact?
  init(client: APIClient) { _model = State(initialValue: MemoryModel(client: client)) }

  private var visible: [MemoryFact] {
    model.facts.filter { query.isEmpty || $0.text.localizedCaseInsensitiveContains(query) }
  }

  var body: some View {
    QMList {
      QMPageHeading(title: "Memory", subtitle: "Facts QM remembers for your future conversations.")
      if let error = model.error {
        Text(error).foregroundStyle(.red)
        Button("Try again") { Task { await model.load() } }
      }
      if model.loaded && visible.isEmpty {
        ContentUnavailableView(
          query.isEmpty ? "Nothing remembered yet" : "No matching facts",
          systemImage: "book.closed",
          description: Text(
            query.isEmpty
              ? "QM notes facts here as you work together."
              : "No remembered facts match this search."))
      }
      ForEach(visible) { fact in
        VStack(alignment: .leading, spacing: 4) {
          Text(fact.text)
          Text(Date(timeIntervalSince1970: fact.createdAt / 1000), style: .date).font(.caption)
            .foregroundStyle(.secondary)
        }
        .swipeActions {
          Button("Forget", role: .destructive) { Task { await model.forget(fact) } }
          Button("Edit") { editing = fact }
        }
        .contextMenu {
          Button("Edit", systemImage: "pencil") { editing = fact }
          Button("Forget", systemImage: "trash", role: .destructive) {
            Task { await model.forget(fact) }
          }
        }
      }
    }
    .searchable(text: $query, prompt: "Search remembered facts")
    .disabled(model.busy).navigationTitle("Memory").navigationBarTitleDisplayMode(.inline)
    .refreshable { await model.load() }.task { await model.load() }
    .sheet(item: $editing) { fact in MemoryFactEditor(model: model, fact: fact) }
  }
}

struct MemoryFactEditor: View {
  @Bindable var model: MemoryModel
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
      .disabled(model.busy)
      .navigationTitle("Edit fact").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.busy ? "Saving…" : "Save") {
            Task { if await model.edit(fact, text: text) { dismiss() } }
          }.disabled(model.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .interactiveDismissDisabled(model.busy)
    }
  }
}
