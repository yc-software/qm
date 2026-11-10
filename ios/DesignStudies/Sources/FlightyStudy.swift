import SwiftUI

struct FlightyStudy: View {
  let onClose: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var selectedTask: String?
  @State private var selectedFilter = "All"
  @State private var draft = ""
  @State private var messages: [FlightyMessage] = []
  @State private var workflowExpanded = false
  @State private var model = "GPT-5.4"
  @State private var showingModels = false
  @State private var attachmentAdded = false
  @FocusState private var composerFocused: Bool

  private let ink = Color(red: 0.09, green: 0.12, blue: 0.18)
  private let muted = Color(red: 0.39, green: 0.43, blue: 0.48)
  private let accent = Color(red: 0.12, green: 0.40, blue: 0.85)
  private let yellow = Color(red: 1, green: 0.83, blue: 0.19)
  private let paper = Color(red: 0.95, green: 0.95, blue: 0.96)

  var body: some View {
    VStack(spacing: 0) {
      navigation
      if let selectedTask {
        conversation(selectedTask)
      } else {
        home
      }
    }
    .foregroundStyle(ink)
    .background(paper.ignoresSafeArea())
    .safeAreaInset(edge: .bottom, spacing: 0) {
      if selectedTask != nil { composer } else { bottomBar }
    }
    .preferredColorScheme(.light)
    .sheet(isPresented: $showingModels) { modelSheet }
  }

  private var navigation: some View {
    HStack(spacing: 10) {
      Button {
        if selectedTask != nil {
          selectedTask = nil
          composerFocused = false
        } else {
          onClose()
        }
      } label: {
        Image(systemName: "chevron.left")
          .font(.system(size: 18, weight: .semibold))
          .frame(width: 44, height: 44)
      }
      .accessibilityLabel(selectedTask == nil ? "Back to design studies" : "Back to chats")
      if selectedTask == nil {
        Text("QM")
          .font(.system(size: 30, weight: .heavy, design: .rounded))
          .tracking(-1.4)
        Text("LIVE")
          .font(.system(size: 10, weight: .heavy, design: .rounded))
          .tracking(1)
          .padding(.horizontal, 7)
          .padding(.vertical, 4)
          .background(yellow, in: Capsule())
          .foregroundStyle(ink)
      } else {
        VStack(alignment: .leading, spacing: 2) {
          Text("PRODUCT WORKSPACE").font(.system(size: 10, weight: .bold)).tracking(1.4)
          Text("Chat with QM").font(.headline)
        }
      }
      Spacer()
      Button {
        if selectedTask == nil { openTask("A new idea") } else { showingModels = true }
      } label: {
        Image(systemName: selectedTask == nil ? "plus" : "ellipsis")
          .font(.system(size: 19, weight: .semibold))
          .frame(width: 44, height: 44)
          .background(.white, in: Circle())
      }
      .accessibilityLabel(selectedTask == nil ? "Start a new chat" : "Choose model")
    }
    .padding(.trailing, 20)
    .padding(.leading, 8)
    .padding(.vertical, 8)
  }

