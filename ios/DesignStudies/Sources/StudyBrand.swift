import SwiftUI

enum StudyBrand: String, CaseIterable, Identifiable {
  case revolut, waymo, grok, openai, flighty

  var id: String { rawValue }

  var title: String {
    switch self {
    case .revolut: "Revolut"
    case .waymo: "Waymo"
    case .grok: "Grok"
    case .openai: "Codex / ChatGPT"
    case .flighty: "Flighty"
    }
  }

  var subtitle: String {
    switch self {
    case .revolut: "A premium command center."
    case .waymo: "A calmer way to get work done."
    case .grok: "One thought. Infinite possibilities."
    case .openai: "Space to think. Tools to act."
    case .flighty: "Every task, right on time."
    }
  }

  var symbol: String {
    switch self {
    case .revolut: "circle.hexagongrid.fill"
    case .waymo: "point.topleft.down.to.point.bottomright.curvepath"
    case .grok: "asterisk"
    case .openai: "command"
    case .flighty: "paperplane.fill"
    }
  }

  var accent: Color {
    switch self {
    case .revolut: Color(red: 0.25, green: 0.42, blue: 1)
    case .waymo: Color(red: 0.12, green: 0.35, blue: 0.88)
    case .grok: .white
    case .openai: .black
    case .flighty: Color(red: 0.20, green: 0.55, blue: 1)
    }
  }

  var dark: Bool { self == .revolut || self == .grok || self == .flighty }

  var surface: Color {
    switch self {
    case .revolut: Color(red: 0.10, green: 0.11, blue: 0.14)
    case .waymo: Color(red: 0.89, green: 0.95, blue: 1)
    case .grok: Color(red: 0.06, green: 0.06, blue: 0.065)
    case .openai: Color(red: 0.95, green: 0.95, blue: 0.92)
    case .flighty: Color(red: 0.08, green: 0.11, blue: 0.17)
    }
  }
}
