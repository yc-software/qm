import MarkdownUI
import SwiftUI

struct NativeTextSelectionSheet: View {
  let text: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      NativeSelectableText(text: MarkdownContent(text).renderPlainText())
        .ignoresSafeArea(edges: .bottom)
        .background(QMTheme.paper)
        .navigationTitle("Select text")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") { dismiss() }
          }
        }
    }
    .tint(.brown)
  }
}

private struct NativeSelectableText: UIViewRepresentable {
  let text: String

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.font = .preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = true
    view.textColor = UIColor(QMTheme.ink)
    view.backgroundColor = .clear
    view.alwaysBounceVertical = true
    view.textContainerInset = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    if view.text != text { view.text = text }
  }
}
