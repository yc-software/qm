import SwiftUI

struct GrokStudy: View {
  let onClose: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var conversation: GrokConversation?
  @State private var draft = ""
  @State private var model = "Auto"
  @State private var mode = "Think"
  @State private var activityExpanded = false
  @State private var activeOnly = false
  @State private var historyPresented = false
  @State private var artifactPresented = false
  @State private var attachedFile = false
  @State private var messages: [GrokMessage] = []
  @FocusState private var composerFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      header
      if let conversation {
        transcript(conversation)
      } else {
        home
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .foregroundStyle(GrokPalette.text)
    .background(GrokPalette.background.ignoresSafeArea())
    .safeAreaInset(edge: .bottom, spacing: 0) {
      composer
    }
    .preferredColorScheme(.dark)
    .tint(GrokPalette.text)
    .sheet(isPresented: $historyPresented) {
      history
    }
    .sheet(isPresented: $artifactPresented) {
      artifact
    }
  }

  private var header: some View {
    HStack(spacing: 8) {
      Button {
        if conversation == nil {
          onClose()
        } else {
          conversation = nil
          composerFocused = false
        }
      } label: {
        Image(systemName: conversation == nil ? "square.grid.2x2" : "chevron.left")
          .font(.system(size: 20, weight: .regular))
          .frame(width: 44, height: 44)
      }
      .accessibilityLabel(conversation == nil ? "All designs" : "Back to chats")

      Spacer()
      Menu {
        Picker("Model", selection: $model) {
          Text("Auto · Best for your task").tag("Auto")
          Text("Fast · Quick answers").tag("Fast")
          Text("Expert · Deeper reasoning").tag("Expert")
        }
      } label: {
        HStack(spacing: 5) {
          Text("QM")
            .font(.title3.weight(.semibold))
          Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(GrokPalette.secondary)
        }
        .frame(minWidth: 64, minHeight: 44)
      }
      .accessibilityLabel("QM, model \(model)")
      Spacer()

      Button(action: newChat) {
        Image(systemName: "square.and.pencil")
          .font(.system(size: 21, weight: .regular))
          .frame(width: 44, height: 44)
      }
      .accessibilityLabel("New chat")
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 12)
    .padding(.top, 4)
    .padding(.bottom, 8)
    .background(GrokPalette.background)
  }

