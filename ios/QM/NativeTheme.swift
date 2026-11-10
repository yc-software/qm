import SwiftUI
import UniformTypeIdentifiers

struct NativeThemePalette: Codable, Equatable {
  struct RGB: Codable, Equatable {
    let red: Double
    let green: Double
    let blue: Double
    var color: Color { Color(red: red, green: green, blue: blue) }
    var luminance: Double { red * 0.2126 + green * 0.7152 + blue * 0.0722 }
    private var relativeLuminance: Double {
      func linear(_ component: Double) -> Double {
        component <= 0.04045 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
      }
      return linear(red) * 0.2126 + linear(green) * 0.7152 + linear(blue) * 0.0722
    }
    func contrast(with other: Self) -> Double {
      let first = relativeLuminance
      let second = other.relativeLuminance
      return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }
    func mixed(with other: Self, fraction: Double) -> Self {
      .init(
        red: red * (1 - fraction) + other.red * fraction,
        green: green * (1 - fraction) + other.green * fraction,
        blue: blue * (1 - fraction) + other.blue * fraction)
    }
    static func hex(_ raw: String, over background: Self = .init(red: 0, green: 0, blue: 0))
      -> Self?
    {
      guard raw.hasPrefix("#") else { return nil }
      var text = String(raw.dropFirst())
      if text.count == 3 || text.count == 4 { text = text.map { "\($0)\($0)" }.joined() }
      guard [6, 8].contains(text.count), let value = UInt32(text, radix: 16) else { return nil }
      let alpha = text.count == 8 ? Double(value & 255) / 255 : 1
      let rgb = text.count == 8 ? value >> 8 : value
      let foreground = Self(
        red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255,
        blue: Double(rgb & 255) / 255)
      return background.mixed(with: foreground, fraction: alpha)
    }
  }
  let name: String
  let background: RGB
  let foreground: RGB
  var dark: Bool { background.luminance < 0.5 }
  var readableForeground: RGB {
    guard foreground.contrast(with: background) < 4.5 else { return foreground }
    let black = RGB(red: 0, green: 0, blue: 0)
    let white = RGB(red: 1, green: 1, blue: 1)
    return black.contrast(with: background) > white.contrast(with: background) ? black : white
  }
  var surface: RGB {
    let foreground = readableForeground
    let mixed = background.mixed(with: foreground, fraction: 0.08)
    return mixed.contrast(with: foreground) >= 4.5 ? mixed : background
  }
  static func read(_ data: Data, filename: String) throws -> Self {
    guard data.count <= 2 * 1024 * 1024 else {
      throw QMError.message("Choose a theme file smaller than 2 MB.")
    }
    let name = String(
      URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent.prefix(80))
    if let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
      as? [String: Any]
    {
      func color(_ key: String) -> RGB? {
        guard
          let value = (plist[key] ?? plist[key + " (Dark)"] ?? plist[key + " (Light)"])
            as? [String: Any],
          let red = value["Red Component"] as? Double,
          let green = value["Green Component"] as? Double,
          let blue = value["Blue Component"] as? Double, [red, green, blue].allSatisfy(\.isFinite)
        else { return nil }
        return .init(
          red: min(1, max(0, red)), green: min(1, max(0, green)), blue: min(1, max(0, blue)))
      }
      guard let background = color("Background Color"), let foreground = color("Foreground Color")
      else {
        throw QMError.message("The iTerm theme needs background and foreground colors.")
      }
      return .init(name: name, background: background, foreground: foreground)
    }
    guard
      let object = try? JSONSerialization.jsonObject(with: data, options: .json5Allowed)
        as? [String: Any]
    else {
      throw QMError.message("Choose an iTerm .itermcolors file or a VS Code theme JSON file.")
    }
    let colors = object["colors"] as? [String: String] ?? [:]
    let fallback =
      object["type"] as? String == "light"
      ? "#ffffff" : object["type"] as? String == "dark" ? "#1e1e1e" : ""
    guard let background = RGB.hex(colors["editor.background"] ?? fallback) else {
      throw QMError.message(
        "The VS Code theme needs an editor.background color or a light/dark type.")
    }
    let foreground =
      RGB.hex(
        colors["editor.foreground"] ?? colors["foreground"]
          ?? (background.luminance < 0.5 ? "#d4d4d4" : "#333333"), over: background) ?? RGB.hex(
        background.luminance < 0.5 ? "#d4d4d4" : "#333333")!
    return .init(
      name: String((object["name"] as? String ?? name).prefix(80)), background: background,
      foreground: foreground)
  }
}

@MainActor @Observable
final class NativeThemeStore {
  static let shared = NativeThemeStore()
  var palette: NativeThemePalette?
  var enabled: Bool
  var active: NativeThemePalette? { enabled ? palette : nil }
  init() {
    palette = UserDefaults.standard.data(forKey: "importedTheme").flatMap {
      try? JSONDecoder().decode(NativeThemePalette.self, from: $0)
    }
    enabled = UserDefaults.standard.string(forKey: "appearance") == "custom"
  }
  func install(_ value: NativeThemePalette?) throws {
    if let value {
      UserDefaults.standard.set(try JSONEncoder().encode(value), forKey: "importedTheme")
    } else {
      UserDefaults.standard.removeObject(forKey: "importedTheme")
    }
    palette = value
  }
}

struct NativeThemeImport: View {
  @AppStorage("appearance") private var appearance = "system"
  @State private var importing = false
  @State private var error: String?
  var body: some View {
    Group {
      if let palette = NativeThemeStore.shared.palette {
        HStack {
          Text(palette.name)
          Spacer()
          Circle().fill(palette.background.color).frame(width: 20)
          Circle().fill(palette.foreground.color).frame(width: 20)
        }
        Button("Use imported theme") { appearance = "custom" }
        Button("Remove imported theme", role: .destructive) {
          do {
            try NativeThemeStore.shared.install(nil)
            if appearance == "custom" { appearance = "system" }
          } catch { self.error = error.localizedDescription }
        }
      }
      Button("Import theme file", systemImage: "square.and.arrow.down") { importing = true }
      Text(
        "Import an iTerm2 or VS Code palette. Standard iOS controls follow its light or dark appearance."
      ).font(.caption)
      if let error { Text(error).foregroundStyle(.red) }
    }.fileImporter(isPresented: $importing, allowedContentTypes: [.json, .propertyList, .data]) {
      result in
      do {
        let url = try result.get()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 2 * 1024 * 1024
        else {
          throw QMError.message("Choose a theme file smaller than 2 MB.")
        }
        let palette = try NativeThemePalette.read(
          Data(contentsOf: url), filename: url.lastPathComponent)
        try NativeThemeStore.shared.install(palette)
        appearance = "custom"
        error = nil
      } catch { self.error = error.localizedDescription }
    }
  }
}
