import SwiftUI

struct NativeDictationComposer: View {
  let model: NativeDictationModel
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var transcriptHeight: CGFloat = 28

  var body: some View {
    VStack(spacing: 8) {
      HStack(spacing: 6) {
        Text(headerTitle)
          .font(.caption2.weight(.semibold))
          .tracking(1.4)
        if model.state == .recording || model.state == .ready {
          Text("·")
          Text(String(format: "%01d:%02d", Int(model.elapsed) / 60, Int(model.elapsed) % 60))
            .font(.caption.monospacedDigit())
        }
      }
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity)
      .accessibilityElement(children: .combine)

      NativeDictationOrb(
        model: model,
        size: verticalSizeClass == .compact || dynamicTypeSize.isAccessibilitySize ? 58 : 82
      )
      .padding(.vertical, 2)

      transcriptArea

      if let error = model.error {
        NativeAudioPermissionNotice(message: error, permission: model.permissionError)
      }

      ViewThatFits(in: .horizontal) {
        HStack(spacing: 4) {
          cancelButton
          Spacer(minLength: 4)
          footerStatus
          Spacer(minLength: 4)
          primaryButton
        }

        VStack(spacing: 0) {
          footerStatus
          HStack {
            cancelButton
            Spacer(minLength: 8)
            primaryButton
          }
        }
      }
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 4)
    .accessibilityIdentifier("dictationComposer")
  }

  private var transcriptArea: some View {
    ScrollViewReader { scrollProxy in
      ScrollView {
        transcript
          .font(.title3)
          .multilineTextAlignment(.center)
          .frame(maxWidth: .infinity)
          .fixedSize(horizontal: false, vertical: true)
          .id("dictationTranscript")
          .onGeometryChange(for: CGFloat.self) {
            $0.size.height
          } action: {
            transcriptHeight = $0
          }
      }
      .frame(height: min(transcriptHeight, maximumTranscriptHeight))
      .scrollIndicators(.hidden)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: transcriptHeight)
      .onChange(of: transcriptHeight) { _, height in
        if height > maximumTranscriptHeight {
          scrollProxy.scrollTo("dictationTranscript", anchor: .bottom)
        }
      }
    }
    .accessibilityLabel(model.liveText.isEmpty ? placeholder : model.liveText)
  }

  private var transcript: Text {
    guard !model.liveText.isEmpty else {
      return Text(placeholder).foregroundColor(QMTheme.ink.opacity(0.58))
    }
    let latest = model.liveText.split(whereSeparator: \.isWhitespace).last.map(String.init) ?? ""
    let preceding = String(model.liveText.dropLast(latest.count))
    return Text(preceding) + Text(latest).fontWeight(.semibold)
  }

  private var maximumTranscriptHeight: CGFloat {
    verticalSizeClass == .compact ? 120 : 220
  }

  private var placeholder: String {
    switch model.state {
    case .idle: ""
    case .preparing: "Preparing microphone…"
    case .recording: "Listening…"
    case .ready: "Recording stopped"
    case .transcribing: "Transcribing…"
    case .retry: "Recording saved for retry"
    }
  }

  private var footerStatus: some View {
    Text(footerTitle)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .lineLimit(1)
  }

  private var headerTitle: String {
    switch model.state {
    case .idle: "DICTATION"
    case .preparing: "PREPARING"
    case .recording: "LISTENING"
    case .ready: "READY"
    case .transcribing: "FINISHING"
    case .retry: "SAVED AUDIO"
    }
  }

  private var footerTitle: String {
    switch model.state {
    case .idle: ""
    case .preparing: "Preparing…"
    case .recording: "Recording"
    case .ready: "Recording stopped"
    case .transcribing: "Finishing…"
    case .retry: "Saved audio"
    }
  }

  private var cancelButton: some View {
    Button("Cancel") { model.cancel() }
      .font(.footnote.weight(.medium))
      .foregroundStyle(QMTheme.ink)
      .frame(minWidth: 76, minHeight: 44)
      .buttonStyle(.plain)
  }

  private var primaryButton: some View {
    Button(primaryTitle) {
      switch model.state {
      case .recording, .ready: model.finish()
      case .retry: model.retry()
      case .idle, .preparing, .transcribing: break
      }
    }
    .font(.footnote.weight(.semibold))
    .foregroundStyle(QMTheme.paper)
    .frame(minWidth: 90, minHeight: 44)
    .background(QMTheme.ink.opacity(primaryEnabled ? 1 : 0.35), in: Capsule())
    .buttonStyle(.plain)
    .disabled(!primaryEnabled)
  }

  private var primaryTitle: String {
    switch model.state {
    case .ready: "Transcribe"
    case .retry: "Retry"
    case .idle, .preparing, .recording, .transcribing: "Done"
    }
  }

  private var primaryEnabled: Bool {
    model.state == .recording || model.state == .ready || model.state == .retry
  }
}

private struct NativeDictationOrb: View {
  let model: NativeDictationModel
  let size: CGFloat
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private let blue = Color(red: 0.20, green: 0.39, blue: 0.88)
  private let paleBlue = Color(red: 0.82, green: 0.88, blue: 1.0)

  var body: some View {
    let active = model.state == .recording
    let level = model.level
    TimelineView(.animation(minimumInterval: 1.0 / 24, paused: !active || reduceMotion)) {
      timeline in
      let time = timeline.date.timeIntervalSinceReferenceDate
      let drift = active && !reduceMotion ? sin(time * 0.9) : 0
      ZStack {
        Circle()
          .fill(
            LinearGradient(
              colors: [blue.opacity(0.76), Color(red: 0.43, green: 0.61, blue: 0.97), paleBlue],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            ))
        Ellipse()
          .fill(.white.opacity(0.66))
          .frame(width: size * 1.38, height: size * 0.40)
          .blur(radius: size * 0.11)
          .rotationEffect(.degrees(-24 + drift * 3))
          .offset(x: -size * 0.02, y: size * (0.13 + drift * 0.03))
        Ellipse()
          .fill(blue.opacity(0.18))
          .frame(width: size * 0.92, height: size * 0.28)
          .blur(radius: size * 0.12)
          .rotationEffect(.degrees(-24))
          .offset(x: size * 0.20, y: size * (-0.23 + drift * 0.02))
      }
      .frame(width: size, height: size)
      .clipShape(Circle())
      .overlay { Circle().strokeBorder(blue.opacity(0.09), lineWidth: 0.5) }
      .scaleEffect(active ? 1 + level * 0.025 : 1)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: level)
      .accessibilityHidden(true)
    }
  }
}
