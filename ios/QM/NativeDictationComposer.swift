import SwiftUI

struct NativeDictationComposer: View {
  let model: NativeDictationModel
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var transcriptHeight: CGFloat = 28
  @State private var appeared = false

  var body: some View {
    VStack(spacing: 8) {
      NativeDictationWaves(
        model: model,
        height: verticalSizeClass == .compact || dynamicTypeSize.isAccessibilitySize ? 44 : 64
      )
      .padding(.vertical, 2)
      // The lines rise out of a flat stroke a beat after the panel opens.
      .scaleEffect(x: 1, y: appeared || reduceMotion ? 1 : 0.1)
      .opacity(appeared || reduceMotion ? 1 : 0)
      .animation(
        reduceMotion ? nil : .spring(duration: 0.5, bounce: 0.28).delay(0.04), value: appeared)

      transcriptArea
        .entrance(appeared, delay: 0.14, reduceMotion: reduceMotion)

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
      .entrance(appeared, delay: 0.18, reduceMotion: reduceMotion)
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 4)
    .accessibilityIdentifier("dictationComposer")
    .onAppear { appeared = true }
    // A light tap when the microphone goes live, a firmer one when recording ends,
    // and a warning when audio is saved for retry.
    .sensoryFeedback(trigger: model.state) { old, new in
      if old == .preparing, new == .recording { return .impact(weight: .light, intensity: 0.9) }
      if old == .recording, new == .transcribing || new == .ready {
        return .impact(flexibility: .rigid, intensity: 0.55)
      }
      return new == .retry ? .warning : nil
    }
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

extension View {
  /// Fades and lifts a dictation row in after the panel opens, staggered by `delay`.
  fileprivate func entrance(_ appeared: Bool, delay: Double, reduceMotion: Bool) -> some View {
    opacity(appeared || reduceMotion ? 1 : 0)
      .offset(y: appeared || reduceMotion ? 0 : 6)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.28).delay(delay), value: appeared)
  }
}

/// Thin blue lines that lie almost flat while quiet and rise and drift as the speaker's
/// voice gets louder.
private struct NativeDictationWaves: View {
  let model: NativeDictationModel
  let height: CGFloat
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var smoother = NativeWaveSmoother()

  private struct Line {
    let frequency: Double
    let speed: Double
    let phase: Double
    let weight: Double
    let color: Color
    let width: CGFloat
  }

  private static let blue = Color(red: 0.20, green: 0.39, blue: 0.88)
  private static let mid = Color(red: 0.43, green: 0.61, blue: 0.97)
  private static let sky = Color(red: 0.29, green: 0.52, blue: 0.96)
  private static let lines = [
    Line(frequency: 1.5, speed: 2.1, phase: 0.0, weight: 1.0, color: blue, width: 2),
    Line(frequency: 2.2, speed: -2.6, phase: 1.1, weight: 0.84, color: mid, width: 1.5),
    Line(frequency: 1.1, speed: 1.4, phase: 2.3, weight: 0.72, color: sky, width: 1.25),
    Line(frequency: 2.8, speed: 3.1, phase: 0.6, weight: 0.6, color: blue, width: 1),
    Line(frequency: 1.8, speed: -1.7, phase: 3.4, weight: 0.5, color: mid, width: 1),
    Line(frequency: 3.3, speed: 3.6, phase: 4.2, weight: 0.4, color: sky, width: 1),
    Line(frequency: 1.3, speed: -3.0, phase: 5.1, weight: 0.32, color: blue, width: 1),
  ]

  var body: some View {
    let active = model.state == .recording
    TimelineView(.animation(paused: !active || reduceMotion)) { timeline in
      let time = timeline.date.timeIntervalSinceReferenceDate
      Canvas { context, size in
        let level = smoother.step(toward: active ? model.level : 0, at: time)
        draw(in: &context, size: size, time: reduceMotion ? 0 : time, level: level)
      }
    }
    .frame(height: height)
    .frame(maxWidth: .infinity)
    .accessibilityHidden(true)
  }

  private func draw(in context: inout GraphicsContext, size: CGSize, time: Double, level: Double) {
    let middle = size.height / 2
    // A faint ripple stays visible in silence; speech lifts the lines toward the edges.
    let energy = 0.06 + 0.94 * pow(level, 0.8)
    let steps = max(Int(size.width / 3), 2)
    for line in Self.lines {
      let sway = 0.75 + 0.25 * sin(time * 0.8 + line.phase)
      let amplitude = energy * line.weight * sway * Double(size.height) * 0.46
      var path = Path()
      for step in 0...steps {
        let progress = Double(step) / Double(steps)
        let envelope = pow(sin(progress * .pi), 2)
        let wave = sin(progress * line.frequency * 2 * .pi + time * line.speed + line.phase)
        let point = CGPoint(
          x: CGFloat(progress) * size.width, y: middle + CGFloat(wave * envelope * amplitude))
        if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
      }
      context.stroke(
        path, with: .color(line.color.opacity(0.3 + 0.7 * line.weight)),
        style: StrokeStyle(lineWidth: line.width, lineCap: .round, lineJoin: .round))
    }
  }
}

/// Eases the microphone level, which arrives ten times a second, into per-frame motion:
/// quick to rise with the voice and slower to settle.
private final class NativeWaveSmoother {
  private var value = 0.0
  private var last: Double?

  func step(toward target: Double, at time: Double) -> Double {
    let elapsed = last.map { min(max(time - $0, 0), 0.1) } ?? 0
    last = time
    let rate = target > value ? 14.0 : 5.0
    value += (target - value) * (1 - exp(-rate * elapsed))
    return value
  }
}
