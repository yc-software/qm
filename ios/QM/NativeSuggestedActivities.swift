import SwiftUI
import os

@MainActor @Observable
final class NativeSuggestedActivitiesModel {
  let client: APIClient
  private var generated: [SuggestedActivity]?
  private var dismissed = Set<String>()
  private(set) var dismissing: String?

  init(client: APIClient) { self.client = client }

  func activities(for identity: Identity) -> [SuggestedActivity] {
    Array(
      (generated ?? identity.suggestedActivities ?? []).filter { !dismissed.contains($0.id) }
        .prefix(3))
  }

  func generate(for identity: Identity) async {
    guard identity.suggestedActivitiesGeneration == true else { return }
    let generation = client.generation
    for _ in 0..<19 {
      do {
        let response: SuggestedActivitiesResponse = try await client.fetch(
          "api/suggested-activities", body: ["timezone": TimeZone.current.identifier])
        try Task.checkCancellation()
        guard client.generation == generation else { return }
        if !response.activities.isEmpty { generated = response.activities }
        if response.pending != true { return }
        try await Task.sleep(for: .seconds(10))
      } catch {
        Log.background.failure("Suggested activities", error)
        return
      }
    }
  }

  func dismiss(_ activity: SuggestedActivity) async {
    guard dismissing == nil else { return }
    dismissing = activity.id
    defer { dismissing = nil }
    do {
      struct Outcome: Decodable { let dismissed: Bool? }
      let outcome: Outcome = try await client.fetch(
        "api/suggested-activities/dismiss", body: ["id": activity.id])
      if outcome.dismissed == true { dismissed.insert(activity.id) }
    } catch {
      Log.background.failure("Dismiss suggested activity", error)
    }
  }
}

struct NativeSuggestedActivities: View {
  let model: NativeSuggestedActivitiesModel
  let identity: Identity
  let select: (SuggestedActivity) -> Void

  var dismissible: Bool { identity.suggestedActivitiesGeneration == true }

  var body: some View {
    VStack(spacing: 8) {
      ForEach(model.activities(for: identity)) { activity in
        HStack(spacing: 0) {
          Button {
            select(activity)
          } label: {
            HStack(spacing: 10) {
              Text(activity.title).multilineTextAlignment(.leading)
              Spacer()
              Image(systemName: "arrow.up.left").font(.caption)
            }
            .padding(14)
          }
          if dismissible {
            Button {
              Task { await model.dismiss(activity) }
            } label: {
              Image(systemName: "xmark").font(.caption).frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Dismiss \(activity.title)")
            .disabled(model.dismissing != nil)
          }
        }
        .font(.subheadline)
        .buttonStyle(.plain)
        .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 14))
      }
    }
    .task(id: identity.user) { await model.generate(for: identity) }
  }
}
