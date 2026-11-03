import MarkdownUI
import SwiftUI

struct MessageMarkdown: View {
  let text: String
  let client: APIClient
  var files: [DeliveredFile] = []
  @State private var copiedCode: String?
  @State private var previewFile: DeliveredFile?

  var body: some View {
    Markdown(text, baseURL: client.baseURL)
      .markdownImageProvider(WorkspaceMarkdownImages(client: client, files: files))
      .markdownInlineImageProvider(WorkspaceInlineImages(client: client, files: files))
      .id(files.map { "\($0.name ?? ""):\($0.artifactId ?? "")" }.sorted())
      .markdownTextStyle(\.text) {
        ForegroundColor(QMTheme.ink)
        BackgroundColor(.clear)
        FontSize(.em(1))
      }
      .markdownBlockStyle(\.codeBlock) { configuration in
        VStack(alignment: .leading, spacing: 0) {
          HStack {
            Text(configuration.language ?? "Code").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button {
              UIPasteboard.general.string = configuration.content
              copiedCode = configuration.content
            } label: {
              Label(
                copiedCode == configuration.content ? "Copied" : "Copy code",
                systemImage: copiedCode == configuration.content ? "checkmark" : "doc.on.doc")
            }
            .font(.caption).buttonStyle(.borderless).frame(minHeight: 44)
          }.padding(.horizontal, 12).padding(.vertical, 2)
          ScrollView(.horizontal) {
            configuration.label
              .relativeLineSpacing(.em(0.2))
              .markdownTextStyle {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.85))
              }
              .padding(12)
          }
        }
        .background(QMTheme.surface, in: RoundedRectangle(cornerRadius: 10))
      }
      .markdownBlockStyle(\.table) { configuration in
        ScrollView(.horizontal) {
          configuration.label
            .fixedSize(horizontal: true, vertical: true)
            .markdownTableBorderStyle(.init(.insideHorizontalBorders, color: QMTheme.border))
            .markdownTableBackgroundStyle(.alternatingRows(.clear, .clear))
        }
        .markdownMargin(top: 0, bottom: 16)
      }
      .markdownBlockStyle(\.tableCell) { configuration in
        configuration.label
          .markdownTextStyle {
            if configuration.row == 0 { FontWeight(.semibold) }
            BackgroundColor(nil)
          }
          .fixedSize(horizontal: false, vertical: true)
          .padding(.vertical, 10)
          .padding(.leading, configuration.column == 0 ? 0 : 12)
          .padding(.trailing, 12)
          .relativeLineSpacing(.em(0.25))
      }
      .markdownTheme(.gitHub)
      .textSelection(.enabled)
      .task(id: copiedCode) {
        guard copiedCode != nil else { return }
        do {
          try await Task.sleep(for: .seconds(2))
          copiedCode = nil
        } catch {}
      }
      .environment(
        \.openURL,
        OpenURLAction { url in
          if let file = FilePreviewResource.attachment(url, files: files) {
            previewFile = file
            return .handled
          }
          return ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "")
            ? .systemAction : .discarded
        }
      )
      .sheet(
        isPresented: Binding(get: { previewFile != nil }, set: { if !$0 { previewFile = nil } })
      ) {
        if let previewFile { FilePreviewSheet(file: previewFile, client: client) }
      }
  }
}
