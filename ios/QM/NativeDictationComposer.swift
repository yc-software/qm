import SwiftUI

struct NativeDictationComposer: View {
  let model: NativeDictationModel
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var transcriptHeight: CGFloat = 28
  @State private var appeared = false
  @State private var reveal = NativeWordQueue()

  var body: some View {
    VStack(spacing: 8) {
      NativeDictationWaves(
        model: model,
        height: verticalSizeClass == .compact || dynamicTypeSize.isAccessibilitySize ? 48 : 80
      )
      .padding(.top, 10)
      .padding(.bottom, 4)
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
    }
    // The ✕ and ↑ live in the composer's own button row (ChatView), so they never move.
    .padding(.horizontal, 4)
    .padding(.top, 8)
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
        // Each word eases up into place and into focus on its own clock, so a fast
        // talker never cuts off the word before. Left-aligned while words arrive so
        // the line grows rightward instead of re-centering on every word.
        TimelineView(.animation(paused: reduceMotion || !reveal.animating)) { timeline in
          transcript
            .font(.title3)
            .textRenderer(
              NativeWordReveal(
                now: timeline.date.timeIntervalSinceReferenceDate, instant: reduceMotion))
        }
        .multilineTextAlignment(reveal.words.isEmpty ? .center : .leading)
        .frame(maxWidth: .infinity, alignment: reveal.words.isEmpty ? .center : .leading)
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
    .contentShape(Rectangle())
    .onTapGesture { if model.canFinish { model.finish() } }
    .onAppear { reveal.update(to: model.liveText, flush: reduceMotion) }
    .onChange(of: model.liveText) { _, text in
      reveal.update(to: text, flush: reduceMotion || model.state != .recording)
    }
    .onChange(of: model.state) { _, state in
      if state != .recording { reveal.update(to: model.liveText, flush: true) }
    }
    .accessibilityLabel(model.liveText.isEmpty ? placeholder : model.liveText)
    .accessibilityHint(
      model.canFinish ? "Stops recording and puts the text in the message field" : "")
    .accessibilityAddTraits(model.canFinish ? .isButton : [])
  }

  private var transcript: Text {
    guard !reveal.words.isEmpty else {
      return Text(placeholder).foregroundColor(QMTheme.ink.opacity(0.58))
    }
    return reveal.words.enumerated().reduce(Text("")) { text, item in
      let (index, word) = item
      let piece = Text(index == 0 ? word.text : " " + word.text)
        .customAttribute(NativeWordBirth(time: word.born))
      return text + piece
    }
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
    case .retry: model.retryRecordsAgain ? "Nothing was heard" : "Recording saved for retry"
    }
  }

}

/// The dictation panel's discard button, shown in the composer row where the plus sits.
struct NativeDictationDiscardButton: View {
  let model: NativeDictationModel

  var body: some View {
    Button {
      model.cancel()
    } label: {
      Image(systemName: "xmark")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(QMTheme.ink)
        .frame(width: 44, height: 44)
        .background(QMTheme.ink.opacity(0.08), in: Circle())
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Discard recording")
  }
}

/// The dictation panel's send (or retry) button, shown in the composer row where send sits.
struct NativeDictationSendButton: View {
  let model: NativeDictationModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if model.state == .retry {
      Button {
        model.retry()
      } label: {
        Image(systemName: "arrow.clockwise")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(QMTheme.paper)
          .frame(width: 44, height: 44)
          .background(QMTheme.ink, in: Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(model.retryRecordsAgain ? "Record again" : "Retry transcription")
    } else {
      Button {
        model.finish(sending: true)
      } label: {
        ComposerSendLabel(enabled: model.canFinish, sending: model.state == .transcribing)
          .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.state)
      }
      .buttonStyle(.plain)
      .disabled(!model.canFinish)
      .accessibilityLabel(model.state == .transcribing ? "Sending dictation" : "Send dictation")
    }
  }
}

private struct NativeWordBirth: TextAttribute {
  var time: TimeInterval
}

/// How long each word takes to land.
private let wordRevealDuration: TimeInterval = 0.38

/// Draws the dictation transcript, easing each word up into place and into focus
/// from the moment it was shown.
private struct NativeWordReveal: TextRenderer {
  var now: TimeInterval
  var instant: Bool

  func draw(layout: Text.Layout, in context: inout GraphicsContext) {
    for line in layout {
      for run in line {
        guard !instant, let born = run[NativeWordBirth.self]?.time else {
          context.draw(run)
          continue
        }
        let linear = min(max((now - born) / wordRevealDuration, 0), 1)
        guard linear < 1 else {
          context.draw(run)
          continue
        }
        let progress = 1 - pow(1 - linear, 3)  // ease out cubic
        var landing = context
        landing.opacity = progress
        landing.addFilter(.blur(radius: (1 - progress) * 4))
        landing.translateBy(x: 0, y: (1 - progress) * 6)
        landing.draw(run)
      }
    }
  }
}

/// Paces recognizer updates into a steady trickle of words. The recognizer reports in
/// bursts of two or three words; each new word is scheduled to start landing a beat after
/// the previous one, so every word gets its own entrance. Corrections swap in place.
@MainActor @Observable
final class NativeWordQueue {
  struct Word: Equatable {
    var text: String
    var born: TimeInterval
  }

