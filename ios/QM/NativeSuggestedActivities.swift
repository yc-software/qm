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
        if !response.activities.isEmpty {
          // Fresh suggestions ease in rather than popping into place.
          withAnimation(.smooth(duration: 0.45)) { generated = response.activities }
        }
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
      if outcome.dismissed == true {
        _ = withAnimation(.smooth(duration: 0.35)) { dismissed.insert(activity.id) }
      }
    } catch {
      Log.background.failure("Dismiss suggested activity", error)
    }
  }
}

struct NativeSuggestedActivities: View {
  let model: NativeSuggestedActivitiesModel
  let identity: Identity
  let select: (SuggestedActivity) -> Void
  @State private var appeared = false
  @AppStorage(AIConsent.key) private var aiConsent = false

  var dismissible: Bool { identity.suggestedActivitiesGeneration == true }

  var body: some View {
    // Plain rows split by hairlines, rather than stacked grey cards.
    let activities = model.activities(for: identity)
    VStack(spacing: 0) {
      ForEach(Array(activities.enumerated()), id: \.element.id) { index, activity in
        HStack(spacing: 0) {
          Button {
            select(activity)
          } label: {
            HStack(spacing: 12) {
              Text(activity.title)
                .foregroundStyle(QMTheme.ink.opacity(0.85))
                .multilineTextAlignment(.leading)
              Spacer(minLength: 8)
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
          }
          if dismissible {
            Button {
              Task { await model.dismiss(activity) }
            } label: {
              Image(systemName: "xmark").font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
                .frame(width: 36, height: 44)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Dismiss \(activity.title)")
            .disabled(model.dismissing != nil)
          }
        }
        .font(.body)
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
          if activity.id != activities.last?.id {
            Rectangle().fill(QMTheme.border).frame(height: 0.5)
          }
        }
        // Rows rise and fade in one after another; later arrivals and dismissals cross-fade.
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 8)
        .animation(.smooth(duration: 0.45).delay(0.1 + Double(index) * 0.07), value: appeared)
        .transition(.opacity.combined(with: .offset(y: 8)))
      }
    }
    .padding(.horizontal, 4)
    .onAppear { appeared = true }
    // Generating suggestions has the workspace's model read the person's data, so it waits for
    // their agreement to share data with AI providers.
    .task(id: "\(identity.user) \(aiConsent)") {
      if aiConsent { await model.generate(for: identity) }
    }
  }
}
