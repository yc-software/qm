import SwiftUI
import UIKit
import XCTest

@testable import QM

final class NativeThemeTests: XCTestCase {
  @MainActor
  func testImportedAndRestoredThemesKeepNormalTextReadable() throws {
    let store = NativeThemeStore.shared
    let previousPalette = store.palette
    let previouslyEnabled = store.enabled
    defer {
      store.palette = previousPalette
      store.enabled = previouslyEnabled
    }
    store.enabled = true
    for (background, foreground) in [
      ("#002b36", "#839496"), ("#ffffff", "#767676"),
      ("#1e1e1e", "#d4d4d4"), ("#ffffff", "#222222"),
      ("#777777", "#777777"), ("#ffffff", "#ffffff"), ("#000000", "#000000"),
    ] {
      let palette = try NativeThemePalette.read(
        JSONSerialization.data(withJSONObject: [
          "colors": ["editor.background": background, "editor.foreground": foreground]
        ]), filename: "contrast.json")
      let restored = try JSONDecoder().decode(
        NativeThemePalette.self, from: JSONEncoder().encode(palette))
      for active in [palette, restored] {
        store.palette = active
        for (name, color) in [("Primary", QMTheme.ink), ("Warning", QMTheme.warning)] {
          let ink = try relativeLuminance(color)
          for backgroundColor in [QMTheme.paper, QMTheme.surface] {
            let backdrop = try relativeLuminance(backgroundColor)
            XCTAssertGreaterThanOrEqual(
              (max(ink, backdrop) + 0.05) / (min(ink, backdrop) + 0.05), 4.5,
              "\(name) text must remain readable with palette \(foreground) on \(background)")
          }
        }
      }
    }
  }

  @MainActor
  func testDefaultWarningsAreReadableInLightAndDarkAppearances() throws {
    let store = NativeThemeStore.shared
    let previouslyEnabled = store.enabled
    defer { store.enabled = previouslyEnabled }
    store.enabled = false
    for style in [UIUserInterfaceStyle.light, .dark] {
      for contrast in [UIAccessibilityContrast.normal, .high] {
        let traits = UITraitCollection(traitsFrom: [
          UITraitCollection(userInterfaceStyle: style),
          UITraitCollection(accessibilityContrast: contrast),
        ])
        let warning = try relativeLuminance(QMTheme.warning, traits: traits)
        for backgroundColor in [QMTheme.paper, QMTheme.surface] {
          let backdrop = try relativeLuminance(backgroundColor, traits: traits)
          XCTAssertGreaterThanOrEqual(
            (max(warning, backdrop) + 0.05) / (min(warning, backdrop) + 0.05), 4.5,
            "Warning text must be readable in \(style), contrast \(contrast)")
        }
      }
    }
  }

  @MainActor
  private func relativeLuminance(_ color: Color, traits: UITraitCollection = .current) throws
    -> Double
  {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    let resolved = UIColor(color).resolvedColor(with: traits)
    guard resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
      XCTFail("Theme colors must resolve to RGB")
      throw QMError.message("Could not resolve the theme color")
    }
    return zip([red, green, blue], [0.2126, 0.7152, 0.0722]).reduce(0) { result, pair in
      let component = Double(pair.0)
      let linear = component <= 0.04045 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
      return result + linear * pair.1
    }
  }

  func testVSCodeCommentsTrailingCommasAndAlphaColors() throws {
    let palette = try NativeThemePalette.read(
      Data(
        "{name:'Midnight', type:'dark', colors:{'editor.background':'#123', 'editor.foreground':'#ffffff80',},}"
          .utf8), filename: "test.json")
    XCTAssertEqual(palette.name, "Midnight")
    XCTAssertTrue(palette.dark)
    XCTAssertEqual(palette.background.red, 17.0 / 255, accuracy: 0.001)
    XCTAssertGreaterThan(palette.foreground.red, 0.5)
    XCTAssertLessThan(palette.foreground.red, 0.6)
  }
  func testMalformedForegroundFallsBackInsteadOfCrashing() throws {
    let palette = try NativeThemePalette.read(
      Data(#"{"type":"dark","colors":{"editor.foreground":"invalid"}}"#.utf8), filename: "Dark.json"
    )
    XCTAssertGreaterThan(palette.foreground.luminance, palette.background.luminance)
    XCTAssertThrowsError(try NativeThemePalette.read(Data("{}".utf8), filename: "empty.json"))
    XCTAssertThrowsError(
      try NativeThemePalette.read(
        Data(repeating: 0, count: 2 * 1024 * 1024 + 1), filename: "large.json"))
  }
  func testItermComponentsAndVariants() throws {
    let plist: [String: Any] = [
      "Background Color (Dark)": [
        "Red Component": 0.1, "Green Component": 0.2, "Blue Component": 0.3,
      ],
      "Foreground Color": ["Red Component": 1.2, "Green Component": 0.8, "Blue Component": 0.9],
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    let palette = try NativeThemePalette.read(data, filename: "Harbor.itermcolors")
    XCTAssertEqual(palette.name, "Harbor")
    XCTAssertEqual(palette.foreground.red, 1)
    XCTAssertEqual(palette.background.blue, 0.3)
  }
}