  private var home: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        VStack(spacing: 18) {
          GrokOrbit()
            .frame(width: 76, height: 76)
            .padding(.top, 30)
          Text("What’s on your mind?")
            .font(.largeTitle.weight(.medium))
            .tracking(-1.3)
            .multilineTextAlignment(.center)
          Text("A little curiosity. A lot done.")
            .font(.subheadline)
            .foregroundStyle(GrokPalette.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 32)

        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            suggestion(
              "Catch me up", symbol: "sun.max", prompt: "Catch me up on what matters today.")
            suggestion(
              "Think it through", symbol: "lightbulb",
              prompt: "Help me think through our next product move.")
            suggestion(
              "Build something", symbol: "chevron.left.forwardslash.chevron.right",
              prompt: "Let’s build something useful for the team.")
          }
          .padding(.horizontal, 24)
        }
        .padding(.horizontal, -24)
        .padding(.bottom, 36)

        HStack(alignment: .center) {
          HStack(spacing: 18) {
            Button {
              activeOnly = false
            } label: {
              Text("Recent").frame(minHeight: 44).contentShape(Rectangle())
            }
            .foregroundStyle(activeOnly ? GrokPalette.secondary : GrokPalette.text)
            Button {
              activeOnly = true
            } label: {
              Text("Working").frame(minHeight: 44).contentShape(Rectangle())
            }
            .foregroundStyle(activeOnly ? GrokPalette.text : GrokPalette.secondary)
          }
          .font(.subheadline.weight(.medium))
          .buttonStyle(.plain)
          .frame(minHeight: 44)
          Spacer()
          Button {
            historyPresented = true
          } label: {
            Image(systemName: "clock.arrow.circlepath")
              .font(.system(size: 18))
              .frame(width: 44, height: 44)
          }
          .buttonStyle(.plain)
          .foregroundStyle(GrokPalette.secondary)
          .accessibilityLabel("All chat history")
        }
        .padding(.bottom, 6)

        ForEach(GrokConversation.samples.filter { !activeOnly || $0.working }) { item in
          GrokHistoryRow(conversation: item) { open(item) }
        }

        HStack(spacing: 7) {
          Image(systemName: "circle.grid.2x2")
            .font(.system(size: 12))
          Text("PERSONAL WORKSPACE")
            .font(.caption2.weight(.medium))
            .tracking(1.2)
        }
        .foregroundStyle(GrokPalette.secondary)
        .padding(.top, 24)
        .padding(.bottom, 24)
      }
      .padding(.horizontal, 24)
      .frame(maxWidth: 640)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
  }

  private func suggestion(_ title: String, symbol: String, prompt: String) -> some View {
    Button {
      draft = prompt
      send()
    } label: {
      Label(title, systemImage: symbol)
        .font(.subheadline)
        .padding(.horizontal, 16)
        .frame(minHeight: 44)
        .background(GrokPalette.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(GrokPalette.border, lineWidth: 1))
    }
    .buttonStyle(.plain)
  }

  private func transcript(_ conversation: GrokConversation) -> some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          HStack {
            Spacer()
            Text(conversation.prompt)
              .font(.body)
              .lineSpacing(4)
              .padding(.horizontal, 18)
              .padding(.vertical, 14)
              .background(GrokPalette.raised, in: RoundedRectangle(cornerRadius: 24))
              .frame(maxWidth: 300, alignment: .trailing)
          }
          .padding(.top, 20)

          VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 10) {
              GrokOrbit().frame(width: 25, height: 25)
              Text("QM").font(.subheadline.weight(.semibold))
              Spacer()
              Text(model).font(.caption).foregroundStyle(GrokPalette.secondary)
            }

            if conversation.id == "launch" {
              VStack(alignment: .leading, spacing: 14) {
                Button {
                  withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                    activityExpanded.toggle()
                  }
                } label: {
                  HStack(spacing: 8) {
                    Image(systemName: "sparkle")
                    Text("Thought for 14s")
                    Image(systemName: activityExpanded ? "chevron.up" : "chevron.down")
                      .font(.system(size: 10, weight: .semibold))
                  }
                  .font(.subheadline)
                  .foregroundStyle(GrokPalette.secondary)
                  .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityValue(activityExpanded ? "Expanded" : "Collapsed")

                if activityExpanded {
                  GrokActivity()
                }
              }

            }

            Text(conversation.headline)
              .font(.title.weight(.medium))
              .tracking(-0.7)
            Text(conversation.answer)
              .font(.body)
              .lineSpacing(6)
              .foregroundStyle(GrokPalette.body)

            if conversation.id == "launch" {
              VStack(alignment: .leading, spacing: 16) {
                GrokFinding(
                  number: "01", title: "Core flows are ready",
                  detail: "Sign-in, chat, and background recovery passed.")
                GrokFinding(
                  number: "02", title: "One real-device check",
                  detail: "Confirm microphone routing on an iPhone.")
                GrokFinding(
                  number: "03", title: "You have the final call",
                  detail: "The release notes and checklist are ready.")
              }

              Button {
                artifactPresented = true
              } label: {
                HStack(spacing: 14) {
                  Image(systemName: "doc.text")
                    .font(.system(size: 23, weight: .light))
                    .frame(width: 44, height: 44)
                    .background(GrokPalette.raised, in: RoundedRectangle(cornerRadius: 12))
                  VStack(alignment: .leading, spacing: 4) {
                    Text("iOS launch checklist")
                      .font(.subheadline.weight(.medium))
                    Text("Document · Updated just now")
                      .font(.caption)
                      .foregroundStyle(GrokPalette.secondary)
                  }
                  Spacer(minLength: 4)
                  Image(systemName: "arrow.up.right")
                    .font(.system(size: 15))
                    .foregroundStyle(GrokPalette.secondary)
                }
                .padding(16)
                .background(GrokPalette.surface, in: RoundedRectangle(cornerRadius: 18))
                .overlay(
                  RoundedRectangle(cornerRadius: 18).strokeBorder(GrokPalette.border, lineWidth: 1))
              }
              .buttonStyle(.plain)

            }

            HStack(spacing: 8) {
              ShareLink(item: conversation.answer) {
                Image(systemName: "square.and.arrow.up")
                  .frame(width: 44, height: 44)
              }
              Button {
                draft = "Go deeper on \(conversation.title.lowercased())."
                send()
              } label: {
                Image(systemName: "arrow.clockwise")
                  .frame(width: 44, height: 44)
              }
              .accessibilityLabel("Explore this answer further")
              Spacer()
              Text(conversation.id == "launch" ? "3 agents · 6 sources" : "Local preview")
                .font(.caption)
            }
            .buttonStyle(.plain)
            .foregroundStyle(GrokPalette.secondary)
          }

          ForEach(messages) { message in
            GrokMessageRow(message: message)
          }
          Color.clear.frame(height: 1).id("latest")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: messages.count) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
          proxy.scrollTo("latest", anchor: .bottom)
        }
      }
    }
  }

  private var composer: some View {
    VStack(spacing: 9) {
      VStack(alignment: .leading, spacing: 10) {
        if attachedFile {
          Button {
            attachedFile = false
          } label: {
            Label("launch-notes.md  ×", systemImage: "doc.text")
              .font(.caption)
              .padding(.horizontal, 12)
              .frame(minHeight: 44)
              .background(GrokPalette.raised, in: Capsule())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Remove attached launch notes")
        }
        TextField("Ask anything", text: $draft, axis: .vertical)
          .font(.body)
          .lineLimit(1...5)
          .focused($composerFocused)
          .padding(.horizontal, 8)
          .padding(.top, 8)
          .accessibilityLabel("Message QM")

        HStack(spacing: 4) {
          Menu {
            Button("Add demo document", systemImage: "doc.badge.plus") { attachedFile = true }
            Button("Use launch context", systemImage: "folder") {
              draft = "Using our launch notes, what should we focus on?"
            }
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 21, weight: .light))
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel("Add context")

          Menu {
            Picker("Response mode", selection: $mode) {
              Text("Think").tag("Think")
              Text("Research").tag("Research")
              Text("Quick").tag("Quick")
            }
          } label: {
            HStack(spacing: 6) {
              Image(systemName: mode == "Research" ? "globe" : "sparkle")
              Text(mode)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background(GrokPalette.raised, in: Capsule())
          }
          .accessibilityLabel("Response mode, \(mode)")

          Spacer(minLength: 2)
          Button(action: send) {
            Image(systemName: "arrow.up")
              .font(.system(size: 20, weight: .medium))
              .foregroundStyle(GrokPalette.background)
              .frame(width: 44, height: 44)
              .background(
                GrokPalette.text.opacity(
                  canSend ? 1 : 0.35),
                in: Circle())
          }
          .disabled(!canSend)
          .accessibilityLabel("Send message")
        }
        .buttonStyle(.plain)
      }
      .padding(10)
      .background(GrokPalette.surface, in: RoundedRectangle(cornerRadius: 28))
      .overlay(RoundedRectangle(cornerRadius: 28).strokeBorder(GrokPalette.border, lineWidth: 1))
      Text(
        conversation == nil
          ? "Your workspace. Your context. Your QM." : "QM can make mistakes. Check important work."
      )
      .font(.caption2)
      .foregroundStyle(GrokPalette.secondary)
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 8)
    .frame(maxWidth: 672)
    .frame(maxWidth: .infinity)
    .background(GrokPalette.background)
  }

  private var history: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 4) {
          Text("TODAY")
            .font(.caption2.weight(.medium))
            .tracking(1.5)
            .foregroundStyle(GrokPalette.secondary)
            .padding(.vertical, 16)
          ForEach(GrokConversation.samples) { item in
            GrokHistoryRow(conversation: item) {
              historyPresented = false
              open(item)
            }
          }
        }
        .padding(.horizontal, 24)
      }
      .background(GrokPalette.background)
      .navigationTitle("Your chats")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { historyPresented = false }
        }
      }
    }
    .preferredColorScheme(.dark)
  }

  private var artifact: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Label("QM WORKSPACE", systemImage: "doc.text")
            .font(.caption.weight(.medium))
            .foregroundStyle(GrokPalette.secondary)
          Text("Ready for liftoff.")
            .font(.largeTitle.weight(.medium))
            .tracking(-1)
          Text("iOS launch checklist")
            .font(.title3)
          ForEach(
            [
              "Portal sign-in verified", "Chat streaming and recovery verified",
              "Release notes prepared", "Real-device microphone QA pending",
              "Final release approval pending",
            ], id: \.self
          ) { item in
            Label(item, systemImage: item.contains("pending") ? "circle" : "checkmark.circle.fill")
              .font(.body)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          Text("Design study · Sample workspace document")
            .font(.caption)
            .foregroundStyle(GrokPalette.secondary)
        }
        .padding(24)
      }
      .background(GrokPalette.background)
      .navigationTitle("Launch checklist")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { artifactPresented = false }
        }
      }
    }
    .preferredColorScheme(.dark)
  }

  private func open(_ item: GrokConversation) {
    conversation = item
    messages = []
    activityExpanded = false
    composerFocused = false
  }

  private func newChat() {
    conversation = nil
    messages = []
    draft = ""
    attachedFile = false
    composerFocused = true
  }

  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachedFile
  }

  private func send() {
    guard canSend else { return }
    let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    let text = [body, attachedFile ? "Attached: launch-notes.md" : ""].filter { !$0.isEmpty }
      .joined(separator: "\n\n")
    draft = ""
    composerFocused = false
    if conversation == nil {
      conversation = GrokConversation(
        id: UUID().uuidString,
        title: String(text.prefix(36)),
        subtitle: "Just now",
        working: false,
        prompt: text,
        headline: "Let’s get into it.",
        answer:
          "I’d start with the outcome you want, then break the work into one useful first step. What would a good result look like?"
      )
      messages = []
    } else {
      messages.append(GrokMessage(text: text, isUser: true))
      messages.append(
        GrokMessage(
          text: conversation?.id == "launch"
            ? "Here’s how I’d approach that: start with the real-device check, capture the result in the launch checklist, then make the release decision. The three workspace agents have already covered code, tests, and release notes."
            : "For “\(conversation?.title ?? "this task")”, let’s choose one concrete outcome and the smallest action that moves it forward. What should we prioritize?",
          isUser: false))
    }
    attachedFile = false
  }
}

