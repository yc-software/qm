import SwiftUI

private enum WaymoPalette {
  static let blue = Color(red: 0.00, green: 0.443, blue: 0.945)
  static let ink = Color(red: 0.09, green: 0.14, blue: 0.18)
  static let muted = Color(red: 0.36, green: 0.41, blue: 0.46)
  static let sky = Color(red: 0.91, green: 0.95, blue: 0.99)
  static let ground = Color(red: 0.96, green: 0.97, blue: 0.98)
  static let green = Color(red: 0.00, green: 0.42, blue: 0.32)
}

private enum WaymoWork: String, Identifiable, CaseIterable {
  case launch = "Prepare the launch brief"
  case inbox = "Catch up on my inbox"
  case research = "Research the competition"
  case fresh = "New chat"
  var id: String { rawValue }
  var symbol: String {
    switch self {
    case .launch: "doc.text"
    case .inbox: "tray"
    case .research: "sparkle.magnifyingglass"
    case .fresh: "sparkles"
    }
  }
  var detail: String {
    switch self {
    case .launch: "Putting the final pieces together"
    case .inbox: "Your morning, all caught up"
    case .research: "A clearer picture of the market"
    case .fresh: "Tell QM what you have in mind"
    }
  }
}

struct WaymoStudy: View {
  let onClose: () -> Void
  @State private var work: WaymoWork?
  @State private var selectedTab = 0
  @State private var model = "GPT-6"
  @State private var showModels = false
  @State private var search = ""
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .largeTitle) private var heroSize = 36

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        header
        ScrollView {
          if selectedTab == 0 { home } else { activity }
        }
        .scrollIndicators(.hidden)
      }
      .background(.white)
      .safeAreaInset(edge: .bottom, spacing: 0) { tabBar }
      .toolbar(.hidden, for: .navigationBar)
      .navigationDestination(item: $work) { item in
        WaymoChat(work: item, model: $model, onClose: onClose)
      }
      .sheet(isPresented: $showModels) { WaymoModelSheet(selection: $model) }
    }
    .tint(WaymoPalette.blue)
    .foregroundStyle(WaymoPalette.ink)
    .preferredColorScheme(.light)
  }

  private var header: some View {
    HStack(spacing: 8) {
      Button("All designs", systemImage: "chevron.left", action: onClose)
        .labelStyle(.iconOnly)
        .font(.body.weight(.semibold))
        .frame(width: 44, height: 44)
        .foregroundStyle(WaymoPalette.ink)
      Text("qm").font(.system(.largeTitle, design: .rounded, weight: .bold))
        .tracking(-2)
      Spacer()
      Text("Personal workspace")
        .font(.caption.weight(.medium))
        .foregroundStyle(WaymoPalette.muted)
      Menu {
        Button("Choose model", systemImage: "sparkles") { showModels = true }
        Button("All designs", systemImage: "square.grid.2x2", action: onClose)
      } label: {
        Image(systemName: "person.crop.circle")
          .font(.title2)
          .frame(width: 44, height: 44)
      }
      .accessibilityLabel("Workspace options")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 4)
  }

  private var home: some View {
    VStack(alignment: .leading, spacing: 28) {
      VStack(alignment: .leading, spacing: 20) {
        Text("Chats")
          .font(.system(size: heroSize, weight: .medium, design: .rounded))
          .tracking(-1)
          .padding(.top, 18)
        HStack(spacing: 12) {
          Image(systemName: "magnifyingglass").foregroundStyle(WaymoPalette.muted)
          TextField("Search conversations", text: $search)
            .font(.body)
            .autocorrectionDisabled()
          if !search.isEmpty {
            Button("Clear search", systemImage: "xmark.circle.fill") { search = "" }
              .labelStyle(.iconOnly).frame(width: 44, height: 44)
              .foregroundStyle(WaymoPalette.muted)
          }
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .frame(minHeight: 54)
        .background(.white, in: Capsule())
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 24)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(WaymoPalette.sky)

      VStack(alignment: .leading, spacing: 20) {
        if matches(.launch) {
          HStack {
            Text("Active").font(.title3.weight(.medium))
            Spacer()
            Label("1 working", systemImage: "circle.dotted")
              .font(.caption.weight(.medium)).foregroundStyle(WaymoPalette.blue)
          }
          Button {
            work = .launch
          } label: {
            VStack(alignment: .leading, spacing: 20) {
              HStack(alignment: .top, spacing: 14) {
                Image(systemName: "bubble.left.and.bubble.right")
                  .font(.title2)
                  .foregroundStyle(WaymoPalette.blue)
                  .frame(width: 48, height: 48)
                  .background(.white, in: RoundedRectangle(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 6) {
                  Text("Prepare the launch brief").font(.headline)
                  Text("I've gathered the notes. Bringing the final brief together now.")
                    .font(.subheadline).foregroundStyle(WaymoPalette.muted)
                    .lineLimit(2)
                }
                Spacer(minLength: 0)
              }
              HStack {
                Label("3 agents working", systemImage: "person.2")
                Spacer()
                Text("Now")
              }
              .font(.caption.weight(.medium)).foregroundStyle(WaymoPalette.blue)
            }
            .padding(20)
            .foregroundStyle(WaymoPalette.ink)
            .background(WaymoPalette.sky, in: RoundedRectangle(cornerRadius: 24))
          }
          .buttonStyle(.plain)
        }
        if matches(.inbox) || matches(.research) {
          Text("Recent").font(.title3.weight(.medium)).padding(.top, 4)
          if matches(.inbox) {
            workRow(.inbox, time: "9:24 AM", status: "Three messages need your attention.")
          }
          if matches(.inbox) && matches(.research) { Divider() }
          if matches(.research) {
            workRow(.research, time: "Yesterday", status: "Here's where the opportunity is.")
          }
        }
        if ![WaymoWork.launch, .inbox, .research].contains(where: matches) {
          ContentUnavailableView.search(text: search)
        }
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 24)
    }
    .frame(maxWidth: 680)
    .frame(maxWidth: .infinity)
  }

  private func matches(_ item: WaymoWork) -> Bool {
    search.isEmpty || item.rawValue.localizedCaseInsensitiveContains(search)
  }

  private var activity: some View {
    VStack(alignment: .leading, spacing: 24) {
      Text("Your activity").font(.largeTitle.weight(.medium)).padding(.top, 20)
      Text("A clear view of everything moving forward.")
        .font(.body).foregroundStyle(WaymoPalette.muted)
      HStack(spacing: 16) {
        activityMetric("1", label: "In progress", color: WaymoPalette.blue)
        activityMetric("12", label: "Completed", color: WaymoPalette.green)
      }
      Text("Today").font(.title3.weight(.semibold))
      workRow(.launch, time: "Now", status: "In progress")
      Divider()
      workRow(.inbox, time: "9:24 AM", status: "Ready for you")
      Text("Yesterday").font(.title3.weight(.semibold)).padding(.top, 12)
      workRow(.research, time: "4:12 PM", status: "Completed")
    }
    .padding(24)
    .frame(maxWidth: 680)
    .frame(maxWidth: .infinity)
  }

  private func activityMetric(_ value: String, label: String, color: Color) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(value).font(.largeTitle.weight(.medium)).foregroundStyle(color)
      Text(label).font(.subheadline)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(20)
    .background(WaymoPalette.ground, in: RoundedRectangle(cornerRadius: 24))
  }

  private func workRow(_ item: WaymoWork, time: String, status: String) -> some View {
    Button {
      work = item
    } label: {
      HStack(spacing: 16) {
        Image(systemName: item.symbol)
          .font(.title3)
          .frame(width: 48, height: 48)
          .background(WaymoPalette.ground, in: Circle())
        VStack(alignment: .leading, spacing: 6) {
          Text(item.rawValue).font(.subheadline.weight(.semibold))
          Text(status).font(.caption).foregroundStyle(WaymoPalette.muted)
        }
        Spacer(minLength: 4)
        Text(time).font(.caption).foregroundStyle(WaymoPalette.muted)
      }
      .foregroundStyle(WaymoPalette.ink)
      .frame(minHeight: 64)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var tabBar: some View {
    HStack(spacing: 16) {
      tabButton("Chats", icon: "bubble.left.and.bubble.right.fill", index: 0)
      tabButton("Activity", icon: "clock", index: 1)
      Button {
        work = .fresh
      } label: {
        Label("New chat", systemImage: "plus")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity, minHeight: 52)
          .foregroundStyle(.white)
          .background(WaymoPalette.blue, in: Capsule())
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 24)
    .padding(.top, 12)
    .padding(.bottom, 8)
    .background(.white)
  }

  private func tabButton(_ title: String, icon: String, index: Int) -> some View {
    Button {
      withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { selectedTab = index }
    } label: {
      VStack(spacing: 5) {
        Image(systemName: icon).font(.title3)
        Text(title).font(.caption.weight(.medium))
      }
      .frame(minWidth: 60, minHeight: 52)
      .foregroundStyle(selectedTab == index ? WaymoPalette.blue : WaymoPalette.muted)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selectedTab == index ? .isSelected : [])
  }
}

private struct WaymoMessage: Identifiable {
  let id = UUID()
  let isUser: Bool
  let text: String
}

private struct WaymoChat: View {
  let work: WaymoWork
  @Binding var model: String
  let onClose: () -> Void
  @State private var draft = ""
  @State private var messages: [WaymoMessage] = []
  @State private var showModels = false
  @State private var expanded = false
  @State private var attached = false
  @State private var showResult = false
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @FocusState private var focused: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Button("Back", systemImage: "chevron.left") { dismiss() }
          .labelStyle(.iconOnly).frame(width: 44, height: 44)
        VStack(alignment: .leading, spacing: 4) {
          Text(work == .fresh ? "Let's get started" : work.rawValue)
            .font(.subheadline.weight(.semibold)).lineLimit(1)
          Text(work == .fresh ? "Your personal QM" : "Personal workspace")
            .font(.caption).foregroundStyle(WaymoPalette.muted)
        }
        Spacer(minLength: 0)
        Menu("Conversation options", systemImage: "ellipsis") {
          Button("Choose model", systemImage: "sparkles") { showModels = true }
          Button("All designs", systemImage: "square.grid.2x2", action: onClose)
        }
        .labelStyle(.iconOnly).frame(width: 44, height: 44)
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            if work != .fresh {
              Text("TODAY, 9:41 AM")
                .font(.caption2.weight(.medium)).tracking(1)
                .foregroundStyle(WaymoPalette.muted)
                .frame(maxWidth: .infinity).padding(.top, 8)
              message(WaymoMessage(isUser: true, text: initialRequest))
              assistantHeading
              Text(initialReply).font(.body).lineSpacing(5)
              progressCard
              if work != .launch {
                Button {
                  showResult = true
                } label: {
                  Label(
                    "Open \(work == .inbox ? "morning summary" : "research brief")",
                    systemImage: "doc.text"
                  )
                  .font(.subheadline.weight(.medium)).padding(18)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .background(WaymoPalette.sky, in: RoundedRectangle(cornerRadius: 18))
                }
              }
            } else {
              VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "sparkles").font(.system(size: 36)).foregroundStyle(
                  WaymoPalette.blue)
                Text("Where shall we start?").font(.largeTitle.weight(.medium))
                Text("Big plans. Small to-dos. A clearer day.\nTell QM what you have in mind.")
                  .font(.body).lineSpacing(5).foregroundStyle(WaymoPalette.muted)
                ForEach(
                  ["Plan my week", "Help me research an idea", "Summarize my unread messages"],
                  id: \.self
                ) { idea in
                  Button {
                    draft = idea
                    focused = true
                  } label: {
                    HStack {
                      Text(idea)
                      Spacer()
                      Image(systemName: "arrow.up.left")
                    }
                    .font(.subheadline).padding(18)
                    .background(WaymoPalette.sky, in: RoundedRectangle(cornerRadius: 18))
                  }
                }
              }
              .padding(.top, 44)
            }
            ForEach(messages) { item in message(item) }
            Color.clear.frame(height: 1).id("waymo-latest")
          }
          .padding(24)
          .frame(maxWidth: 680, alignment: .leading)
          .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: messages.count) {
          withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            proxy.scrollTo("waymo-latest", anchor: .bottom)
          }
        }
      }
    }
    .background(.white)
    .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    .toolbar(.hidden, for: .navigationBar)
    .sheet(isPresented: $showModels) { WaymoModelSheet(selection: $model) }
    .sheet(isPresented: $showResult) {
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            Label("Ready for you", systemImage: "checkmark.circle.fill").foregroundStyle(
              WaymoPalette.green)
            Text(work == .inbox ? "Your morning, simplified." : "The market at a glance.").font(
              .largeTitle.weight(.medium))
            Text(
              work == .inbox
                ? "Three messages need your attention. The product review moved to Thursday, the updated designs are ready, and the team would like your feedback on the launch brief."
                : "The strongest opportunity is a focused mobile experience. Three competitors optimize for desktop workflows; none makes parallel agent progress easy to follow on a phone."
            )
            .font(.body).lineSpacing(6)
            Text("This is sample content for the design study.").font(.footnote).foregroundStyle(
              WaymoPalette.muted)
          }.padding(24)
        }
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { showResult = false } }
        }
      }.presentationDragIndicator(.visible)
    }
  }

  private var initialRequest: String {
    switch work {
    case .launch:
      "Pull together a launch brief from our latest notes. Bring in a few agents to help."
    case .inbox: "Catch me up on anything important in my inbox."
    case .research: "Help me understand how the competition approaches mobile AI."
    case .fresh: ""
    }
  }

  private var initialReply: String {
    switch work {
    case .launch:
      "Of course. I'll gather the context, check the details, and bring everything into one clear brief. You can follow along here."
    case .inbox:
      "You're all caught up. I've pulled out the three things that need your attention and set aside everything that can wait."
    case .research:
      "Your research is ready. I've compared the product experiences and highlighted the opportunities worth exploring."
    case .fresh: ""
    }
  }

  private var assistantHeading: some View {
    HStack(spacing: 10) {
      Image(systemName: "sparkles").foregroundStyle(WaymoPalette.blue)
      Text("QM").font(.subheadline.weight(.semibold))
    }
  }

  private func message(_ item: WaymoMessage) -> some View {
    VStack(alignment: item.isUser ? .trailing : .leading, spacing: 12) {
      if !item.isUser { assistantHeading }
      Text(item.text)
        .font(.body).lineSpacing(5)
        .padding(item.isUser ? 18 : 0)
        .background(item.isUser ? WaymoPalette.sky : .clear, in: RoundedRectangle(cornerRadius: 24))
        .frame(maxWidth: .infinity, alignment: item.isUser ? .trailing : .leading)
    }
    .padding(.leading, item.isUser ? 28 : 0)
  }

  private var progressCard: some View {
    VStack(alignment: .leading, spacing: 20) {
      Button {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { expanded.toggle() }
      } label: {
        HStack(spacing: 14) {
          Image(
            systemName: work == .launch
              ? "person.2" : "checkmark"
          )
          .font(.title2).foregroundStyle(WaymoPalette.blue)
          .frame(width: 44, height: 44).background(.white, in: Circle())
          VStack(alignment: .leading, spacing: 4) {
            Text(work == .launch ? "Drafting your launch brief" : "Completed").font(
              .subheadline.weight(.semibold))
            Text(work == .launch ? "3 agents · putting it together" : "3 steps completed")
              .font(.caption).foregroundStyle(WaymoPalette.muted)
          }
          Spacer(minLength: 0)
          Image(systemName: expanded ? "chevron.up" : "chevron.down").font(
            .caption.weight(.semibold))
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(expanded ? "Hide agent progress" : "Show agent progress")
      if expanded {
        VStack(alignment: .leading, spacing: 0) {
          progressStep(
            "Gather context", detail: "Research agent · 8 sources reviewed", complete: true,
            last: false)
          progressStep(
            "Check the details", detail: "Review agent · all facts checked", complete: true,
            last: false)
          progressStep(
            "Bring it together",
            detail: work == .launch
              ? "Writing agent · drafting your brief" : "Writing agent · ready for you",
            complete: work != .launch, last: true)
        }
      } else {
        HStack(spacing: 4) {
          ForEach(0..<3) { index in
            Capsule().fill(
              index < 2 || work != .launch ? WaymoPalette.blue : WaymoPalette.blue.opacity(0.18)
            ).frame(height: 4)
          }
        }
      }
    }
    .padding(20)
    .background(WaymoPalette.sky, in: RoundedRectangle(cornerRadius: 24))
  }

  private func progressStep(_ title: String, detail: String, complete: Bool, last: Bool)
    -> some View
  {
    HStack(alignment: .top, spacing: 16) {
      VStack(spacing: 5) {
        Image(systemName: complete ? "checkmark.circle.fill" : "circle.dotted")
          .font(.title3).foregroundStyle(WaymoPalette.blue)
        if !last { Rectangle().fill(WaymoPalette.blue.opacity(0.18)).frame(width: 2, height: 30) }
      }
      VStack(alignment: .leading, spacing: 5) {
        Text(title).font(.subheadline.weight(.medium))
        Text(detail).font(.caption).foregroundStyle(WaymoPalette.muted)
      }.padding(.bottom, last ? 0 : 22)
    }
  }

  private var composer: some View {
    VStack(spacing: 12) {
      if attached {
        HStack {
          Label("Launch notes.pdf", systemImage: "doc")
          Spacer()
          Button("Remove attachment", systemImage: "xmark") { attached = false }.labelStyle(
            .iconOnly
          )
          .frame(width: 44, height: 44)
        }.font(.caption).padding(.horizontal, 18)
      }
      HStack(alignment: .bottom, spacing: 8) {
        Button("Attach sample file", systemImage: "plus") { attached.toggle() }
          .labelStyle(.iconOnly).font(.title3).frame(width: 44, height: 48)
        TextField("Message QM", text: $draft, axis: .vertical)
          .font(.body).lineLimit(1...5).focused($focused).padding(.vertical, 14)
        Button("Send message", systemImage: "arrow.up") { send() }
          .labelStyle(.iconOnly).font(.body.weight(.semibold))
          .frame(width: 44, height: 44)
          .foregroundStyle(.white)
          .background(canSend ? WaymoPalette.blue : WaymoPalette.muted, in: Circle())
          .disabled(!canSend)
          .padding(4)
      }
      .foregroundStyle(WaymoPalette.ink)
      .padding(.leading, 4)
      .background(WaymoPalette.ground, in: RoundedRectangle(cornerRadius: 28))
      HStack {
        Button {
          showModels = true
        } label: {
          HStack(spacing: 5) {
            Text(model)
            Image(systemName: "chevron.down").font(.caption2)
          }
          .font(.caption.weight(.medium)).frame(minHeight: 44)
        }
        Spacer()
        Text("A little help. A lot done.").font(.caption).foregroundStyle(WaymoPalette.muted)
      }
      .padding(.horizontal, 12)
    }
    .padding(.horizontal, 20).padding(.top, 12)
    .background(.white)
  }

  private var canSend: Bool {
    !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || attached
  }

  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSend else { return }
    messages.append(
      WaymoMessage(
        isUser: true,
        text: [text, attached ? "Attached: Launch notes.pdf" : ""].filter { !$0.isEmpty }.joined(
          separator: "\n\n")))
    messages.append(
      WaymoMessage(
        isUser: false,
        text:
          "I've got it. I'll take care of that with \(model) and bring the next steps back here. This preview uses sample replies, so your workspace stays as it is."
      ))
    draft = ""
    attached = false
    focused = false
  }
}

