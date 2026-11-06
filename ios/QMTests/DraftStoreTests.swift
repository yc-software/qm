import XCTest

@testable import QM

final class DraftStoreTests: XCTestCase {
  func testMissingDraftReadsEmptyWithoutSettingAnythingAside() throws {
    let account = "drafts-\(UUID().uuidString)"
    defer { DraftStore.removeAccount(account) }
    let store = DraftStore(account: account, thread: "thread")
    XCTAssertEqual(store.read().text, "")
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: store.file.deletingLastPathComponent().path))
  }

  func testUnreadableDraftIsSetAsideBeforeTheNextSave() throws {
    let account = "drafts-\(UUID().uuidString)"
    defer { DraftStore.removeAccount(account) }
    let store = DraftStore(account: account, thread: "thread")
    try store.write(.init(text: "kept"))
    XCTAssertEqual(store.read().text, "kept")
    let damaged = Data("{\"text\":".utf8)
    try damaged.write(to: store.file)

    XCTAssertEqual(store.read().text, "")
    try store.write(.init(text: "next"))

    let directory = store.file.deletingLastPathComponent()
    let aside = try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil
    ).filter { $0.lastPathComponent.hasPrefix(store.file.lastPathComponent + ".corrupt-") }
    XCTAssertEqual(aside.count, 1)
    XCTAssertEqual(try Data(contentsOf: aside[0]), damaged)
    XCTAssertEqual(store.read().text, "next")
    XCTAssertTrue(DraftStore.conversations(account).isEmpty)
  }
}