private enum GrokPalette {
  static let background = Color(red: 0.055, green: 0.055, blue: 0.06)
  static let surface = Color(red: 0.09, green: 0.09, blue: 0.095)
  static let raised = Color(red: 0.145, green: 0.145, blue: 0.15)
  static let border = Color(white: 0.23)
  static let text = Color(white: 0.96)
  static let body = Color(white: 0.86)
  static let secondary = Color(white: 0.62)
}

private struct GrokConversation: Identifiable {
  let id: String
  let title: String
  let subtitle: String
  let working: Bool
  let prompt: String
  let headline: String
  let answer: String

  static let samples = [
    GrokConversation(
      id: "launch", title: "Ship the iOS release", subtitle: "3 agents working · Just now",
      working: true, prompt: "What’s left before we can ship the iOS app?",
      headline: "Almost there.",
      answer:
        "The important pieces are in place. I checked the build, the open tasks, and the latest team updates. Here’s what matters."
    ),
    GrokConversation(
      id: "morning", title: "Monday, without the meetings",
      subtitle: "Your workspace, caught up · 24m", working: false,
      prompt: "Catch me up on the team’s work this morning.", headline: "You’re up to speed.",
      answer:
        "The team is focused on the iOS release. No new blockers came up overnight, and the remaining work is small enough to keep moving today."
    ),
    GrokConversation(
      id: "onboarding", title: "A sharper onboarding flow", subtitle: "Exploring 3 directions · 1h",
      working: true, prompt: "Find a simpler path from installing QM to the first useful answer.",
      headline: "Less setup. More doing.",
      answer:
        "Start with one useful question. Let the workspace connection happen in context, and show people what QM can do with their actual work."
    ),
  ]
}

