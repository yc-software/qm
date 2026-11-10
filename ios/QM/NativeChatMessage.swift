import SwiftUI

struct NativeChatMessageView: View {
  let message: ChatMessage
  let client: APIClient
  let showSpeaker: Bool
  let user: String
  var conversationID: String? = nil
  var onFork: (() -> Void)? = nil
  @State private var copied = false
  @State private var expanded = false
  @State private var messageHeight: CGFloat = 0
  @ScaledMetric(relativeTo: .body) private var collapsedHeight: CGFloat = 150

  private var isUser: Bool { message.role == "user" }

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
    VStack(alignment: .leading, spacing: 10) {
      if message.steered {
        Label("Steered the running task", systemImage: "arrow.turn.down.right")
          .font(.caption).foregroundStyle(.secondary)
      }
      if message.role == "error" {
        Label("Task failed", systemImage: "exclamationmark.circle")
          .font(.subheadline.weight(.medium)).foregroundStyle(.red)
      } else if showSpeaker {
        Text(isUser ? message.speaker ?? "Participant" : "QM")
          .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      }
      if !isUser {
        NativeWorkSummary(
          activity: message.activity, client: client, turnFailed: message.role == "error",
          finishedAt: message.createdAt)
      }
      if !message.text.isEmpty {
        MessageMarkdown(text: message.text, client: client, files: message.referencedFiles)
          .fixedSize(horizontal: false, vertical: true)
          .onGeometryChange(for: CGFloat.self) {
            $0.size.height
          } action: {
            if isUser { messageHeight = $0 }
          }
          .frame(maxHeight: isUser && !expanded ? collapsedHeight : nil, alignment: .top)
          .clipped()
          .overlay(alignment: .bottom) {
            if isUser, !expanded, messageHeight > collapsedHeight {
              LinearGradient(
                colors: [QMTheme.surface.opacity(0), QMTheme.surface], startPoint: .top,
                endPoint: .bottom
              )
              .frame(height: 24).allowsHitTesting(false).accessibilityHidden(true)
            }
          }
        if isUser, messageHeight > collapsedHeight {
          Button(
            expanded ? "Show less" : "Show more",
            systemImage: expanded ? "chevron.up" : "chevron.down"
          ) {
            expanded.toggle()
          }
          .font(.footnote).foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .trailing)
        }
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
      if !isUser, !message.text.isEmpty {
        HStack(spacing: 4) {
          Button {
            UIPasteboard.general.string = message.text
            copied = true
          } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel(copied ? "Copied message" : "Copy message")
          ShareLink(item: message.text) {
            Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44)
          }.accessibilityLabel("Share message")
          Menu {
            messageActions
          } label: {
            Image(systemName: "ellipsis").frame(width: 44, height: 44)
          }.accessibilityLabel("More message actions")
          Spacer(minLength: 0)
          if let timestamp = message.createdAt {
            Text(Date(timeIntervalSince1970: timestamp / 1000), style: .time)
              .font(.caption2)
          }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.leading, -10)
        .padding(.top, -4)
        .padding(.bottom, -10)
      }
    }
    .padding(isUser ? 14 : 0)
    .background(isUser ? QMTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 20))
    .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    .padding(.leading, isUser ? 28 : 0)
    .contextMenu { messageActions }
    .task(id: copied) {
      guard copied else { return }
      do {
        try await Task.sleep(for: .seconds(2))
        copied = false
      } catch {}
    }
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
        HStack(spacing: 10) {
          Image(systemName: "arrow.triangle.branch")
          VStack(alignment: .leading, spacing: 3) {
            Text(mail.title).font(.subheadline.weight(.medium))
            Text(mail.status).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Image(systemName: "chevron.right").font(.caption)
        }
        .padding(12)
        .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      }
      .buttonStyle(.plain)
    }
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
  }
}
