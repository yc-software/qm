import SwiftUI

struct RevolutStudy: View {
  let onClose: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var filter = "All"
  @State private var selectedTask: String?
  @State private var query = ""
  @State private var model = "GPT-5.4"
  @State private var showingSettings = false
  private let blue = Color(red: 0.19, green: 0.40, blue: 1)
  private let surface = Color(red: 0.11, green: 0.11, blue: 0.12)
  private let tasks = [
    RevolutTask(
      title: "Launch the new homepage",
      detail: "The preview is ready. Take a look when you’re ready.",
      symbol: "bubble.left.and.bubble.right", time: "Now", status: "Needs you"),
    RevolutTask(
      title: "Plan the onboarding refresh",
      detail: "Comparing three directions for the first-run experience…", symbol: "sparkles",
      time: "2m", status: "Working"),
    RevolutTask(
      title: "Weekly team briefing",
      detail: "Your priorities, milestones and decisions for Monday.", symbol: "doc.text",
      time: "9:12", status: "Complete"),
    RevolutTask(
      title: "Review the mobile PR", detail: "Three improvements to consider before release.",
      symbol: "chevron.left.forwardslash.chevron.right", time: "8:48", status: "Needs you"),
    RevolutTask(
      title: "Customer interview insights",
      detail: "Twelve interviews. Three themes worth acting on.", symbol: "waveform",
      time: "Yesterday", status: "Complete"),
  ]

  private var filteredTasks: [RevolutTask] {
    tasks.filter { task in
      (filter == "All" || task.status == filter)
        && (query.isEmpty || task.title.localizedCaseInsensitiveContains(query)
          || task.detail.localizedCaseInsensitiveContains(query))
    }
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        header
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            HStack {
              Text("Chats").font(.system(size: 44, weight: .bold)).tracking(-1.5)
              Spacer()
              Button {
                selectedTask = "New task"
              } label: {
                Image(systemName: "plus").font(.system(size: 25, weight: .medium))
                  .frame(width: 52, height: 52).background(blue, in: Circle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel("New chat")
            }
            searchField
            HStack(spacing: 8) {
              ForEach(["All", "Working", "Needs you"], id: \.self) { value in
                Button {
                  withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { filter = value }
                } label: {
                  Text(value).font(.system(size: 14, weight: .semibold))
                    .padding(.horizontal, 18).frame(minHeight: 44)
                    .foregroundStyle(filter == value ? .black : .white.opacity(0.75))
                    .background(filter == value ? .white : surface, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(filter == value ? .isSelected : [])
              }
            }
            conversations
          }
          .padding(.horizontal, 20)
          .padding(.top, 16)
          .padding(.bottom, 28)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
      }
      .background(Color(red: 0.035, green: 0.035, blue: 0.04))
      .foregroundStyle(.white)
      .toolbar(.hidden, for: .navigationBar)
      .navigationDestination(item: $selectedTask) { title in
        RevolutChat(title: title, model: $model)
      }
      .sheet(isPresented: $showingSettings) { settingsSheet }
    }
    .preferredColorScheme(.dark)
    .tint(blue)
  }

  private var header: some View {
    HStack(spacing: 12) {
      Button(action: onClose) {
        Image(systemName: "square.grid.2x2.fill").font(.system(size: 18, weight: .medium))
          .frame(width: 44, height: 44).background(surface, in: Circle())
      }
      .accessibilityLabel("All designs")
      Text("QM").font(.system(size: 24, weight: .black)).tracking(-1)
      Spacer()
      Button {
        showingSettings = true
      } label: {
        Image(systemName: "slider.horizontal.3").font(.system(size: 18, weight: .medium))
          .frame(width: 44, height: 44).background(surface, in: Circle())
      }
      .accessibilityLabel("Chat settings")
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 20)
    .padding(.vertical, 8)
  }

  private var searchField: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass").font(.system(size: 18, weight: .medium))
        .foregroundStyle(.white.opacity(0.6))
      TextField("Search chats", text: $query).font(.system(size: 16))
        .accessibilityLabel("Search conversations")
      if !query.isEmpty {
        Button {
          query = ""
        } label: {
          Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44)
        }.buttonStyle(.plain).accessibilityLabel("Clear search")
      }
    }
    .padding(.leading, 16)
    .padding(.trailing, query.isEmpty ? 16 : 4)
    .frame(minHeight: 52)
    .background(surface, in: RoundedRectangle(cornerRadius: 18))
  }

  private var conversations: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("RECENT").font(.system(size: 11, weight: .semibold)).tracking(1.3)
        .foregroundStyle(.white.opacity(0.5)).padding(.bottom, 2)
      ForEach(filteredTasks) { task in
        Button {
          selectedTask = task.title
        } label: {
          HStack(alignment: .top, spacing: 14) {
            Image(systemName: task.symbol).font(.system(size: 18, weight: .medium))
              .foregroundStyle(task.status == "Complete" ? .white.opacity(0.8) : blue)
              .frame(width: 42, height: 42)
              .background(.white.opacity(0.06), in: Circle())
            VStack(alignment: .leading, spacing: 7) {
              HStack(alignment: .firstTextBaseline) {
                Text(task.title).font(.system(size: 16, weight: .semibold)).lineLimit(2)
                Spacer(minLength: 4)
                Text(task.time).font(.system(size: 10, weight: .medium))
                  .foregroundStyle(.white.opacity(0.5)).fixedSize()
              }
              Text(task.detail).font(.system(size: 13)).lineSpacing(3)
                .foregroundStyle(.white.opacity(0.64)).lineLimit(2)
              if task.status != "Complete" {
                Label(
                  task.status, systemImage: task.status == "Working" ? "sparkle" : "circle.fill"
                )
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(blue).padding(.top, 3)
              }
            }
          }
          .padding(18)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(surface, in: RoundedRectangle(cornerRadius: 22))
        }.buttonStyle(.plain)
      }
      if filteredTasks.isEmpty {
        ContentUnavailableView(
          query.isEmpty ? "No chats here yet" : "No matching chats",
          systemImage: "bubble.left.and.bubble.right",
          description: Text(
            query.isEmpty
              ? "Try another filter or start a new chat." : "Try a different title or phrase.")
        )
      }
    }
  }

  private var settingsSheet: some View {
    NavigationStack {
      Form {
        Section("Conversations") {
          Picker("Default model", selection: $model) {
            Text("GPT-5.4").tag("GPT-5.4")
            Text("Claude Opus").tag("Claude Opus")
            Text("Gemini Pro").tag("Gemini Pro")
          }
        }
      }
      .navigationTitle("Chat settings")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { showingSettings = false } }
      }
    }
    .presentationDetents([.medium])
    .presentationDragIndicator(.visible)
  }
}