private struct GrokHistoryRow: View {
  let conversation: GrokConversation
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        VStack(alignment: .leading, spacing: 7) {
          Text(conversation.title)
            .font(.body.weight(.medium))
            .foregroundStyle(GrokPalette.text)
          HStack(spacing: 6) {
            if conversation.working {
              Image(systemName: "circle.dotted")
                .font(.system(size: 11))
            }
            Text(conversation.subtitle)
              .font(.caption)
          }
          .foregroundStyle(GrokPalette.secondary)
        }
        Spacer(minLength: 4)
        Image(systemName: "arrow.up.right")
          .font(.system(size: 15, weight: .light))
          .foregroundStyle(GrokPalette.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 17)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

private struct GrokFinding: View {
  let number: String
  let title: String
  let detail: String

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      Text(number)
        .font(.caption.monospaced())
        .foregroundStyle(GrokPalette.secondary)
        .padding(.top, 3)
      VStack(alignment: .leading, spacing: 5) {
        Text(title).font(.body.weight(.medium))
        Text(detail)
          .font(.subheadline)
          .lineSpacing(4)
          .foregroundStyle(GrokPalette.secondary)
      }
    }
  }
}

private struct GrokActivity: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ForEach(
        [
          "Checked the latest iOS build", "Reviewed 6 workspace sources",
          "Compared findings from 3 agents",
        ], id: \.self
      ) { step in
        Label(step, systemImage: "checkmark")
          .font(.subheadline)
          .foregroundStyle(GrokPalette.secondary)
      }
    }
    .padding(.leading, 16)
    .padding(.vertical, 4)
    .overlay(alignment: .leading) {
      Rectangle().fill(GrokPalette.border).frame(width: 1)
    }
  }
}

