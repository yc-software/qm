import ImageIO
import SwiftUI
import UniformTypeIdentifiers

struct NativeLoopIcon: View {
  struct Choice: Identifiable {
    let id: String
    let title: String
    let symbol: String
  }
  static let choices: [Choice] = [
    .init(id: "repeat", title: "Loop", symbol: "repeat"),
    .init(id: "mail", title: "Email", symbol: "envelope"),
    .init(id: "slack", title: "Slack", symbol: "number"),
    .init(id: "zap", title: "Lightning", symbol: "bolt"),
    .init(id: "code", title: "Code", symbol: "chevron.left.forwardslash.chevron.right"),
    .init(id: "bug", title: "Bug", symbol: "ladybug"),
    .init(id: "shield", title: "Shield", symbol: "shield"),
    .init(id: "calendar", title: "Calendar", symbol: "calendar"),
    .init(id: "message", title: "Message", symbol: "bubble"),
    .init(id: "chart", title: "Chart", symbol: "chart.xyaxis.line"),
    .init(id: "check", title: "Check", symbol: "checkmark.circle"),
    .init(id: "book", title: "Book", symbol: "book"),
    .init(id: "rocket", title: "Rocket", symbol: "paperplane"),
    .init(id: "globe", title: "Globe", symbol: "globe"),
    .init(id: "heart", title: "Heart", symbol: "heart"),
    .init(id: "wrench", title: "Wrench", symbol: "wrench"),
  ]
  let value: String?
  var body: some View {
    Group {
      if let value, value.hasPrefix("data:image/png;base64,"), value.utf8.count <= 65536,
        let data = Data(base64Encoded: String(value.dropFirst("data:image/png;base64,".count))),
        let image = Self.thumbnail(data)
      {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Image(systemName: Self.choices.first { $0.id == value }?.symbol ?? "repeat")
      }
    }.frame(width: 24, height: 24).accessibilityHidden(true)
  }
  static func thumbnail(_ data: Data) -> UIImage? {
    guard data.count <= 2 * 1024 * 1024,
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 96,
        ] as CFDictionary)
    else { return nil }
    return UIImage(cgImage: image)
  }
  @MainActor static func encode(_ data: Data) throws -> String {
    guard let image = thumbnail(data) else {
      throw QMError.message("Choose a PNG, JPEG, WebP or GIF image smaller than 2 MB.")
    }
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let size = CGSize(width: 96, height: 96)
    let png = UIGraphicsImageRenderer(size: size, format: format).pngData { _ in
      let scale = min(96 / image.size.width, 96 / image.size.height)
      let width = image.size.width * scale
      let height = image.size.height * scale
      image.draw(
        in: CGRect(x: (96 - width) / 2, y: (96 - height) / 2, width: width, height: height))
    }
    let value = "data:image/png;base64," + png.base64EncodedString()
    guard value.utf8.count <= 65536 else {
      throw QMError.message("Choose a simpler image for this icon.")
    }
    return value
  }
}

struct NativeLoopIconPicker: View {
  @Bindable var model: LoopDetailModel
  @Environment(\.dismiss) private var dismiss
  @State private var importing = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      QMList {
        ForEach(NativeLoopIcon.choices) { choice in
          Button {
            Task { await save(choice.id) }
          } label: {
            HStack {
              NativeLoopIcon(value: choice.id)
              Text(choice.title)
              Spacer()
              if model.detail?.loop.icon == choice.id { Image(systemName: "checkmark") }
            }
          }
        }
        Button("Choose an image", systemImage: "photo") { importing = true }
        Button("Use default icon") { Task { await save(nil) } }
        if let error = error ?? model.error { Text(error).foregroundStyle(.red) }
      }.disabled(model.busy).navigationTitle("Loop icon")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }.disabled(model.busy)
          }
        }
        .interactiveDismissDisabled(model.busy)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.png, .jpeg, .gif, .webP]) {
          result in
          Task {
            do {
              let url = try result.get()
              let access = url.startAccessingSecurityScopedResource()
              defer { if access { url.stopAccessingSecurityScopedResource() } }
              let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
              guard size <= 2 * 1024 * 1024 else {
                throw QMError.message("Choose an image smaller than 2 MB.")
              }
              let value = try NativeLoopIcon.encode(Data(contentsOf: url))
              await save(value)
            } catch { self.error = error.localizedDescription }
          }
        }
    }
  }
  private func save(_ value: String?) async {
    if await model.mutate(method: "PATCH", body: ["icon": value as Any? ?? NSNull()]) { dismiss() }
  }
}