private struct RevolutTask: Identifiable {
  var id: String { title }
  let title: String
  let detail: String
  let symbol: String
  let time: String
  let status: String
}

private struct RevolutMessage: Identifiable {
  let id = UUID()
  let text: String
  let isUser: Bool
}

private struct RevolutChat: View {
  let title: String
  @Binding var model: String
  @Environment(\.dismiss) private var dismiss
  @State private var draft = ""
  @State private var messages: [RevolutMessage] = []
  @State private var expandedActivity = false
  @State private var showingPreview = false
  @State private var approved = false
  private let blue = Color(red: 0.19, green: 0.40, blue: 1)
  private let surface = Color(red: 0.11, green: 0.11, blue: 0.12)

  private var isHomepage: Bool {
    title == "Launch the new homepage" || title == "Homepage preview"
  }

  private var sample: (prompt: String, summary: String, highlights: [String]) {
    switch title {
    case "Plan the onboarding refresh":
      return (
        "Explore three ways to make the first-run experience simpler and more useful.",
        "I’m comparing three directions for onboarding: a guided first conversation, a short project setup and an example-led introduction. I’ll bring back the tradeoffs and a recommendation.",
        [
          "Reviewing the current first-run flow", "Comparing the three directions",
          "Preparing a recommended approach",
        ]
      )
    case "Weekly team briefing", "Weekly briefing":
      return (
        "Bring me up to speed on the team’s priorities for this week.",
        "Your Monday briefing is ready. I pulled together the project updates, upcoming milestones and decisions that need your attention.",
        [
          "Homepage review is ready for you", "Mobile release checks are complete",
          "Customer interview findings are ready to share",
        ]
      )
    case "Review the mobile PR":
      return (
        "Review the mobile changes and flag anything we should fix before shipping.",
        "The mobile review is complete. I checked the conversation flow, accessibility and keyboard behaviour, and found three improvements to make before release.",
        [
          "Keep the composer visible above the keyboard",
          "Give icon buttons clear accessibility labels",
          "Preserve the draft when returning to a conversation",
        ]
      )
    case "Customer interview insights", "Interview insights":
      return (
        "Find the recurring themes across our twelve customer interviews.",
        "Twelve interviews, three clear themes. People want less setup, better visibility into work in progress and an easier way to find finished results.",
        [
          "Start useful work from the first conversation",
          "Show what agents are doing and what comes next",
          "Keep completed deliverables easy to find",
        ]
      )
    case "Launch the new homepage", "Homepage preview":
      return (
        "Bring the homepage together. Make it feel polished and ready to ship.",
        "The new homepage is ready. I brought the copy, design and implementation together, then had a second agent check every detail.",
        []
      )
    default:
      return (
        "Help me with \(title.lowercased()).",
        "This conversation is ready for your next step. Tell me what you want to work on.",
        ["Add your request to get started"]
      )
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "arrow.left").font(.system(size: 20, weight: .medium)).frame(
            width: 44, height: 44
          ).background(surface, in: Circle())
        }.accessibilityLabel("Back to conversations")
        VStack(alignment: .leading, spacing: 4) {
          Text(title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
          Menu {
            Picker("Model", selection: $model) {
              Text("GPT-5.4").tag("GPT-5.4")
              Text("Claude Opus").tag("Claude Opus")
              Text("Gemini Pro").tag("Gemini Pro")
            }
          } label: {
            HStack(spacing: 5) {
              Text(model)
              Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
            }
            .font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
            .frame(minHeight: 44)
          }.accessibilityLabel("Choose model, \(model)")
        }
        Spacer(minLength: 0)
        if isHomepage {
          Button {
            expandedActivity.toggle()
          } label: {
            Image(systemName: "ellipsis").frame(width: 44, height: 44).background(
              surface, in: Circle())
          }.accessibilityLabel("Show agent activity")
        }
      }
      .buttonStyle(.plain)
      .padding(.horizontal, 20).padding(.vertical, 8)
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 22) {
            Text("TODAY, 9:41").font(.system(size: 10, weight: .semibold)).tracking(1)
              .foregroundStyle(.white.opacity(0.45)).frame(maxWidth: .infinity).padding(.top, 12)
            if title != "New task" {
              messageBubble(sample.prompt, user: true)
              HStack(spacing: 9) {
                Text("QM").font(.system(size: 12, weight: .black)).frame(width: 30, height: 30)
                  .foregroundStyle(.black).background(.white, in: Circle())
                Text(
                  title == "Plan the onboarding refresh" ? "Working on it." : "All taken care of."
                ).font(.system(size: 24, weight: .bold)).tracking(-0.6)
              }
              Text(sample.summary)
                .font(.system(size: 16)).lineSpacing(5).foregroundStyle(.white.opacity(0.88))
              if isHomepage {
                activityCard
                previewCard
                Text(
                  approved
                    ? "Approved. Your homepage is ready for the next step."
                    : "Take a look when you're ready. Everything is saved in your workspace."
                )
                .font(.system(size: 16)).lineSpacing(5).foregroundStyle(.white.opacity(0.88))
                if !approved {
                  Button {
                    approved = true
                  } label: {
                    Text("Looks good, approve").font(.system(size: 14, weight: .semibold)).padding(
                      .horizontal, 18
                    ).frame(height: 44).foregroundStyle(blue).background(
                      blue.opacity(0.15), in: Capsule())
                  }.buttonStyle(.plain)
                }
              } else {
                VStack(alignment: .leading, spacing: 18) {
                  Text("At a glance").font(.system(size: 19, weight: .bold))
                  ForEach(sample.highlights, id: \.self) { highlight in
                    HStack(alignment: .top, spacing: 12) {
                      Image(systemName: "checkmark.circle.fill").foregroundStyle(blue)
                      Text(highlight).font(.system(size: 15)).lineSpacing(4)
                    }
                  }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(surface, in: RoundedRectangle(cornerRadius: 22))
              }
            } else {
              VStack(alignment: .leading, spacing: 12) {
                Text("A little less busy.\nA lot more done.").font(.system(size: 38, weight: .bold))
                  .tracking(-1.2)
                Text("Tell QM what you're working on.").foregroundStyle(.white.opacity(0.6))
              }.padding(.vertical, 32)
            }
            ForEach(messages) { message in
              messageBubble(message.text, user: message.isUser).id(message.id)
            }
            Color.clear.frame(height: 1).id("bottom")
          }.padding(.horizontal, 24).padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
        .onChange(of: messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      composer
    }
    .background(Color(red: 0.035, green: 0.035, blue: 0.04))
    .foregroundStyle(.white)
    .toolbar(.hidden, for: .navigationBar)
    .sheet(isPresented: $showingPreview) {
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 22) {
            Text("YOUR WORK,\nWITHOUT THE WORK.").font(.system(size: 42, weight: .black)).tracking(
              -1.6)
            Text("Meet the team that keeps things moving.").font(.title3)
            Text(
              "One place for your ideas, your tasks, and the work that matters. QM brings it all together."
            ).foregroundStyle(.secondary)
            Label("Responsive layout checked", systemImage: "checkmark.circle.fill")
            Label("Keyboard navigation checked", systemImage: "checkmark.circle.fill")
            Label("All links checked", systemImage: "checkmark.circle.fill")
          }.padding(28)
        }
        .navigationTitle("Homepage preview")
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { showingPreview = false } }
        }
      }.presentationDragIndicator(.visible)
    }
  }

  private func messageBubble(_ text: String, user: Bool) -> some View {
    HStack {
      if user { Spacer(minLength: 28) }
      Text(text).font(.system(size: 16)).lineSpacing(4)
        .padding(user ? 18 : 0)
        .background(user ? surface : .clear, in: RoundedRectangle(cornerRadius: 22))
      if !user { Spacer(minLength: 12) }
    }
  }

  private var activityCard: some View {
    DisclosureGroup(isExpanded: $expandedActivity) {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(
          [
            "Research · Read the brief and existing pages", "Build · Updated 6 files",
            "Review · Verified layout and links",
          ], id: \.self
        ) { step in
          Label(step, systemImage: "checkmark.circle.fill").font(.system(size: 13)).foregroundStyle(
            .white.opacity(0.75))
        }
      }.padding(.top, 16)
    } label: {
      HStack(spacing: 10) {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(blue).font(.system(size: 20))
        VStack(alignment: .leading, spacing: 4) {
          Text("3 agents. One great result.").font(.system(size: 14, weight: .semibold))
          Text("Research, build and review · 2m 18s").font(.system(size: 11)).foregroundStyle(
            .white.opacity(0.58))
        }
      }.frame(minHeight: 44)
    }.padding(16).background(surface, in: RoundedRectangle(cornerRadius: 20)).tint(
      .white.opacity(0.6))
  }

  private var previewCard: some View {
    Button {
      showingPreview = true
    } label: {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .top) {
          VStack(alignment: .leading, spacing: 10) {
            Text("QM").font(.system(size: 11, weight: .black))
            Text("BIG IDEAS.\nTAKEN CARE OF.").font(.system(size: 26, weight: .black)).tracking(
              -0.9)
            Text("Meet your new unfair advantage.").font(.system(size: 10, weight: .medium))
          }
          Spacer()
          Image(systemName: "arrow.up.right").font(.system(size: 26, weight: .bold))
        }
        .padding(24).frame(maxWidth: .infinity, alignment: .leading).foregroundStyle(.black)
        .background(Color(red: 0.91, green: 0.94, blue: 0.98))
        HStack {
          Image(systemName: "safari").foregroundStyle(blue)
          Text("Homepage preview").font(.system(size: 14, weight: .semibold))
          Spacer()
          Image(systemName: "arrow.up.right").font(.system(size: 13, weight: .semibold))
        }.padding(18).background(surface)
      }.clipShape(RoundedRectangle(cornerRadius: 22))
    }.buttonStyle(.plain)
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: 12) {
      Menu {
        Button("Add project brief", systemImage: "doc.text") {
          draft += " Review the project brief."
        }
        Button("Add a task", systemImage: "checklist") { draft += " Help me plan the next steps." }
      } label: {
        Image(systemName: "plus").font(.system(size: 23, weight: .medium)).frame(
          width: 44, height: 44)
      }.accessibilityLabel("Add context")
      TextField("Message QM", text: $draft, axis: .vertical)
        .font(.system(size: 16)).lineLimit(1...5).padding(.vertical, 12)
        .accessibilityLabel("Message QM")
      Button(action: send) {
        Image(systemName: "arrow.up").font(.system(size: 20, weight: .semibold)).frame(
          width: 44, height: 44
        ).background(
          draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? Color.white.opacity(0.16) : blue, in: Circle())
      }
      .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .accessibilityLabel("Send message")
    }
    .buttonStyle(.plain).padding(8).background(surface, in: RoundedRectangle(cornerRadius: 30))
    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    messages.append(RevolutMessage(text: text, isUser: true))
    messages.append(
      RevolutMessage(
        text:
          "On it. I’ll bring this together and keep the next steps in this conversation. This design preview uses local sample replies.",
        isUser: false))
    draft = ""
  }
}
