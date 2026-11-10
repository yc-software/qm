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

  func testContinuingRunKeepsEarlierLoadUntilRestart() async {
    let loader = LoadGuard()
    var events: [String] = []
    let first = Gate()
    let earlier = Task {
      await loader.run {
        await first.wait()
        return "earlier"
      } apply: {
        events.append($0)
      } failed: { _ in
      }
    }
    await first.started()
    await loader.run(restart: false) {
      "continued"
    } apply: {
      events.append($0)
    } failed: { _ in
    }
    await first.open()
    let earlierApplied = await earlier.value
    XCTAssertTrue(earlierApplied)
    let second = Gate()
    let continued = Task {
      await loader.run(restart: false) {
        await second.wait()
        return "dropped"
      } apply: {
        events.append($0)
      } failed: { _ in
      }
    }
    await second.started()
    await loader.run {
      "restarted"
    } apply: {
      events.append($0)
    } failed: { _ in
    }
    await second.open()
    let continuedApplied = await continued.value
    XCTAssertFalse(continuedApplied)
    XCTAssertEqual(events, ["continued", "earlier", "restarted"])
  }
}
