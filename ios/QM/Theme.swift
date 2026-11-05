import SwiftUI
import UIKit
import os

enum QMTheme {
  static let conversationWidth: CGFloat = 760
  @MainActor static var paper: Color {
    NativeThemeStore.shared.active?.background.color ?? defaultPaper
  }
  @MainActor static var ink: Color {
    NativeThemeStore.shared.active?.foreground.color ?? defaultInk
  }
  @MainActor static var surface: Color {
    if let palette = NativeThemeStore.shared.active {
      return palette.background.mixed(with: palette.foreground, fraction: 0.08).color
    }
    return defaultSurface
  }
  static let lightPaper = Color(red: 0.969, green: 0.965, blue: 0.949)
  private static let defaultPaper = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 7 / 255, green: 15 / 255, blue: 24 / 255, alpha: 1)
        : UIColor.white
    })
  private static let defaultInk = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 244 / 255, green: 247 / 255, blue: 250 / 255, alpha: 1)
        : UIColor(red: 0.106, green: 0.188, blue: 0.263, alpha: 1)
    })
  private static let defaultSurface = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 15 / 255, green: 24 / 255, blue: 34 / 255, alpha: 1)
        : UIColor(red: 0.96, green: 0.97, blue: 0.98, alpha: 1)
    })
  @MainActor static var border: Color { ink.opacity(0.12) }
  static let navy = Color(red: 0.106, green: 0.188, blue: 0.263)
}

struct QMList<Content: View>: View {
  @ViewBuilder let content: () -> Content
  var body: some View {
    List {
      content()
        .listRowBackground(QMTheme.paper)
        .listRowSeparatorTint(QMTheme.border)
    }
    .listStyle(.plain)
    .listSectionSpacing(16)
    .scrollContentBackground(.hidden)
    .background(QMTheme.paper)
    .foregroundStyle(QMTheme.ink)
    .toolbarBackground(QMTheme.paper, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
  }
}

struct QMForm<Content: View>: View {
  @ViewBuilder let content: () -> Content
  var body: some View {
    Form {
      content()
        .listRowBackground(QMTheme.surface)
        .listRowSeparatorTint(QMTheme.border)
    }
    .scrollContentBackground(.hidden)
    .background(QMTheme.paper)
    .foregroundStyle(QMTheme.ink)
    .toolbarBackground(QMTheme.paper, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
  }
}

struct QMPageHeading: View {
  let title: String
  let subtitle: String
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(.custom("IowanOldStyle-Roman", size: 34, relativeTo: .largeTitle))
      Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
    }
    .foregroundStyle(QMTheme.ink)
    .padding(.top, 12).padding(.bottom, 20)
    .listRowSeparator(.hidden)
    .accessibilityAddTraits(.isHeader)
  }
}

struct MaritimeArtwork: View {
  private static let painting = Bundle.main.url(
    forResource: "becalmed-off-halfway-rock", withExtension: "webp"
  )
  .flatMap { UIImage(contentsOfFile: $0.path) }

  var body: some View {
    if let painting = Self.painting {
      Image(uiImage: painting).resizable().scaledToFill()
        .accessibilityHidden(true)
    } else {
      QMTheme.paper
    }
  }
}

