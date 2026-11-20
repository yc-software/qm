import SwiftUI
import UIKit
import XCTest

@testable import QM

final class NativeBrandAssetTests: XCTestCase {
  @MainActor
  func testSketchBoatFramesAreBundledDistinctAndVisible() throws {
    var frames: [[UInt8]] = []
    for tick in 0..<NativeSketchBoatLoading.frameCount {
      XCTAssertNotNil(UIImage(named: "SketchBoat-\(tick)"))
      let renderer = ImageRenderer(
        content: NativeSketchBoatLoading.frame(tick).frame(width: 120, height: 86))
      renderer.scale = 1
      let image = try XCTUnwrap(renderer.cgImage)
      var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
      try pixels.withUnsafeMutableBytes { bytes in
        let context = try XCTUnwrap(
          CGContext(
            data: bytes.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      }
      let alpha = stride(from: 3, to: pixels.count, by: 4).map { pixels[$0] }
      XCTAssertGreaterThan(alpha.filter { $0 > 128 }.count, 300, "Frame \(tick) must draw the boat")
      XCTAssertFalse(frames.contains(alpha), "Frame \(tick) must differ from earlier frames")
      frames.append(alpha)
    }
  }

  @MainActor
  func testChatGPTLogoIsBundledAndRendersInBothAppearances() throws {
    let asset = try XCTUnwrap(UIImage(named: "Service-openai"))
    XCTAssertGreaterThan(asset.size.width, 0)
    XCTAssertGreaterThan(asset.size.height, 0)

    for appearance in [ColorScheme.light, .dark] {
      let renderer = ImageRenderer(
        content: NativeServiceLogo(service: "openai", size: 20)
          .environment(\.colorScheme, appearance))
      renderer.scale = 1
      let image = try XCTUnwrap(renderer.uiImage)
      XCTAssertEqual(image.size, CGSize(width: 20, height: 20))
      let cgImage = try XCTUnwrap(image.cgImage)
      var pixels = [UInt8](repeating: 0, count: 20 * 20 * 4)
      try pixels.withUnsafeMutableBytes { bytes in
        let context = try XCTUnwrap(
          CGContext(
            data: bytes.baseAddress, width: 20, height: 20, bitsPerComponent: 8,
            bytesPerRow: 80, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 20, height: 20))
      }
      let visiblePixels = stride(from: 0, to: pixels.count, by: 4).filter {
        pixels[$0 + 3] > 128
      }
      XCTAssertGreaterThan(visiblePixels.count, 60)
      XCTAssertLessThan(visiblePixels.count, 300)
      let average =
        Double(visiblePixels.reduce(0) { $0 + Int(pixels[$1]) })
        / Double(max(1, visiblePixels.count))
      if appearance == .light {
        XCTAssertLessThan(average, 80)
      } else {
        XCTAssertGreaterThan(average, 175)
      }
    }
  }

  @MainActor
  func testBundledMarksAreDrawnAtTheSizeAskedForWhateverSizeTheAssetShipsIn() throws {
    XCTAssertGreaterThan(try XCTUnwrap(UIImage(named: "Service-stripe")).size.width, 100)
    for service in ["stripe", "openai", "slack", "Google_Drive"] {
      let mark = try XCTUnwrap(NativeServiceLogo.mark(service, size: 20), service)
      XCTAssertEqual(mark.size, CGSize(width: 20, height: 20), service)
      XCTAssertEqual(mark.renderingMode, .alwaysTemplate, service)
    }
    XCTAssertNil(NativeServiceLogo.mark("unbundled", size: 20))
  }
}
