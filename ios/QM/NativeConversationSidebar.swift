import SwiftUI

struct NativeConversationSection: Identifiable {
  let id: String
  let title: String
  let icon: String
  var conversations: [Conversation]
  var members: [WorkspaceContext.GroupMember] = []

  var hasPreview: Bool {
    id != "pinned" && conversations.count > 5
      && conversations.first.map { ScopeKind(scopeId: $0.scopeId) != .personal } == true
  }

  func preview(showAll: Bool, searching: Bool, selectedID: String?) -> [Conversation] {
    guard hasPreview, !showAll, !searching else { return conversations }
    return conversations.enumerated().filter { $0.offset < 5 || $0.element.id == selectedID }.map(
      \.element)
  }

  static func grouped(
    _ conversations: [Conversation], contexts: [String: WorkspaceContext]
  ) -> [Self] {
    var sections: [Self] = []
    let pinned = conversations.filter { $0.pinned == true }
    if !pinned.isEmpty {
      sections.append(Self(id: "pinned", title: "Pinned", icon: "pin", conversations: pinned))
    }
    var indices: [String: Int] = [:]
    for conversation in conversations where conversation.pinned != true {
      let scope = conversation.scopeId
      if let index = indices[scope] {
        sections[index].conversations.append(conversation)
      } else {
        let context = contexts[scope]
        let kind = ScopeKind(scopeId: scope)
        let title = context?.title ?? conversation.contextLabel ?? "Personal"
        let icon =
          context?.icon
          ?? (kind == .channel
            ? "number" : kind == .group ? "person.2" : kind == .personal ? "person" : "folder")
        indices[scope] = sections.count
        sections.append(
          Self(
            id: "scope:\(scope)", title: title, icon: icon, conversations: [conversation],
            members: kind == .group && context?.project == nil ? context?.groupMembers ?? [] : []))
      }
    }
    return sections
  }
}

struct NativeConversationRow: View {
  let conversation: Conversation
  var showsContext = true
  var contextTitle: String?
  var updating = false
  var selected = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  private var context: String? {
    guard showsContext else { return nil }
    let title = contextTitle ?? conversation.contextLabel
    return title == conversation.label ? nil : title
  }

  var body: some View {
    HStack(spacing: 8) {
      if conversation.surface == "slack" {
        Image("Service-slack")
          .resizable().renderingMode(.template).scaledToFit()
          .frame(width: 14, height: 14)
          .foregroundStyle(.secondary)
      }
      Text(conversation.label)
        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
      Spacer(minLength: 0)
      if let context {
        Text(context).font(.caption).foregroundStyle(.secondary)
          .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
          .frame(maxWidth: 110, alignment: .trailing)
      }
      if updating {
        ProgressView().controlSize(.mini)
      } else if conversation.awaitingInput == true {
        Image(systemName: "clock").foregroundStyle(.secondary)
      } else if conversation.working == true {
        Circle().fill(.blue).frame(width: 7, height: 7)
      }
      if let emoji = conversation.status?.emoji, !emoji.isEmpty {
        Text(emoji)
      }
    }
    .font(.subheadline)
    .padding(.horizontal, 8).padding(.vertical, 4)
    .frame(minHeight: 40)
    .background(selected ? QMTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 10))
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      [
        conversation.label, conversation.surface == "slack" ? "Slack" : nil, context,
        conversation.awaitingInput == true ? "Needs attention" : nil,
        conversation.working == true ? "Working" : nil,
        conversation.status?.text, updating ? "Updating" : nil,
      ].compactMap { $0 }.joined(separator: ", ")
    )
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

struct NativeGroupAvatars: View {
  let members: [WorkspaceContext.GroupMember]
  var shown: [WorkspaceContext.GroupMember] {
    members.count > 3 ? Array(members.prefix(2)) : members
  }
  var remaining: Int { members.count - shown.count }

  var body: some View {
    HStack(spacing: -4) {
      ForEach(shown) { member in
        AsyncImage(url: photoURL(member.avatarUrl)) { image in
          image.resizable().scaledToFill()
        } placeholder: {
          Text(String(member.displayName.prefix(1)).uppercased())
            .font(.system(size: 10, weight: .medium))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(QMTheme.surface)
        }
        .frame(width: 22, height: 22)
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .overlay { RoundedRectangle(cornerRadius: 5).stroke(QMTheme.paper, lineWidth: 1.5) }
      }
      if remaining > 0 {
        Text("+\(remaining)").font(.system(size: 9, weight: .medium))
          .frame(width: 22, height: 22)
          .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 5))
          .overlay { RoundedRectangle(cornerRadius: 5).stroke(QMTheme.paper, lineWidth: 1.5) }
      }
    }
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("With " + members.map(\.displayName).joined(separator: ", "))
  }

  private func photoURL(_ value: String?) -> URL? {
    guard let value, let url = URL(string: value), url.scheme == "https" else { return nil }
    return url
  }
}
