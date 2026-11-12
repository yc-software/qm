import SwiftUI

struct OpenAIStudy: View {
  let onClose: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var sheet: OpenAISheet?
  @State private var draft = ""
  @State private var model = "Auto"
  @State private var showConversation = true
  @State private var activityExpanded = false
  @State private var attachment: String?
  @State private var messages: [OpenAIMessage] = []
  @State private var approved = false
  @State private var liked = false
  @FocusState private var composing: Bool

  var body: some View {
    VStack(spacing: 0) {
      header
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 28) {
            if showConversation {
              conversation
            } else if messages.isEmpty {
              welcome
            }
            ForEach(messages) { message in
              if message.isUser {
                userBubble(message.text)
              } else {
                Text(message.text)
                  .font(.body)
                  .lineSpacing(6)
                  .textSelection(.enabled)
                  .frame(maxWidth: .infinity, alignment: .leading)
              }
            }
            Color.clear.frame(height: 1).id("end")
          }
          .padding(.horizontal, 24)
          .padding(.top, showConversation ? 24 : 72)
          .frame(maxWidth: 680)
          .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: messages.count) {
          withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            proxy.scrollTo("end", anchor: .bottom)
          }
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    .background(OpenAIStyle.paper)
    .foregroundStyle(OpenAIStyle.ink)
    .tint(OpenAIStyle.ink)
    .preferredColorScheme(.light)
    .sheet(item: $sheet) { item in
      NavigationStack {
        sheetContent(item)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
              Button("Done") { sheet = nil }
            }
          }
      }
      .presentationDetents(item == .history ? [.large] : [.medium, .large])
      .presentationDragIndicator(.visible)
      .tint(OpenAIStyle.ink)
      .preferredColorScheme(.light)
    }
  }

  private var header: some View {
    HStack {
      iconButton("Open history", symbol: "line.3.horizontal") { sheet = .history }
      Spacer()
      Button {
        sheet = .models
      } label: {
        HStack(spacing: 6) {
          Text("QM").font(.title3.weight(.semibold))
          Image(systemName: "chevron.down")
            .font(.caption.weight(.semibold))
            .foregroundStyle(OpenAIStyle.secondary)
        }
        .frame(minWidth: 80, minHeight: 44)
      }
      .accessibilityLabel("Choose model, currently \(model)")
      Spacer()
      iconButton("New chat", symbol: "square.and.pencil", action: newChat)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 4)
    .background(OpenAIStyle.paper)
  }

  private var conversation: some View {
    VStack(alignment: .leading, spacing: 28) {
      userBubble("Catch me up on the launch.\nWhat needs my attention?")
      VStack(alignment: .leading, spacing: 22) {
        Button {
          withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
            activityExpanded.toggle()
          }
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
            Text("Reviewed 12 sources").font(.subheadline)
            Image(systemName: activityExpanded ? "chevron.up" : "chevron.down")
              .font(.caption2.weight(.semibold))
          }
          .foregroundStyle(OpenAIStyle.secondary)
          .frame(minHeight: 44, alignment: .leading)
        }
        .accessibilityValue(activityExpanded ? "Expanded" : "Collapsed")

        if activityExpanded {
          VStack(alignment: .leading, spacing: 16) {
            activityRow(
              "Read the launch channel", detail: "Slack · 6 conversations",
              symbol: "bubble.left.and.bubble.right")
            activityRow(
              "Checked the release plan", detail: "Notion · 4 documents", symbol: "doc.text")
            activityRow("Verified open blockers", detail: "Linear · 2 issues", symbol: "checklist")
          }
          .padding(.leading, 12)
          .padding(.bottom, 4)
        }

        Text("You're in good shape for Thursday.")
          .font(.body.weight(.semibold))
        Text(
          "The team has cleared the release blockers. There's one decision for you, and I've pulled everything into a short brief."
        )
        .font(.body)
        .lineSpacing(6)
        .fixedSize(horizontal: false, vertical: true)

        VStack(alignment: .leading, spacing: 18) {
          HStack(spacing: 10) {
            Image(systemName: "terminal")
              .font(.body)
            Text("Launch readiness").font(.subheadline.weight(.semibold))
            Spacer()
            Text("3 / 3")
              .font(.caption.monospacedDigit())
              .foregroundStyle(OpenAIStyle.secondary)
          }
          Divider()
          workRow("Release checks", detail: "All checks passed")
          workRow("Customer notes", detail: "Draft ready for review")
          workRow("Launch brief", detail: "Saved to your project")
        }
        .padding(18)
        .background(OpenAIStyle.paper, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(OpenAIStyle.line, lineWidth: 1))

        VStack(alignment: .leading, spacing: 10) {
          Text("One thing to decide")
            .font(.body.weight(.semibold))
          Text("The announcement is ready. Should I share it with the launch team?")
            .font(.body)
            .lineSpacing(6)
          Button {
            sheet = .announcement
          } label: {
            Label(
              approved ? "Approved in this demo" : "Review announcement",
              systemImage: approved ? "checkmark" : "arrow.up.right"
            )
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background(OpenAIStyle.soft, in: Capsule())
          }
          .disabled(approved)
          .padding(.top, 4)
        }

        Button {
          sheet = .brief
        } label: {
          HStack(spacing: 14) {
            Image(systemName: "doc.text")
              .font(.title3)
              .frame(width: 42, height: 48)
              .background(OpenAIStyle.soft, in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 4) {
              Text("Your launch brief").font(.subheadline.weight(.medium))
              Text("Document · Updated just now")
                .font(.caption)
                .foregroundStyle(OpenAIStyle.secondary)
            }
            Spacer(minLength: 4)
            Image(systemName: "arrow.up.right").font(.subheadline)
          }
          .padding(12)
          .overlay(RoundedRectangle(cornerRadius: 16).stroke(OpenAIStyle.line, lineWidth: 1))
        }
        .buttonStyle(.plain)

        HStack(spacing: 2) {
          ShareLink(
            item:
              "QM launch brief: release checks passed, customer notes ready, announcement awaits approval."
          ) {
            Label("Share response", systemImage: "square.and.arrow.up")
              .labelStyle(.iconOnly)
              .frame(width: 44, height: 44)
          }
          iconButton(
            liked ? "Remove helpful rating" : "Helpful response",
            symbol: liked ? "hand.thumbsup.fill" : "hand.thumbsup"
          ) { liked.toggle() }
          iconButton("Response details", symbol: "ellipsis") { sheet = .details }
          Spacer()
        }
        .font(.subheadline)
        .foregroundStyle(OpenAIStyle.secondary)
      }
    }
  }

  private var welcome: some View {
    VStack(alignment: .leading, spacing: 36) {
      VStack(alignment: .leading, spacing: 10) {
        Text("Good morning.")
          .font(.largeTitle.weight(.semibold))
          .tracking(-1)
        Text("Where should we start?")
          .font(.title2)
          .foregroundStyle(OpenAIStyle.secondary)
      }
      VStack(alignment: .leading, spacing: 10) {
        suggestion("Catch me up", symbol: "sun.max")
        suggestion("Make a plan", symbol: "checklist")
        suggestion("Find something", symbol: "magnifyingglass")
        suggestion("Build with agents", symbol: "terminal")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var composer: some View {
    VStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 6) {
        if let attachment {
          HStack {
            Label(attachment, systemImage: "doc")
              .font(.caption)
            Spacer()
            iconButton("Remove attachment", symbol: "xmark") { self.attachment = nil }
          }
          .padding(.leading, 8)
        }
        TextField("Message QM", text: $draft, axis: .vertical)
          .font(.body)
          .lineLimit(1...5)
          .focused($composing)
          .accessibilityLabel("Message QM")
          .padding(.horizontal, 12)
          .padding(.top, 12)
          .padding(.bottom, 4)
        HStack(spacing: 2) {
          iconButton("Add attachment", symbol: "plus") { sheet = .attachments }
          Button {
            sheet = .models
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "slider.horizontal.3")
              Text(model).font(.subheadline)
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 44)
          }
          Spacer()
          if !canSend {
            Button {
              sheet = .voice
            } label: {
              Image(systemName: "waveform")
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .foregroundStyle(.white)
                .background(OpenAIStyle.voice, in: Circle())
            }
            .accessibilityLabel("Open voice preview")
          } else {
            Button(action: send) {
              Image(systemName: "arrow.up")
                .font(.title3.weight(.semibold))
                .frame(width: 44, height: 44)
                .foregroundStyle(.white)
                .background(OpenAIStyle.ink, in: Circle())
            }
            .accessibilityLabel("Send message")
          }
        }
      }
      .padding(8)
      .background(OpenAIStyle.paper, in: RoundedRectangle(cornerRadius: 28))
      .overlay(RoundedRectangle(cornerRadius: 28).stroke(OpenAIStyle.line, lineWidth: 1))
      .shadow(color: .black.opacity(0.035), radius: 8, y: 2)
      Text("QM can make mistakes. Check important work.")
        .font(.caption2)
        .foregroundStyle(OpenAIStyle.secondary)
    }
    .padding(.horizontal, 12)
    .padding(.top, 12)
    .padding(.bottom, 6)
    .frame(maxWidth: 704)
    .frame(maxWidth: .infinity)
    .background(OpenAIStyle.paper)
  }

  @ViewBuilder
  private func sheetContent(_ item: OpenAISheet) -> some View {
    switch item {
    case .history:
      history
    case .models:
      List {
        ForEach(["Auto", "Thinking", "Pro"], id: \.self) { option in
          Button {
            model = option
            sheet = nil
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 4) {
                Text(option).font(.body.weight(.medium))
                Text(
                  option == "Auto"
                    ? "The right amount of thought"
                    : option == "Thinking"
                      ? "More time for complex work" : "Our most capable reasoning"
                )
                .font(.subheadline)
                .foregroundStyle(OpenAIStyle.secondary)
              }
              Spacer()
              if model == option { Image(systemName: "checkmark") }
            }
            .padding(.vertical, 8)
          }
        }
      }
      .listStyle(.plain)
      .navigationTitle("QM")
      .navigationBarTitleDisplayMode(.inline)
    case .attachments:
      List {
        Button("Add a sample document", systemImage: "doc") {
          attachment = "Launch plan.pdf"
          sheet = nil
        }
        Button("Add a sample image", systemImage: "photo") {
          attachment = "Product preview.png"
          sheet = nil
        }
        Section("Connected in this study") {
          Label("Slack", systemImage: "bubble.left.and.bubble.right")
          Label("Notion", systemImage: "doc.text")
          Label("Linear", systemImage: "checklist")
        }
      }
      .navigationTitle("Add to your message")
      .navigationBarTitleDisplayMode(.inline)
    case .announcement:
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Label("#launch-team", systemImage: "bubble.left.and.bubble.right")
            .font(.subheadline)
            .foregroundStyle(OpenAIStyle.secondary)
          Text("Ready for Thursday")
            .font(.title2.weight(.semibold))
          Text(
            "The release candidate is verified, customer notes are ready, and our launch checklist is complete. Thanks to everyone who helped get us here. We'll share the final go-ahead on Thursday morning."
          )
          .font(.body)
          .lineSpacing(6)
          Text("This is a sample announcement. Approving changes this preview only.")
            .font(.footnote)
            .foregroundStyle(OpenAIStyle.secondary)
          Button {
            approved = true
            sheet = nil
          } label: {
            Text("Approve announcement")
              .font(.body.weight(.medium))
              .frame(maxWidth: .infinity, minHeight: 48)
              .foregroundStyle(.white)
              .background(OpenAIStyle.ink, in: Capsule())
          }
        }
        .padding(24)
      }
      .navigationTitle("Review announcement")
      .navigationBarTitleDisplayMode(.inline)
    case .brief:
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Label("PRODUCT STUDIO", systemImage: "folder")
            .font(.caption.weight(.medium))
            .foregroundStyle(OpenAIStyle.secondary)
          Text("Ready for Thursday.").font(.largeTitle.weight(.semibold))
          Text("Launch brief").font(.title3).foregroundStyle(OpenAIStyle.secondary)
          Divider()
          Text(
            "The release is ready. All automated checks have passed, customer notes are drafted, and the launch announcement is waiting for your review."
          )
          .font(.body).lineSpacing(6)
          workRow("Engineering", detail: "Release candidate verified")
          workRow("Support", detail: "Help center and customer notes ready")
          workRow("Marketing", detail: "Announcement draft complete")
          Text("Sample document for this design study.")
            .font(.footnote).foregroundStyle(OpenAIStyle.secondary)
        }.padding(24)
      }
      .navigationTitle("Launch brief")
      .navigationBarTitleDisplayMode(.inline)
    case .voice:
      ScrollView {
        VStack(spacing: 24) {
          Image(systemName: "waveform")
            .font(.system(size: 64, weight: .medium))
            .frame(width: 132, height: 132)
            .background(OpenAIStyle.soft, in: Circle())
            .accessibilityHidden(true)
          Text("Talk it through.").font(.title2.weight(.semibold))
          Text("Voice is a visual preview in this study.\nYour microphone is off.")
            .font(.body).multilineTextAlignment(.center)
            .foregroundStyle(OpenAIStyle.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
      }
      .navigationTitle("Voice preview")
      .navigationBarTitleDisplayMode(.inline)
    case .details:
      List {
        LabeledContent("Model", value: model)
        LabeledContent("Sources reviewed", value: "12")
        LabeledContent("Agent tasks", value: "3 completed")
        Text(
          "This design study uses sample data and local replies. No messages or approvals are sent to a workspace."
        )
        .foregroundStyle(OpenAIStyle.secondary)
      }
      .navigationTitle("Response details")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  private var history: some View {
    List {
      Button("New chat", systemImage: "square.and.pencil") {
        newChat()
        sheet = nil
      }
      Section("Projects") {
        Button("Product studio", systemImage: "folder") {
          showConversation = true
          messages = []
          sheet = nil
        }
      }
      Section("Today") {
        Button {
          showConversation = true
          messages = []
          sheet = nil
        } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text("A quieter launch week")
            Text("12 sources · 3 agents finished")
              .font(.caption).foregroundStyle(OpenAIStyle.secondary)
          }.padding(.vertical, 4)
        }
      }
      Section("Yesterday") {
        ForEach(
          [
            "Plan next week's priorities", "Find the onboarding notes",
            "Review the release checklist",
          ], id: \.self
        ) { title in
          Button(title) {
            showConversation = false
            messages = [
              OpenAIMessage(text: title, isUser: true),
              OpenAIMessage(
                text:
                  "This saved sample conversation is ready to continue. What would you like to work on next?",
                isUser: false),
            ]
            sheet = nil
          }
        }
      }
      Section {
        Button("All designs", systemImage: "square.grid.2x2", action: onClose)
      }
    }
    .listStyle(.plain)
    .navigationTitle("QM")
  }

  private func userBubble(_ text: String) -> some View {
    HStack {
      Spacer(minLength: 36)
      Text(text)
        .font(.body)
        .lineSpacing(4)
        .foregroundStyle(OpenAIStyle.userInk)
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(OpenAIStyle.userBubble, in: RoundedRectangle(cornerRadius: 24))
        .textSelection(.enabled)
    }
  }

  private func workRow(_ title: String, detail: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(OpenAIStyle.green)
        .font(.subheadline)
        .padding(.top, 2)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.subheadline.weight(.medium))
        Text(detail).font(.caption).foregroundStyle(OpenAIStyle.secondary)
      }
      Spacer(minLength: 0)
    }
  }

  private func activityRow(_ title: String, detail: String, symbol: String) -> some View {
    HStack(spacing: 12) {
      Image(systemName: symbol).frame(width: 24).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.subheadline)
        Text(detail).font(.caption).foregroundStyle(OpenAIStyle.secondary)
      }
    }
  }

  private func suggestion(_ title: String, symbol: String) -> some View {
    Button {
      draft = title
      composing = true
    } label: {
      Label(title, systemImage: symbol)
        .font(.subheadline)
        .padding(.horizontal, 16)
        .frame(minHeight: 46)
        .overlay(Capsule().stroke(OpenAIStyle.line, lineWidth: 1))
    }
  }

  private func iconButton(_ title: String, symbol: String, action: @escaping () -> Void)
    -> some View
  {
    Button(title, systemImage: symbol, action: action)
      .labelStyle(.iconOnly)
      .font(.title3)
      .frame(width: 44, height: 44)
  }

  private func newChat() {
    showConversation = false
    messages = []
    draft = ""
    attachment = nil
    approved = false
  }

  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attachment != nil
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSend else { return }
    let displayedMessage = [text, attachment.map { "Attached: \($0)" }]
      .compactMap { $0 }
      .filter { !$0.isEmpty }
      .joined(separator: "\n\n")
    messages.append(OpenAIMessage(text: displayedMessage, isUser: true))
    let response =
      attachment == nil
      ? "I've added that to our conversation. In a connected QM workspace, I would use your project context and tools to work through it with you. This preview keeps everything on your device."
      : "I've attached \(attachment ?? "your file") to this sample message. In your QM workspace, I could review it alongside the project and turn it into a clear next step."
    messages.append(OpenAIMessage(text: response, isUser: false))
    draft = ""
    attachment = nil
    composing = false
  }
}

private struct OpenAIMessage: Identifiable {
  let id = UUID()
  let text: String
  let isUser: Bool
}

private enum OpenAISheet: String, Identifiable {
  case history, models, attachments, announcement, brief, voice, details
  var id: String { rawValue }
}

private enum OpenAIStyle {
  static let paper = Color.white
  static let ink = Color(red: 0.08, green: 0.08, blue: 0.08)
  static let secondary = Color(red: 0.40, green: 0.40, blue: 0.40)
  static let soft = Color(red: 0.95, green: 0.95, blue: 0.95)
  static let line = Color(red: 0.86, green: 0.86, blue: 0.86)
  static let green = Color(red: 0.10, green: 0.39, blue: 0.31)
  static let userBubble = Color(red: 0.91, green: 0.96, blue: 0.98)
  static let userInk = Color(red: 0.20, green: 0.36, blue: 0.48)
  static let voice = Color(red: 0.12, green: 0.39, blue: 0.93)
}
