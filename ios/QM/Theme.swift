import SwiftUI
import UIKit

enum QMTheme {
  static let conversationWidth: CGFloat = 760
  @MainActor static var paper: Color {
    NativeThemeStore.shared.active?.background.color ?? defaultPaper
  }
  @MainActor static var ink: Color {
    NativeThemeStore.shared.active?.readableForeground.color ?? defaultInk
  }
  @MainActor static var surface: Color {
    NativeThemeStore.shared.active?.surface.color ?? defaultSurface
  }
  @MainActor static var warning: Color {
    if let palette = NativeThemeStore.shared.active {
      let candidate = warningRGB(dark: palette.dark)
      return
        (candidate.contrast(with: palette.background) >= 4.5
        && candidate.contrast(with: palette.surface) >= 4.5
        ? candidate : palette.readableForeground).color
    }
    return defaultWarning
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
  private static let defaultWarning = Color(
    uiColor: UIColor { traits in
      let color = warningRGB(dark: traits.userInterfaceStyle == .dark)
      return UIColor(
        red: CGFloat(color.red), green: CGFloat(color.green), blue: CGFloat(color.blue), alpha: 1)
    })
  private static func warningRGB(dark: Bool) -> NativeThemePalette.RGB {
    dark
      ? .init(red: 1, green: 0.64, blue: 0.04)
      : .init(red: 0.6, green: 0.25, blue: 0)
  }
  @MainActor static var border: Color { ink.opacity(0.12) }
  static let navy = Color(red: 0.106, green: 0.188, blue: 0.263)
  static let unread = Color(red: 47 / 255, green: 129 / 255, blue: 247 / 255)
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
  ).flatMap { UIImage(contentsOfFile: $0.path) }

  var body: some View {
    GeometryReader { geometry in
      if let painting = Self.painting {
        Image(uiImage: painting)
          .resizable()
          .scaledToFill()
          .frame(width: geometry.size.width, height: geometry.size.height, alignment: .trailing)
          .clipped()
      } else {
        QMTheme.lightPaper
      }
    }
    .accessibilityHidden(true)
  }
}

struct WelcomeView: View {
  @Bindable var model: AppModel
  @Binding var choosingWorkspace: Bool

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .bottom) {
        QMTheme.lightPaper.ignoresSafeArea()
        MaritimeArtwork()
          .frame(
            width: geometry.size.width, height: geometry.size.height * 0.68,
            alignment: .trailing
          )
          .clipped()
          .frame(maxHeight: .infinity, alignment: .top)
          .ignoresSafeArea(edges: .top)
        ScrollView {
          VStack(alignment: .leading, spacing: 22) {
            Text("QM")
              .font(.custom("IowanOldStyle-Roman", size: 52, relativeTo: .largeTitle))
              .accessibilityAddTraits(.isHeader)
            Text("A clear horizon.")
              .font(.custom("IowanOldStyle-Roman", size: 34, relativeTo: .title))
            Text("Pick up your work. Hand off what’s next.")
              .font(.body)
              .foregroundStyle(QMTheme.navy.opacity(0.75))
            if let error = model.error {
              Text(error)
                .font(.footnote)
                .foregroundStyle(.red)
                .accessibilityLabel("Error: \(error)")
            }
            if model.client != nil {
              Button {
                Task {
                  if model.client?.hasSession == true {
                    await model.restore()
                  } else {
                    await model.authenticate()
                  }
                }
              } label: {
                HStack(spacing: 14) {
                  Image(systemName: "person.crop.circle")
                    .accessibilityHidden(true)
                  Text(model.loading ? "Connecting…" : "Sign in to QM")
                  Spacer(minLength: 8)
                  if model.loading {
                    ProgressView().tint(.white)
                  } else {
                    Image(systemName: "arrow.right").accessibilityHidden(true)
                  }
                }
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(.white)
              }
              .buttonStyle(.borderedProminent)
              .buttonBorderShape(.capsule)
              .tint(QMTheme.navy)
              .controlSize(.large)
              .disabled(model.loading)
              .accessibilityIdentifier("signIn")
            }
            Button {
              choosingWorkspace = true
            } label: {
              HStack(spacing: 14) {
                Image(systemName: "globe").accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                  Text(model.client == nil ? "Choose workspace" : "Change workspace")
                    .font(.headline)
                  if let url = model.client?.baseURL {
                    Text(
                      url.host().map { host in
                        url.port.map { "\(host):\($0)" } ?? host
                      } ?? url.absoluteString
                    )
                    .font(.footnote)
                    .foregroundStyle(QMTheme.navy.opacity(0.7))
                    .lineLimit(1)
                    .truncationMode(.middle)
                  }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").accessibilityHidden(true)
              }
              .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(QMTheme.navy)
            .controlSize(.large)
            .accessibilityIdentifier("changeWorkspace")
          }
          .foregroundStyle(QMTheme.navy)
          .padding(28)
          .frame(maxWidth: 460, alignment: .leading)
          .background(
            QMTheme.lightPaper.opacity(0.94), in: RoundedRectangle(cornerRadius: 20)
          )
          .padding(24)
          .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
        .scrollBounceBehavior(.basedOnSize)
        .scrollIndicators(.hidden)
      }
    }
    .toolbar(.hidden, for: .navigationBar)
    .environment(\.colorScheme, .light)
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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    let moving = !reduceMotion && scenePhase == .active
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !moving)) { timeline in
      Canvas { context, size in
        let scale = size.width / 38.4
        let phase =
          !moving
          ? 0.5
          : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
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