  private(set) var words: [Word] = []
  /// True while a word is still landing; the reveal timeline idles otherwise.
  private(set) var animating = false
  private var settle: Task<Void, Never>?

  func update(to text: String, flush: Bool) {
    let target = text.split(whereSeparator: \.isWhitespace).map(String.init)
    let now = Date.timeIntervalSinceReferenceDate
    // Words already on screen take the recognizer's latest spelling but keep their clock.
    for index in 0..<min(words.count, target.count) where words[index].text != target[index] {
      words[index].text = target[index]
    }
    if words.count > target.count { words.removeLast(words.count - target.count) }
    for word in target.dropFirst(words.count) {
      let last = words.last?.born ?? now
      // 55ms apart, tightening to 25ms once the schedule runs more than ~3 words ahead.
      let gap = last - now > 0.15 ? 0.025 : 0.055
      let born = flush ? now - wordRevealDuration : max(now, last + gap)
      words.append(Word(text: word, born: born))
    }
    let end = (words.map(\.born).max() ?? now) + wordRevealDuration
    settle?.cancel()
    animating = end > now
    guard animating else { return }
    settle = Task { [weak self] in
      try? await Task.sleep(for: .seconds(end - now))
      if !Task.isCancelled { self?.animating = false }
    }
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
    // Reduce Motion keeps the lines in place but still lets them rise and fall with the voice.
    TimelineView(.animation(minimumInterval: reduceMotion ? 0.1 : 1.0 / 60, paused: !active)) {
      timeline in
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

/// A gradient that glows inward from the dictation panel's edge while the speaker is talking.
/// It stays hidden in silence and grows brighter and deeper as the voice gets louder.
struct NativeDictationGlow: View {
  let model: NativeDictationModel
  var cornerRadius: CGFloat = 24
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var smoother = NativeWaveSmoother()

  /// One band of colour patches around the rim. Each band turns at its own speed and wobbles,
  /// so the patches drift past one another and the edge never lights evenly.
  private struct Band {
    let colors: [Color]
    let speed: Double
    let phase: Double
  }

  private static let blue = Color(red: 0.20, green: 0.39, blue: 0.88)
  private static let sky = Color(red: 0.43, green: 0.61, blue: 0.97)
  private static let violet = Color(red: 0.55, green: 0.40, blue: 0.98)
  private static let pink = Color(red: 0.98, green: 0.45, blue: 0.62)
  private static let coral = Color(red: 1.00, green: 0.55, blue: 0.47)
  private static let bands = [
    Band(
      colors: [
        blue, blue.opacity(0), sky.opacity(0), sky, violet.opacity(0), blue.opacity(0), blue,
      ],
      speed: 23, phase: 0),
    Band(
      colors: [
        pink.opacity(0), pink, pink.opacity(0), violet.opacity(0), violet, violet.opacity(0),
        pink.opacity(0),
      ],
      speed: -31, phase: 1.7),
    Band(
      colors: [
        coral.opacity(0), sky.opacity(0), coral, coral.opacity(0), blue.opacity(0), blue,
        coral.opacity(0),
      ],
      speed: 17, phase: 3.9),
  ]

  var body: some View {
    let active = model.state == .recording
    TimelineView(.animation(minimumInterval: reduceMotion ? 0.1 : 1.0 / 60, paused: !active)) {
      timeline in
      let time = timeline.date.timeIntervalSinceReferenceDate
      let level = smoother.step(toward: active ? model.level : 0, at: time)
      let shape = RoundedRectangle(cornerRadius: cornerRadius)
      // Room noise sits below the threshold, so nothing shows until the person speaks.
      let presence = min(1, max(0, (level - 0.12) / 0.3))
      ZStack {
        ForEach(Self.bands.indices, id: \.self) { index in
          let band = Self.bands[index]
          let wobble = sin(time * (1.3 + Double(index) * 0.7) + band.phase)
          let flicker = reduceMotion ? 1 : 0.6 + 0.4 * wobble * sin(time * 2.9 + band.phase * 2)
          let drift = time * band.speed + 30 * sin(time * 0.6 + band.phase)
          let angle = band.phase * 57 + (reduceMotion ? 0 : drift)
          shape.strokeBorder(
            AngularGradient(colors: band.colors, center: .center, angle: .degrees(angle)),
            lineWidth: 3 + 6 * level * flicker
          )
          .blur(radius: 4 + 4 * level)
          .opacity(0.5 * presence * flicker)
        }
      }
      .clipShape(shape)
    }
    .opacity(active ? 1 : 0)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.35), value: active)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
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
