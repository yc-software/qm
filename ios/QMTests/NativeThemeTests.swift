import XCTest

@testable import QM

final class NativeThemeTests: XCTestCase {
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
