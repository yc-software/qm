import SwiftUI

struct NativeChatMessageView: View {
  let message: ChatMessage
  let client: APIClient
  let showSpeaker: Bool
  let user: String
  var conversationID: String? = nil
  var onFork: (() -> Void)? = nil
  var onAskAbout: ((ChatMessage) -> Void)? = nil
  var forking = false
  var streaming = false

  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  private var isUser: Bool { message.role == "user" }

  var askAbout: (() -> Void)? {
    guard let onAskAbout, message.role == "assistant", message.sequence != nil,
      !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return nil }
    return { onAskAbout(message) }
  }

  private var messageLink: URL? {
    guard let conversationID, let sequence = message.sequence else { return nil }
    var components = URLComponents(
      url: client.baseURL.appendingPathComponent("s").appendingPathComponent(conversationID),
      resolvingAgainstBaseURL: false)
    components?.queryItems = [.init(name: "seq", value: String(sequence))]
    return components?.url
  }

  var body: some View {
    if let notice = message.notice {
      noticeView(notice)
    } else {
      messageBody
    }
  }

  private var messageBody: some View {
    NativeMessageLayout(isUser: isUser, compact: horizontalSizeClass != .regular) {
      VStack(alignment: .leading, spacing: 8) {
        if message.steered {
          Label("Steered the running task", systemImage: "arrow.turn.down.right")
            .font(.caption).foregroundStyle(.secondary)
        }
        if message.role == "error" {
          Label("Task failed", systemImage: "exclamationmark.circle")
            .font(.subheadline.weight(.medium)).foregroundStyle(.red)
        } else if showSpeaker {
          Text(isUser ? message.speaker ?? "Input" : "QM")
            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        }
        if !message.text.isEmpty {
          MessageMarkdown(text: message.text, client: client, files: message.referencedFiles)
            .lineSpacing(3)
        }
        if message.deleted || message.edited {
          Label(
            message.deleted ? "Deleted in Slack" : "Edited in Slack",
            systemImage: message.deleted ? "trash" : "pencil"
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        ForEach(message.playgrounds) { artifact in
          NativePlaygroundCard(artifact: artifact, client: client)
        }
        ForEach(Array(message.files.enumerated()), id: \.offset) { _, file in
          FileAttachmentView(file: file, client: client)
        }
        if forking {
          NativeActionLabel(
            title: "Fork from here", busyTitle: "Forking conversation…", busy: true
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
      }
      .padding(.horizontal, isUser ? 14 : 0)
      .padding(.vertical, isUser ? 10 : 0)
      .background(
        isUser ? QMTheme.surface.opacity(0.76) : .clear,
        in: RoundedRectangle(cornerRadius: 18)
      )
    }
    .tint(.brown)
    .contextMenu { if !streaming { messageActions } }
  }

  @ViewBuilder private func noticeView(_ notice: ChatNotice) -> some View {
    switch notice {
    case .approval(let approved, let command, let scope):
      VStack(alignment: .leading, spacing: 6) {
        Label(
          approvalLabel(approved: approved, scope: scope),
          systemImage: approved ? "checkmark.shield" : "xmark.shield"
        )
        .font(.caption.weight(.medium))
        Text(command).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
      }
      .foregroundStyle(.secondary)
      .padding(.vertical, 4)
    case .revision(let action, let speaker, let text):
      VStack(alignment: .leading, spacing: 6) {
        Label(
          "\(speaker?.isEmpty == false ? speaker! : "The user") \(action == "deleted" ? "deleted" : "edited") their message",
          systemImage: action == "deleted" ? "trash" : "pencil"
        )
        .font(.caption)
        if action == "edited", !text.isEmpty {
          Text(text).font(.footnote).textSelection(.enabled)
        }
      }
      .foregroundStyle(.secondary)
      .padding(.vertical, 4)
    case .subagent(let mail):
      NavigationLink {
        NativeConversationDestination(client: client, user: user, sessionID: mail.sessionID)
      } label: {
        subagentLabel(mail)
      }
      .buttonStyle(.plain)
    case .stopped:
      Label("Stopped", systemImage: "stop.circle")
        .font(.caption).foregroundStyle(.secondary)
        .padding(.vertical, 4)
    }
  }

  private func subagentLabel(_ mail: SubagentMail) -> some View {
    HStack(spacing: 10) {
      NativeAgentAvatar(
        sessionID: mail.sessionID, returned: ["final_answer", "no_reply"].contains(mail.kind)
      )
      .frame(width: 32, height: 32)
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(mail.title).font(.subheadline.weight(.medium))
        Text(mail.status).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption)
    }
    .frame(minHeight: 44)
    .tint(.brown)
  }

  private func approvalLabel(approved: Bool, scope: String?) -> String {
    guard approved else { return "Approval denied" }
    switch scope ?? "once" {
    case "once": return "Approved once"
    case "session": return "Approved for this session"
    case "always": return "Approved always"
    default: return "Approved"
    }
  }

  @ViewBuilder private var messageActions: some View {
    if !message.text.isEmpty {
      Button("Copy message", systemImage: "doc.on.doc") {
        UIPasteboard.general.string = message.text
      }
      ShareLink(item: message.text) { Label("Share message", systemImage: "square.and.arrow.up") }
    }
    if let messageLink {
      Button("Copy message link", systemImage: "link") {
        UIPasteboard.general.url = messageLink
      }
    }
    if let onFork {
      Button("Fork from here", systemImage: "arrow.triangle.branch", action: onFork)
    }
    if let askAbout {
      Button("Ask about this message", systemImage: "text.bubble", action: askAbout)
    }
  }
}

private struct NativeMessageLayout: Layout {
  let isUser: Bool
  let compact: Bool

  private func contentProposal(_ proposal: ProposedViewSize) -> ProposedViewSize {
    guard isUser, let width = proposal.width else { return proposal }
    return ProposedViewSize(width: compact ? width * 0.86 : min(width * 0.72, 620), height: nil)
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let content = subviews.first else { return .zero }
    let size = content.sizeThatFits(contentProposal(proposal))
    return CGSize(width: proposal.width ?? size.width, height: size.height)
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    subviews.first?.place(
      at: CGPoint(x: isUser ? bounds.maxX : bounds.minX, y: bounds.minY),
      anchor: isUser ? .topTrailing : .topLeading,
      proposal: contentProposal(ProposedViewSize(width: bounds.width, height: nil)))
  }
}
