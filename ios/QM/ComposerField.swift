import SwiftUI
import UIKit

/// The message field. SwiftUI's TextField pastes only text; this text view also takes a copied
/// image, from the edit menu or ⌘V, and attaches it as other messaging apps do.
struct ComposerField: UIViewRepresentable {
  @Binding var text: String
  @Binding var focused: Bool
  let placeholder: String
  let maxLines: Int
  let onPasteImages: ([AttachmentSource]) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> PastingTextView {
    let view = PastingTextView()
    view.delegate = context.coordinator
    view.font = .preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = true
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.isScrollEnabled = false
    view.accessibilityIdentifier = "composer"
    return view
  }

  func updateUIView(_ view: PastingTextView, context: Context) {
    context.coordinator.parent = self
    view.onPasteImages = onPasteImages
    if view.text != text { view.text = text }
    view.isEditable = context.environment.isEnabled
    view.accessibilityLabel = placeholder
    if focused != view.isFirstResponder {
      Task { _ = focused ? view.becomeFirstResponder() : view.resignFirstResponder() }
    }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PastingTextView, context: Context)
    -> CGSize?
  {
    let width = proposal.width ?? view.bounds.width
    let height = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    let limit = ceil((view.font?.lineHeight ?? 22) * CGFloat(maxLines))
    view.isScrollEnabled = height > limit
    return CGSize(width: width, height: min(height, limit))
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: ComposerField

    init(_ parent: ComposerField) { self.parent = parent }

    func textViewDidChange(_ view: UITextView) { parent.text = view.text }
    func textViewDidBeginEditing(_ view: UITextView) { parent.focused = true }
    func textViewDidEndEditing(_ view: UITextView) { parent.focused = false }
  }
}

final class PastingTextView: UITextView {
  var onPasteImages: ([AttachmentSource]) -> Void = { _ in }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    action == #selector(paste(_:)) && UIPasteboard.general.hasImages
      || super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    let pasteboard = UIPasteboard.general
    let images = pasteboard.itemProviders.filter { $0.canLoadObject(ofClass: UIImage.self) }
    guard pasteboard.hasImages, !images.isEmpty else { return super.paste(sender) }
    onPasteImages(images.map(AttachmentSource.image))
  }
}