private struct WaymoModelSheet: View {
  @Binding var selection: String
  @Environment(\.dismiss) private var dismiss
  private let options = [
    ("GPT-6", "A thoughtful all-rounder"), ("Claude Opus", "For the details that matter"),
    ("Gemini Pro", "A fresh perspective"),
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text("The right help\nfor your next step.").font(.largeTitle.weight(.medium))
          Text("Choose the model QM uses for your messages.").foregroundStyle(WaymoPalette.muted)
          ForEach(options, id: \.0) { name, subtitle in
            Button {
              selection = name
              dismiss()
            } label: {
              HStack(spacing: 16) {
                Image(systemName: "sparkles").font(.title2).foregroundStyle(WaymoPalette.blue)
                VStack(alignment: .leading, spacing: 5) {
                  Text(name).font(.headline)
                  Text(subtitle).font(.subheadline).foregroundStyle(WaymoPalette.muted)
                }
                Spacer()
                Image(systemName: selection == name ? "checkmark.circle.fill" : "circle")
                  .font(.title2).foregroundStyle(WaymoPalette.blue)
              }
              .padding(20).foregroundStyle(WaymoPalette.ink)
              .background(
                selection == name ? WaymoPalette.sky : WaymoPalette.ground,
                in: RoundedRectangle(cornerRadius: 22))
            }.buttonStyle(.plain)
          }
          Spacer(minLength: 0)
        }
        .padding(24)
      }
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .preferredColorScheme(.light)
  }
}
