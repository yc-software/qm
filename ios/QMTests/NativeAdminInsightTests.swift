import XCTest

@testable import QM

final class NativeAdminInsightTests: XCTestCase {
  func testFutureCohortWeeksAreNotReportedAsZeroRetention() throws {
    let formatter = ISO8601DateFormatter()
    let start =
      try XCTUnwrap(formatter.date(from: "2026-09-17T00:00:00Z")).timeIntervalSince1970 * 1000
    let cohort = NativeRetentionReport.Cohort(week: "2026-09-17", size: 1, retained: [100, 0, 0])
    XCTAssertTrue(cohort.observed(0, at: start))
    XCTAssertFalse(cohort.observed(1, at: start + 7 * 86400 * 1000 - 1))
    XCTAssertTrue(cohort.observed(1, at: start + 7 * 86400 * 1000))
    XCTAssertFalse(cohort.observed(2, at: start + 7 * 86400 * 1000))
    XCTAssertFalse(
      NativeRetentionReport.Cohort(week: "invalid", size: 1, retained: []).observed(0, at: start))
  }
}
