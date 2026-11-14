import SwiftUI
import UIKit
import cmark_gfm
import cmark_gfm_extensions

enum GitHubLinkMark {
  static let scheme = "qm-github-mark"

  static func isGitHub(_ href: String) -> Bool {
    guard let url = URL(string: href), url.scheme?.lowercased() == "https",
      let host = url.host()?.lowercased()
    else { return false }
    return host == "github.com" || host == "www.github.com"
  }

  static func decorate(_ markdown: String) -> String {
    guard markdown.localizedCaseInsensitiveContains("github.com") else { return markdown }
    cmark_gfm_core_extensions_ensure_registered()
    guard let parser = cmark_parser_new(CMARK_OPT_DEFAULT) else { return markdown }
    defer { cmark_parser_free(parser) }
    for name in ["autolink", "strikethrough", "tagfilter", "tasklist", "table"] {
      if let syntax = cmark_find_syntax_extension(name) {
        cmark_parser_attach_syntax_extension(parser, syntax)
      }
    }
    cmark_parser_feed(parser, markdown, markdown.utf8.count)
    guard let document = cmark_parser_finish(parser) else { return markdown }
    defer { cmark_node_free(document) }
    let links = githubLinks(in: document)
    guard !links.isEmpty else { return markdown }
    for link in links {
      guard let mark = cmark_node_new(CMARK_NODE_IMAGE), let gap = cmark_node_new(CMARK_NODE_TEXT)
      else { return markdown }
      cmark_node_set_url(mark, "\(scheme):")
      cmark_node_set_literal(gap, "\u{00A0}")
      cmark_node_insert_before(link, mark)
      cmark_node_insert_before(link, gap)
    }
    guard let rendered = cmark_render_commonmark(document, CMARK_OPT_DEFAULT, 0) else {
      return markdown
    }
    defer { free(rendered) }
    return String(cString: rendered)
  }

  private static func githubLinks(in document: UnsafeMutablePointer<cmark_node>)
    -> [UnsafeMutablePointer<cmark_node>]
  {
    guard let iterator = cmark_iter_new(document) else { return [] }
    defer { cmark_iter_free(iterator) }
    var links: [UnsafeMutablePointer<cmark_node>] = []
    var event = cmark_iter_next(iterator)
    while event != CMARK_EVENT_DONE {
      if event == CMARK_EVENT_ENTER, let node = cmark_iter_get_node(iterator),
        String(cString: cmark_node_get_type_string(node)) == "link",
        let url = cmark_node_get_url(node), isGitHub(String(cString: url))
      {
        links.append(node)
      }
      event = cmark_iter_next(iterator)
    }
    return links
  }

  static func image(dark: Bool, pointSize: CGFloat) -> Image {
    guard let logo = UIImage(named: "Service-github") else { return Image(systemName: "link") }
    let style = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
    let color = QMTheme.markdownLinkColor.resolvedColor(with: style)
    let size = CGSize(width: pointSize, height: pointSize)
    let drawn = UIGraphicsImageRenderer(size: size).image { _ in
      logo.withTintColor(color, renderingMode: .alwaysOriginal)
        .draw(in: CGRect(origin: .zero, size: size))
    }
    return Image(uiImage: drawn.withBaselineOffset(fromBottom: pointSize * 0.125))
  }
}