  private var home: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Chats").font(.system(size: 36, weight: .bold)).tracking(-1.1)
          Text("Pick up where you left off.").font(.subheadline).foregroundStyle(muted)
        }
        HStack(spacing: 8) {
          ForEach(["All", "Working", "Needs you"], id: \.self) { filter in
            Button {
              selectedFilter = filter
            } label: {
              Text(filter)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 17)
                .frame(minHeight: 44)
                .background(selectedFilter == filter ? yellow : .white, in: Capsule())
                .foregroundStyle(ink)
            }
            .accessibilityAddTraits(selectedFilter == filter ? .isSelected : [])
          }
          Spacer(minLength: 0)
        }
        VStack(spacing: 12) {
          if selectedFilter != "Needs you" {
            chatCard(
              title: "A sharper launch brief", state: "WORKING",
              preview:
                "I’m reviewing the interviews and mapping the strongest themes against your positioning.",
              time: "Now", working: true)
          }
          if selectedFilter != "Working" {
            chatCard(
              title: "Website accessibility audit", state: "NEEDS YOU",
              preview:
                "The audit is ready. Start with the three keyboard blockers, then review the remaining findings.",
              time: "10:32", working: false)
          }
          if selectedFilter == "All" {
            chatCard(
              title: "Your morning briefing", state: "SCHEDULED",
              preview:
                "Your next briefing will cover active projects, pending reviews, and upcoming deadlines.",
              time: "09:15", working: false)
            chatCard(
              title: "Customer interview themes", state: "COMPLETE",
              preview: "Four themes emerged. Customers valued knowing the next step most.",
              time: "Yesterday", working: false)
          }
        }
        Button {
          openTask("A new idea")
        } label: {
          Label("New chat", systemImage: "square.and.pencil")
            .font(.system(size: 15, weight: .semibold))
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(ink, in: RoundedRectangle(cornerRadius: 18))
            .foregroundStyle(.white)
        }
      }
      .padding(20)
      .padding(.top, 8)
      .padding(.bottom, 16)
      .frame(maxWidth: 640)
      .frame(maxWidth: .infinity)
    }
  }

  private func chatCard(title: String, state: String, preview: String, time: String, working: Bool)
    -> some View
  {
    Button {
      openTask(title)
    } label: {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 5) {
          Image(
            systemName: working
              ? "circle.dotted" : state == "NEEDS YOU" ? "circle.inset.filled" : "checkmark.circle")
          Text(state).tracking(0.8)
          Spacer()
          Text(time).fontWeight(.medium).foregroundStyle(muted)
        }
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(working ? accent : ink)
        Text(title)
          .font(.system(size: 19, weight: .semibold))
          .tracking(-0.3)
        Text(preview)
          .font(.system(size: 14))
          .lineSpacing(3)
          .lineLimit(2)
          .foregroundStyle(muted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(20)
      .background(.white, in: RoundedRectangle(cornerRadius: 20))
    }
    .buttonStyle(.plain)
  }

  private var bottomBar: some View {
    HStack {
      Button {
        selectedFilter = "All"
      } label: {
        Label("Chats", systemImage: "bubble.left.and.bubble.right.fill")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(selectedFilter == "All" ? accent : muted)
          .frame(minHeight: 44)
      }
      Spacer()
      Button {
        selectedFilter = "Needs you"
      } label: {
        Label("Needs you", systemImage: "tray")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(selectedFilter == "Needs you" ? accent : muted)
          .frame(minHeight: 44)
      }
      Spacer()
      Button {
        openTask("A new idea")
      } label: {
        Image(systemName: "plus")
          .font(.system(size: 19, weight: .semibold))
          .frame(width: 46, height: 46)
          .background(accent, in: Circle())
          .foregroundStyle(.white)
      }
      .accessibilityLabel("New chat")
    }
    .padding(.horizontal, 28)
    .padding(.vertical, 10)
    .background(.white)
  }

  private func conversation(_ title: String) -> some View {
    let details = taskDetails(title)
    return ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 5) {
              Image(systemName: "bolt.fill")
              Text(details.status).tracking(1)
              Spacer()
              Text(title == "A sharper launch brief" ? "3 AGENTS WORKING" : "LOCAL DEMO")
                .foregroundStyle(muted)
            }
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(accent)
            Text(title).font(.system(size: 31, weight: .bold)).tracking(-0.8)
            HStack {
              Text(title == "A new idea" ? "READY WHEN YOU ARE" : "PRODUCT WORKSPACE")
              Spacer()
              Text(title == "A sharper launch brief" ? "3 AGENTS · 4 SOURCES" : "QM")
            }
            .font(.system(size: 9, weight: .semibold)).tracking(0.7).foregroundStyle(muted)
          }
          .padding(20)
          .background(.white, in: RoundedRectangle(cornerRadius: 22))
          if title != "A new idea" {
            VStack(spacing: 10) {
              Text("TODAY, 10:38 AM").font(.system(size: 10, weight: .semibold)).tracking(1)
                .foregroundStyle(muted)
                .frame(maxWidth: .infinity)
              HStack {
                Spacer(minLength: 35)
                Text(details.prompt)
                  .font(.system(size: 15)).lineSpacing(4)
                  .padding(16)
                  .background(
                    Color(red: 0.88, green: 0.90, blue: 0.92),
                    in: RoundedRectangle(cornerRadius: 20))
              }
            }
          }
          VStack(alignment: .leading, spacing: 14) {
            assistantLabel
            Text(title == "A new idea" ? "Where should we start?" : "Your latest task update.")
              .font(.system(size: 22, weight: .semibold)).tracking(-0.4)
            Text(details.summary)
              .font(.system(size: 15)).lineSpacing(5)
              .foregroundStyle(ink.opacity(0.85))
            if title == "A sharper launch brief" { workflow }
          }
          ForEach(messages) { message in
            VStack(alignment: .leading, spacing: 10) {
              if !message.isUser { assistantLabel }
              Text(message.text)
                .font(.system(size: 15)).lineSpacing(4)
                .padding(message.isUser ? 16 : 0)
                .background(
                  message.isUser ? Color(red: 0.88, green: 0.90, blue: 0.92) : .clear,
                  in: RoundedRectangle(cornerRadius: 20)
                )
                .frame(maxWidth: .infinity, alignment: message.isUser ? .trailing : .leading)
            }
            .id(message.id)
          }
          Color.clear.frame(height: 1).id("bottom")
        }
        .padding(20)
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: messages.count) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
          proxy.scrollTo("bottom", anchor: .bottom)
        }
      }
    }
  }

  private var assistantLabel: some View {
    HStack(spacing: 8) {
      Image(systemName: "sparkles")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 28, height: 28)
        .background(accent, in: RoundedRectangle(cornerRadius: 9))
      Text("QM").font(.system(size: 14, weight: .bold))
      Text("·").foregroundStyle(muted)
      Text("Live update").font(.system(size: 11)).foregroundStyle(muted)
    }
  }

  private var workflow: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { workflowExpanded.toggle() }
      } label: {
        HStack(spacing: 12) {
          Image(systemName: "list.bullet.rectangle")
            .font(.system(size: 22)).foregroundStyle(accent)
          VStack(alignment: .leading, spacing: 4) {
            Text("Agent activity").font(.system(size: 15, weight: .semibold))
            Text("Research underway · 2 of 4 steps").font(.system(size: 11)).foregroundStyle(muted)
          }
          Spacer()
          Image(systemName: workflowExpanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 12, weight: .semibold)).foregroundStyle(muted)
        }
        .padding(18)
      }
      .accessibilityValue(workflowExpanded ? "Expanded" : "Collapsed")
      if workflowExpanded {
        VStack(alignment: .leading, spacing: 18) {
          step(
            "checkmark.circle.fill", "Brief received", "10:38 AM · Context ready", complete: true)
          step(
            "bolt.circle.fill", "Research in progress",
            "3 agents · Interviews, market, positioning", complete: false)
          step(
            "circle", "Build the narrative", "Next · Bring the strongest themes together",
            complete: false)
          step("circle", "Ready for your review", "Estimated 10:42 AM", complete: false)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 20)
      }
      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Rectangle().fill(accent.opacity(0.12))
          Rectangle().fill(accent).frame(width: geometry.size.width * 0.54)
        }
      }
      .frame(height: 3)
    }
    .background(.white, in: RoundedRectangle(cornerRadius: 18))
    .clipShape(RoundedRectangle(cornerRadius: 18))
  }

  private func step(_ symbol: String, _ title: String, _ subtitle: String, complete: Bool)
    -> some View
  {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol).font(.system(size: 19)).foregroundStyle(
        complete ? Color.green : accent)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.system(size: 13, weight: .semibold))
        Text(subtitle).font(.system(size: 11)).foregroundStyle(muted)
      }
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if attachmentAdded {
        Button {
          attachmentAdded = false
        } label: {
          Label("Research notes.pdf  ×", systemImage: "doc.fill")
            .font(.caption).padding(8)
            .frame(minHeight: 44)
            .background(paper, in: Capsule())
        }
        .accessibilityLabel("Remove Research notes PDF")
      }
      HStack(alignment: .bottom, spacing: 8) {
        Button {
          attachmentAdded.toggle()
        } label: {
          Image(systemName: "plus").font(.system(size: 20))
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Attach demo research notes")
        TextField("Send an update…", text: $draft, axis: .vertical)
          .font(.system(size: 16)).lineLimit(1...4)
          .padding(.vertical, 12)
          .focused($composerFocused)
        Button(action: send) {
          Image(systemName: "arrow.up")
            .font(.system(size: 18, weight: .bold))
            .frame(width: 44, height: 44)
            .background(accent, in: Circle())
            .foregroundStyle(.white)
        }
        .accessibilityLabel("Send message")
        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !attachmentAdded)
        .opacity(
          draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !attachmentAdded
            ? 0.45 : 1)
      }
      HStack(spacing: 5) {
        Button {
          showingModels = true
        } label: {
          HStack(spacing: 5) {
            Text(model).font(.system(size: 10, weight: .semibold))
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
          }
          .frame(minHeight: 44)
        }
        Spacer()
        Text("LOCAL DESIGN DEMO").font(.system(size: 8, weight: .medium)).tracking(1)
      }
      .foregroundStyle(muted)
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .background(.white)
  }

  private var modelSheet: some View {
    NavigationStack {
      List(["GPT-5.4", "Claude Opus", "Gemini Pro"], id: \.self) { choice in
        Button {
          model = choice
          showingModels = false
        } label: {
          HStack {
            Text(choice).foregroundStyle(ink)
            Spacer()
            if model == choice { Image(systemName: "checkmark").foregroundStyle(accent) }
          }
          .frame(minHeight: 44)
        }
      }
      .navigationTitle("Choose your model")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { showingModels = false } }
      }
    }
    .presentationDetents([.medium])
    .tint(accent)
  }

  private func openTask(_ title: String) {
    selectedTask = title
    draft = ""
    messages = []
    workflowExpanded = false
    attachmentAdded = false
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty || attachmentAdded else { return }
    let message =
      attachmentAdded
      ? [text, "Research notes.pdf"].filter { !$0.isEmpty }.joined(separator: "\n") : text
    messages.append(FlightyMessage(text: message, isUser: true))
    draft = ""
    composerFocused = false
    let response =
      attachmentAdded
      ? "Research notes added to this demo task. I’ll use them to ground the brief and flag the strongest evidence for your review."
      : "Update received. In this local demo, I’ve added your direction to the task. The next step is to gather the relevant context and prepare a focused recommendation."
    messages.append(FlightyMessage(text: response, isUser: false))
    attachmentAdded = false
  }

  private func taskDetails(_ title: String) -> (
    status: String, prompt: String, summary: String
  ) {
    switch title {
    case "A sharper launch brief":
      (
        "IN PROGRESS",
        "Turn our customer research into a clear launch brief. Keep it focused on what makes us different.",
        "I’m reviewing the interviews and mapping the strongest themes against your positioning. Three agents are working in parallel."
      )
    case "Website accessibility audit":
      (
        "READY FOR YOU",
        "Audit the website for accessibility issues and prioritize the fixes.",
        "The audit is ready. Twelve findings cover contrast, keyboard navigation, and accessible names. Start with the three keyboard blockers, then review the remaining improvements."
      )
    case "Your morning briefing":
      (
        "SCHEDULED",
        "Prepare a short briefing every weekday at 8 AM with project updates and anything that needs my attention.",
        "Your next briefing is scheduled for tomorrow at 8:00 AM in this demo. It will include active projects, pending reviews, and upcoming deadlines."
      )
    case "Customer interview themes":
      (
        "COMPLETED", "Summarize the six customer interviews into the main themes.",
        "Four themes emerged: simpler setup, reliable handoffs, clearer progress, and fewer notifications. Customers valued knowing the next step most. The summary is ready for your product discussion."
      )
    default:
      (
        "READY", "",
        "Describe what you want to get done, or attach your notes. I’ll help turn it into a clear next step."
      )
    }
  }
}

private struct FlightyMessage: Identifiable {
  let id = UUID()
  let text: String
  let isUser: Bool
}