struct WelcomeView: View {
  @Bindable var model: AppModel
  @State private var choosingWorkspace = false

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .bottom) {
        QMTheme.lightPaper.ignoresSafeArea()
        MaritimeArtwork()
          .frame(
            width: geometry.size.width, height: geometry.size.height * 0.68, alignment: .trailing
          )
          .clipped().frame(maxHeight: .infinity, alignment: .top).ignoresSafeArea(edges: .top)
        ScrollView {
          VStack(alignment: .leading, spacing: 22) {
            Text("QM").font(.custom("IowanOldStyle-Roman", size: 52, relativeTo: .largeTitle))
            Text("A clear horizon.").font(
              .custom("IowanOldStyle-Roman", size: 34, relativeTo: .title))
            Text("Pick up your work. Hand off what’s next.")
              .font(.body).foregroundStyle(QMTheme.navy.opacity(0.75))
            if model.client != nil {
              Button {
                Task { await model.authenticate() }
              } label: {
                HStack {
                  Text(model.loading ? "Connecting…" : "Sign in to QM")
                  Spacer()
                  if model.loading {
                    ProgressView().tint(.white)
                  } else {
                    Image(systemName: "arrow.right")
                  }
                }.foregroundStyle(.white).padding(.vertical, 8)
              }
              .buttonStyle(.borderedProminent).tint(QMTheme.navy)
              .controlSize(.large).disabled(model.loading)
              .accessibilityIdentifier("signIn")
              if let host = model.client?.baseURL.host {
                Text(host).font(.footnote).foregroundStyle(QMTheme.navy.opacity(0.65))
              }
            } else {
              Text("Connect to your workspace to sign in.")
                .font(.callout)
            }
            Button(model.client == nil ? "Choose workspace" : "Change workspace") {
              choosingWorkspace = true
            }.disabled(model.loading)
          }
          .foregroundStyle(QMTheme.navy)
          .padding(28).frame(maxWidth: 460, alignment: .leading)
          .background(
            QMTheme.lightPaper.opacity(0.94),
            in: RoundedRectangle(cornerRadius: 20)
          )
          .padding(24)
        }
        .defaultScrollAnchor(.bottom)
      }
    }
    .sheet(isPresented: $choosingWorkspace) { WorkspacePicker(model: model) }
  }
}

struct WorkspaceMasthead: View {
  let name: String
  let archived: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if name != "Your workspace" {
        Text(name.uppercased())
          .font(.caption2.weight(.semibold)).tracking(1.8)
          .foregroundStyle(.secondary)
      }
      Text(archived ? "The archive" : "Conversations")
        .font(.custom("IowanOldStyle-Roman", size: 30, relativeTo: .title))
        .foregroundStyle(QMTheme.ink)
    }
    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    .padding(.top, 8).padding(.bottom, 12)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

struct NativeWave: View {
  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
      Canvas { context, size in
        let scale = size.width / 38.4
        let phase =
          timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
        var path = Path()
        let start = -24 - phase * 24
        path.move(to: CGPoint(x: start * scale, y: size.height / 2))
        for index in 0..<10 {
          let x = start + Double(index) * 12
          let bend = (index.isMultiple(of: 2) ? -8.0 : 8.0) * scale
          path.addCurve(
            to: CGPoint(x: (x + 12) * scale, y: size.height / 2),
            control1: CGPoint(x: (x + 4) * scale, y: size.height / 2 + bend),
            control2: CGPoint(x: (x + 8) * scale, y: size.height / 2 + bend))
        }
        context.stroke(
          path, with: .foreground, style: StrokeStyle(lineWidth: 2.6 * scale, lineCap: .round))
      }
    }
    .frame(idealWidth: 25, idealHeight: 16)
    .frame(maxWidth: 25, maxHeight: 16)
    .clipped()
    .accessibilityLabel("Working")
  }
}

struct NativeSuggestedActivities: View {
  let client: APIClient
  let identity: Identity
  let select: (SuggestedActivity) -> Void
  @State private var generated: [SuggestedActivity]?

  var body: some View {
    VStack(spacing: 8) {
      ForEach(Array((generated ?? identity.suggestedActivities ?? []).prefix(3))) { activity in
        Button {
          select(activity)
        } label: {
          HStack(spacing: 10) {
            Text(activity.title).multilineTextAlignment(.leading)
            Spacer()
            Image(systemName: "arrow.up.left").font(.caption)
          }
          .font(.subheadline)
          .padding(14)
          .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        }.buttonStyle(.plain)
      }
    }
    .task(id: identity.user) {
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
  }
}
