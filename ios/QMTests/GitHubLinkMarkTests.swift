import XCTest

@testable import QM

final class GitHubLinkMarkTests: XCTestCase {
  private let mark = "![](qm-github-mark:)\u{00A0}"

  func testMarksGitHubLinksLikeWeb() {
    let pull = "https://github.com/yc-software/qm/pull/3615"
    XCTAssertTrue(GitHubLinkMark.decorate("See [#3615](\(pull)) now.").contains("\(mark)["))
    XCTAssertTrue(GitHubLinkMark.decorate("See \(pull) now.").contains(mark))
    XCTAssertTrue(GitHubLinkMark.decorate("| PR |\n|---|\n| [x](\(pull)) |").contains(mark))
  }

  func testLeavesOtherLinksCodeAndImagesAlone() {
    for text in [
      "[docs](https://example.com/github.com)",
      "`https://github.com/a/b`",
      "```\n[x](https://github.com/y)\n```",
      "![badge](https://github.com/a/b/badge.svg)",
      "[insecure](http://github.com/a)",
    ] {
      XCTAssertEqual(GitHubLinkMark.decorate(text), text)
    }
  }

  func testMatchesWebHosts() {
    XCTAssertTrue(GitHubLinkMark.isGitHub("https://www.github.com/a"))
    XCTAssertFalse(GitHubLinkMark.isGitHub("https://gist.github.com/a"))
    XCTAssertFalse(GitHubLinkMark.isGitHub("https://github.com.evil.test/a"))
  }
}
