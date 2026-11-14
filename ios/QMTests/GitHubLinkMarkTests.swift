import XCTest

@testable import QM

final class GitHubLinkMarkTests: XCTestCase {
  private let mark = "![](qm-github-mark:)\u{00A0}"

  func testMarksGitHubLinksLikeWeb() {
    XCTAssertEqual(
      GitHubLinkMark.decorate("See [#3615](https://github.com/yc-software/qm/pull/3615) now."),
      "See \(mark)[#3615](https://github.com/yc-software/qm/pull/3615) now.")
    XCTAssertEqual(
      GitHubLinkMark.decorate("<https://github.com/a/b> and https://www.github.com/c"),
      "\(mark)<https://github.com/a/b> and \(mark)https://www.github.com/c")
  }

  func testLeavesOtherLinksCodeAndImagesAlone() {
    for text in [
      "[docs](https://example.com/github.com)",
      "`https://github.com/a/b` and ``[x](https://github.com/y)``",
      "```\n[x](https://github.com/y)\n```",
      "    https://github.com/indented/code",
      "![badge](https://github.com/a/b/badge.svg)",
      "http://github.com/insecure",
    ] {
      XCTAssertEqual(GitHubLinkMark.decorate(text), text)
    }
  }
}
