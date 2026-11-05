import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let sourceURL = directory.appendingPathComponent("../../desktop/assets/qm.png")
let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let artwork = image.cropping(to: CGRect(x: 100, y: 106, width: 1054, height: 1046))!
let output = directory.deletingLastPathComponent()
  .appendingPathComponent("QM/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
let context = CGContext(
  data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 4096,
  space: CGColorSpace(name: CGColorSpace.sRGB)!,
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.035, green: 0.176, blue: 0.282, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
context.interpolationQuality = .high
context.draw(artwork, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
let destination = CGImageDestinationCreateWithURL(
  output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
if !CGImageDestinationFinalize(destination) { throw CocoaError(.fileWriteUnknown) }
