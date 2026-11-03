import XCTest

@testable import QM

@MainActor
final class LoadGuardTests: XCTestCase {
  @MainActor final class Gate {
    var waiting: CheckedContinuation<Void, Never>?
    var events: [String] = []
    func wait() async { await withCheckedContinuation { waiting = $0 } }
    func started() async { while waiting == nil { await Task.yield() } }
    func open() async {
      await started()
      waiting?.resume()
    }
  }

  func testNewerRunDropsStaleResponseAndStaleFailure() async {
    let loader = LoadGuard()
    let gate = Gate()
    let stale = Task {
      await loader.run {
        await gate.wait()
        return "stale"
      } apply: {
        gate.events.append($0)
      } failed: { _ in
        gate.events.append("failed")
      }
    }
    await gate.started()
    XCTAssertTrue(loader.loading)
    await loader.run {
      "fresh"
    } apply: {
      gate.events.append($0)
    } failed: { _ in
      gate.events.append("failed")
    }
    await gate.open()
    let staleApplied = await stale.value
    XCTAssertFalse(staleApplied)
    XCTAssertEqual(gate.events, ["fresh"])
    XCTAssertFalse(loader.loading)
  }

  func testCancelDropsInFlightLoad() async {
    let loader = LoadGuard()
    let gate = Gate()
    let load = Task {
      await loader.run {
        await gate.wait()
        throw QMError.message("late")
      } apply: { (_: Int) in
        gate.events.append("applied")
      } failed: { _ in
        gate.events.append("failed")
      }
    }
    await gate.started()
    loader.cancel()
    XCTAssertFalse(loader.loading)
    await gate.open()
    _ = await load.value
    XCTAssertEqual(gate.events, [])
  }

  func testTaskCancellationIsSilent() async {
    let loader = LoadGuard()
    let gate = Gate()
    let load = Task {
      await loader.run {
        await gate.wait()
        return "value"
      } apply: { _ in
        gate.events.append("applied")
      } failed: { _ in
        gate.events.append("failed")
      }
    }
    await gate.started()
    load.cancel()
    await gate.open()
    _ = await load.value
    XCTAssertEqual(gate.events, [])
    XCTAssertFalse(loader.loading)
  }

  func testCurrentFailureIsReported() async {
    let loader = LoadGuard()
    var message: String?
    let ok = await loader.run {
      "value"
    } apply: { _ in
      throw QMError.message("Bad page")
    } failed: {
      message = $0.localizedDescription
    }
    XCTAssertFalse(ok)
    XCTAssertEqual(message, "Bad page")
    XCTAssertFalse(loader.loading)
  }

  func testContinuingRunKeepsRevisionUntilRestart() async {
    let loader = LoadGuard()
    let revision = loader.revision
    await loader.run(restart: false) {
      1
    } apply: { _ in
    } failed: { _ in
    }
    XCTAssertEqual(loader.revision, revision)
    await loader.run {
      2
    } apply: { _ in
    } failed: { _ in
    }
    XCTAssertNotEqual(loader.revision, revision)
  }
}