private struct GrokMessage: Identifiable {
  let id = UUID()
  let text: String
  let isUser: Bool
}

private struct GrokMessageRow: View {
  let message: GrokMessage

  var body: some View {
    HStack(alignment: .top) {
      if message.isUser { Spacer(minLength: 32) }
      VStack(alignment: .leading, spacing: 12) {
        if !message.isUser {
          HStack(spacing: 8) {
            GrokOrbit().frame(width: 24, height: 24)
            Text("QM").font(.subheadline.weight(.semibold))
          }
        }
        Text(message.text)
          .font(.body)
          .lineSpacing(5)
          .padding(message.isUser ? 16 : 0)
          .background(
            message.isUser ? GrokPalette.raised : .clear, in: RoundedRectangle(cornerRadius: 24))
      }
      if !message.isUser { Spacer(minLength: 0) }
    }
  }
}

private struct GrokOrbit: View {
  var body: some View {
    GeometryReader { geometry in
      let side = min(geometry.size.width, geometry.size.height)
      ZStack {
        Circle()
          .trim(from: 0.07, to: 0.89)
          .stroke(GrokPalette.text, style: StrokeStyle(lineWidth: side * 0.075, lineCap: .round))
          .rotationEffect(.degrees(-41))
          .padding(side * 0.16)
        Ellipse()
          .stroke(GrokPalette.text, lineWidth: side * 0.045)
          .frame(width: side * 0.95, height: side * 0.23)
          .rotationEffect(.degrees(-43))
      }
      .frame(width: side, height: side)
    }
    .accessibilityHidden(true)
  }
}
