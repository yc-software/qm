import SwiftUI
import UIKit

enum GitHubLinkMark {
  static let scheme = "qm-github-mark"
  private static let mark = "![](\(scheme):)\u{00A0}"
  private static let prefixes: [[Character]] = [
    Array("https://github.com/"), Array("https://www.github.com/"),
  ]

  static func decorate(_ markdown: String) -> String {
    guard markdown.contains("github.com") else { return markdown }
    var fence: String?
    return markdown.split(separator: "\n", omittingEmptySubsequences: false).map { line in
      let trimmed = line.drop(while: { $0 == " " })
      if let open = fence {
        if trimmed.hasPrefix(open) { fence = nil }
        return String(line)
      }
      if let open = ["```", "~~~"].first(where: { trimmed.hasPrefix($0) }) {
        fence = open
        return String(line)
      }
      if line.hasPrefix("    ") || line.hasPrefix("\t") { return String(line) }
      return decorate(line: Array(line))
    }.joined(separator: "\n")
  }

  private static func decorate(line chars: [Character]) -> String {
    var marks = Set<Int>()
    var opens: [Int] = []
    var i = 0
    while i < chars.count {
      switch chars[i] {
      case "\\":
        i += 2
      case "`":
        i = endOfCodeSpan(chars, from: i)
      case "[":
        opens.append(i)
        i += 1
      case "]":
        let open = opens.popLast()
        guard i + 1 < chars.count, chars[i + 1] == "(" else {
          i += 1
          continue
        }
        if let open, !(open > 0 && chars[open - 1] == "!"), isGitHub(chars, at: i + 2) {
          marks.insert(open)
        }
        var depth = 1
        i += 2
        while i < chars.count, depth > 0 {
          if chars[i] == "(" { depth += 1 } else if chars[i] == ")" { depth -= 1 }
          i += 1
        }
      case "<" where isGitHub(chars, at: i + 1):
        marks.insert(i)
        while i < chars.count, chars[i] != ">" { i += 1 }
      default:
        let boundary = i == 0 || !(chars[i - 1].isLetter || chars[i - 1].isNumber)
        if opens.isEmpty, boundary, isGitHub(chars, at: i) {
          marks.insert(i)
          while i < chars.count, !chars[i].isWhitespace { i += 1 }
        } else {
          i += 1
        }
      }
    }
    var out = ""
    for (index, char) in chars.enumerated() {
      if marks.contains(index) { out += mark }
      out.append(char)
    }
    return out
  }

  private static func endOfCodeSpan(_ chars: [Character], from start: Int) -> Int {
    var run = 0
    while start + run < chars.count, chars[start + run] == "`" { run += 1 }
    var j = start + run
    while j < chars.count {
      guard chars[j] == "`" else {
        j += 1
        continue
      }
      var closing = 0
      while j + closing < chars.count, chars[j + closing] == "`" { closing += 1 }
      if closing == run { return j + closing }
      j += closing
    }
    return start + run
  }

  private static func isGitHub(_ chars: [Character], at index: Int) -> Bool {
    prefixes.contains { prefix in
      index + prefix.count <= chars.count
        && zip(chars[index...], prefix).allSatisfy { $0.lowercased() == $1.lowercased() }
    }
  }

  static func image(dark: Bool, pointSize: CGFloat) -> Image {
    guard let logo = UIImage(named: "Service-github") else { return Image(systemName: "link") }
    let color =
      dark
      ? UIColor(red: 0x4c / 255, green: 0x8e / 255, blue: 0xf8 / 255, alpha: 1)
      : UIColor(red: 0x2c / 255, green: 0x65 / 255, blue: 0xcf / 255, alpha: 1)
    let size = CGSize(width: pointSize, height: pointSize)
    let drawn = UIGraphicsImageRenderer(size: size).image { _ in
      logo.withTintColor(color, renderingMode: .alwaysOriginal)
        .draw(in: CGRect(origin: .zero, size: size))
    }
    return Image(uiImage: drawn.withBaselineOffset(fromBottom: pointSize * 0.125))
  }
}
