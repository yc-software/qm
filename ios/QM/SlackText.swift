import Foundation

enum SlackText {
  enum Segment: Equatable {
    case text(String)
    case mention(String)
    case link(address: String, label: String)
  }

  static func plain(_ wire: String) -> String {
    segments(wire).map { segment in
      switch segment {
      case .text(let text): text
      case .mention(let handle): "@" + handle
      case .link(_, let label): label
      }
    }
    .joined()
  }

  static func markdown(_ wire: String) -> String {
    var out = ""
    for segment in segments(wire) {
      switch segment {
      case .text(let text):
        out += markup(ArraySlice(Array(text)), lineStart: out.isEmpty || out.hasSuffix("\n"))
      case .mention(let handle): out += "@" + handle
      case .link(let address, let label):
        out +=
          "["
          + label.replacingOccurrences(of: "[", with: "\\[")
          .replacingOccurrences(of: "]", with: "\\]") + "](" + address + ")"
      }
    }
    return out
  }

  private static let marks: [Character: String] = ["*": "**", "_": "_", "~": "~~"]
  private static let markdownSyntax = Set("\\`*_~[]()<>#+-=.!|&")

  private static func markup(_ chars: ArraySlice<Character>, lineStart: Bool) -> String {
    var out = ""
    var index = chars.startIndex
    var leading = lineStart
    while index < chars.endIndex {
      let char = chars[index]
      if char == "`", let end = codeEnd(chars, open: index) {
        out += String(chars[index..<end])
        index = end
        leading = false
        continue
      }
      if let mark = marks[char], let close = spanClose(chars, open: index) {
        out += mark + markup(chars[(index + 1)..<close], lineStart: false) + mark
        index = close + 1
        leading = false
        continue
      }
      if char == ">", index > chars.startIndex ? chars[index - 1].isNewline : lineStart {
        out.append(char)
      } else if char == " ", leading {
        out.append("\u{00A0}")
      } else if markdownSyntax.contains(char) {
        out += "\\" + String(char)
      } else {
        out.append(char)
      }
      leading = char.isNewline || (leading && char == " ")
      index += 1
    }
    return out
  }

  private static func codeEnd(_ chars: ArraySlice<Character>, open: Int) -> Int? {
    let fence = chars[open...].starts(with: "```") ? 3 : 1
    var index = open + fence
    while index + fence <= chars.endIndex {
      if chars[index..<(index + fence)].allSatisfy({ $0 == "`" }) { return index + fence }
      if fence == 1, chars[index].isNewline { return nil }
      index += 1
    }
    return nil
  }

  private static func spanClose(_ chars: ArraySlice<Character>, open: Int) -> Int? {
    let mark = chars[open]
    let next = open + 1
    guard !joinsWord(open > chars.startIndex ? chars[open - 1] : nil, mark), next < chars.endIndex,
      !chars[next].isWhitespace, chars[next] != mark
    else { return nil }
    var index = next
    while index < chars.endIndex, !chars[index].isNewline, chars[index] != "`" {
      if chars[index] == mark {
        let after = index + 1 < chars.endIndex ? chars[index + 1] : nil
        return chars[index - 1].isWhitespace || joinsWord(after, mark) ? nil : index
      }
      index += 1
    }
    return nil
  }

  private static func joinsWord(_ character: Character?, _ mark: Character) -> Bool {
    guard let character else { return false }
    return character.isLetter || character.isNumber || character == mark
  }

  static func segments(_ wire: String) -> [Segment] {
    var result: [Segment] = []
    var pending = ""
    var rest = Substring(wire)
    while let open = rest.firstIndex(of: "<") {
      pending += decoded(rest[..<open])
      let body = rest[rest.index(after: open)...]
      guard let end = body.firstIndex(where: { $0 == ">" || $0 == "<" || $0.isNewline }),
        body[end] == ">", end != body.startIndex
      else {
        pending += "<"
        rest = body
        continue
      }
      let segment = token(body[..<end])
      if case .text(let text) = segment {
        pending += text
      } else {
        if !pending.isEmpty { result.append(.text(pending)) }
        pending = ""
        result.append(segment)
      }
      rest = body[body.index(after: end)...]
    }
    pending += decoded(rest)
    if !pending.isEmpty { result.append(.text(pending)) }
    return result
  }

  private static func token(_ inner: Substring) -> Segment {
    let marked = split(inner.dropFirst())
    switch inner.first {
    case "@":
      return .mention(handle(marked.label.isEmpty ? marked.target : marked.label))
    case "#":
      return .text("#" + decoded(marked.label.isEmpty ? marked.target : marked.label))
    case "!":
      let command = marked.target.lowercased()
      if ["here", "channel", "everyone"].contains(command) { return .mention(command) }
      if marked.target.hasPrefix("subteam^"), !marked.label.isEmpty {
        return .mention(handle(marked.label))
      }
      return .text(marked.label.isEmpty ? "<" + decoded(inner) + ">" : decoded(marked.label))
    default:
      let link = split(inner)
      let address = decoded(link.target)
      let scheme = address.lowercased()
      guard ["https://", "http://", "mailto:"].contains(where: scheme.hasPrefix),
        !address.contains(where: { $0 == ")" || $0 == "(" || $0.isWhitespace })
      else { return .text("<" + decoded(inner) + ">") }
      return .link(address: address, label: link.label.isEmpty ? address : decoded(link.label))
    }
  }

  private static func split(_ text: Substring) -> (target: String, label: String) {
    let parts = text.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
    return (
      parts.first.map { $0.trimmingCharacters(in: .whitespaces) } ?? "",
      parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
    )
  }

  private static func handle(_ text: String) -> String {
    String(decoded(text).drop { $0 == "@" })
  }

  private static func decoded(_ text: some StringProtocol) -> String {
    text.replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
      .replacingOccurrences(of: "&amp;", with: "&")
  }
}
