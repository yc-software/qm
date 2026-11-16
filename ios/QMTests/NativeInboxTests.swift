import XCTest

@testable import QM

extension NativeRouteProtocol.Call {
  fileprivate var args: [String: Any] { json["args"] as? [String: Any] ?? [:] }
}

@MainActor
final class NativeInboxTests: XCTestCase {
  nonisolated private static let item =
    #"{"id":"i1","loopId":"l1","state":"processed","source":"gmail","sourcePayload":{"title":"Review this","from":"test@example.com"},"proposal":{"data":{"body":"Server draft","to":["test@example.com"]},"by":"agent","at":123},"thread":[],"updatedAt":123}"#
  private static func item(_ id: String, state: String = "held", triage: String = "{}") -> String {
    #"{"id":"\#(id)","loopId":"l1","state":"\#(state)","source":"gmail","sourcePayload":{"title":"Item \#(id)"},"thread":[],"updatedAt":1,"triage":\#(triage)}"#
  }
  private let server = NativeRouteProtocol.Server(
    fallback: .init(body: "{\"item\":" + NativeInboxTests.item + "}"))
  private let action = "POST /api/loops/l1/items/i1/action"
  private let detail = "GET /api/loops/l1/items/i1"
  func client() -> APIClient { server.client() }
  func model() throws -> InboxDetailModel {
    let item = try JSONDecoder().decode(
      NativeInboxItem.self, from: Data(Self.item.utf8))
    return InboxDetailModel(client: client(), user: "test", item: item)
  }
  func feed(
    _ items: [String], loops: String = #"{"id":"l1","name":"Mail","count":0}"#, total: Int? = nil,
    next: String? = nil, filter: String = "human"
  ) -> String {
    #"{"selected":[\#(loops)],"available":[\#(loops)],"items":[\#(items.joined(separator: ","))],"total":\#(total ?? items.count),"nextCursor":\#(next.map { "\"\($0)\"" } ?? "null"),"filter":"\#(filter)"}"#
  }
  func opened(_ json: String, in inbox: InboxModel) async throws -> InboxDetailModel {
    let item = try JSONDecoder().decode(NativeInboxItem.self, from: Data(json.utf8))
    server.reply("GET /api/loops/l1/items/\(item.id)", #"{"item":\#(json)}"#)
    let model = InboxDetailModel(client: inbox.client, user: "test", item: item, inbox: inbox)
    await model.load()
    return model
  }
  func testSlackItemsShowNamesInsteadOfWireTokensAndMailIsLeftAsWritten() throws {
    let text = #"<@U1|ada> shared <https://docs.example/plan|the plan>"#
    let payloads = try ["slack", "gmail"].map { source in
      try JSONDecoder().decode(
        NativeInboxItem.Payload.self, from: Data(#"{"source":"\#(source)"}"#.utf8))
    }
    XCTAssertEqual(payloads.map { $0.readable(text) }, ["@ada shared the plan", text])
  }

  func testPriorityChangeIsSentAndShownOnTheInboxRow() async throws {
    let original = Self.item("i1")
    server.reply(
      "GET /api/inbox",
      feed([original], loops: #"{"id":"l1","name":"Mail","count":1,"prioritize":true}"#))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    let model = try await opened(original, in: inbox)
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    XCTAssertTrue(model.canPrioritize)
    XCTAssertEqual(model.item.priority, "normal")
    server.reply(
      action,
      #"{"item":\#(Self.item("i1", triage: #"{"priority":"urgent"}"#))}"#)

    let changed = await model.action("prioritize", args: ["priority": "urgent"])

    XCTAssertTrue(changed)
    let call = try XCTUnwrap(server.calls(to: action).last)
    XCTAssertEqual(call.json["kind"] as? String, "prioritize")
    XCTAssertEqual(call.args["priority"] as? String, "urgent")
    XCTAssertEqual(model.item.priority, "urgent")
    XCTAssertEqual(inbox.items.first?.priority, "urgent")
  }
  func testPriorityIsNotOfferedWhenTheLoopDoesNotPrioritizeOrTheItemIsHandled() async throws {
    server.reply(
      "GET /api/inbox",
      feed([
        Self.item("i1"),
        Self.item("i2", state: "dismissed", triage: #"{"priority":"high"}"#),
      ]))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    let plain = InboxDetailModel(
      client: inbox.client, user: "test", item: inbox.items[0], inbox: inbox)
    let handled = InboxDetailModel(
      client: inbox.client, user: "test", item: inbox.items[1], inbox: inbox)
    XCTAssertFalse(plain.canPrioritize)
    XCTAssertFalse(handled.canPrioritize)
  }
  func testPriorityChangeOnAnItemArchivedMeanwhileShowsTheServersReason() async throws {
    let original = Self.item("i1", triage: #"{"priority":"high"}"#)
    server.reply("GET /api/inbox", feed([original]))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    let model = try await opened(original, in: inbox)
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    server.reply(
      action, status: 409, #"{"error":"conflict","message":"this item is already actioned"}"#)

    let changed = await model.action("prioritize", args: ["priority": "low"])

    XCTAssertFalse(changed)
    XCTAssertEqual(model.error, "this item is already actioned")
    XCTAssertEqual(model.item.priority, "high")
    XCTAssertEqual(server.calls(to: detail).count, 1)
  }
  func testReopenIsOnlyOfferedAndSentForDismissedItems() async throws {
    server.reply(
      "GET /api/inbox",
      feed([
        Self.item("i1", state: "actioned"),
        Self.item("i2", state: "dismissed"),
      ]))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "handled", loop: "all")
    let sent = try await opened(Self.item("i1", state: "actioned"), in: inbox)
    defer { DraftStore.removeAccount(sent.client.baseURL.absoluteString + "test") }
    XCTAssertFalse(sent.item.canReopen)

    let refused = await sent.reopen()

    XCTAssertFalse(refused)
    XCTAssertTrue(server.calls(to: action).isEmpty)

    let archived = try await opened(Self.item("i2", state: "dismissed"), in: inbox)
    XCTAssertTrue(archived.item.canReopen)
    let route = "POST /api/loops/l1/items/i2/action"
    server.reply(route, #"{"item":\#(Self.item("i2"))}"#)

    let reopened = await archived.reopen()

    XCTAssertTrue(reopened)
    XCTAssertEqual(server.calls(to: route).last?.json["kind"] as? String, "reopen")
    XCTAssertFalse(archived.item.canReopen)
  }
  func testArchivingAGroupShowsWhatTheServerLeftOpen() async throws {
    let grouped = #"{"groupId":"i1"}"#
    let head = Self.item("i1", triage: grouped)
    let working = Self.item("i3", state: "processed", triage: grouped)
    let plain = Self.item("i4")
    server.reply(
      "GET /api/inbox",
      feed(
        [head, Self.item("i2", triage: grouped), working, plain],
        loops: #"{"id":"l1","name":"Mail","count":5}"#, total: 7))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "l1")
    let model = try await opened(head, in: inbox)
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    XCTAssertEqual(inbox.groupSize(inbox.items[0]), 3)
    XCTAssertEqual(inbox.groupSize(inbox.items[1]), 1)
    server.reply(
      action,
      #"{"item":\#(Self.item("i1", state: "dismissed", triage: grouped))}"#)
    server.reply(
      "GET /api/inbox",
      feed([working, plain], loops: #"{"id":"l1","name":"Mail","count":3}"#, total: 5))

    let archived = await model.archive()

    XCTAssertTrue(archived)
    let call = try XCTUnwrap(server.calls(to: action).last)
    XCTAssertEqual(call.json["kind"] as? String, "dismiss")
    XCTAssertEqual(call.args["group"] as? Bool, true)
    let reload = try XCTUnwrap(server.calls.last)
    XCTAssertEqual(reload.route, "GET /api/inbox")
    XCTAssertNil(reload.parameters["view"])
    XCTAssertEqual(reload.parameters["loopId"], "l1")
    XCTAssertEqual(inbox.items.map(\.id), ["i3", "i4"])
    XCTAssertEqual(inbox.openCount("all"), 5)
    XCTAssertEqual(inbox.openCount("l1"), 3)
  }
  func testGroupHeadOpenedOutsideTheInboxArchivesItsGroupAndAMemberDoesNot() async throws {
    let grouped = #"{"groupId":"i1"}"#
    for (id, group) in [("i1", true), ("i2", false)] {
      let json = Self.item(id, triage: grouped)
      let item = try JSONDecoder().decode(NativeInboxItem.self, from: Data(json.utf8))
      let route = "POST /api/loops/l1/items/\(id)/action"
      server.reply("GET /api/loops/l1/items/\(id)", #"{"item":\#(json)}"#)
      server.reply(
        route, #"{"item":\#(Self.item(id, state: "dismissed", triage: grouped))}"#)
      let model = InboxDetailModel(client: client(), user: "test", item: item)
      defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
      await model.load()
      XCTAssertEqual(model.item.leadsGroup, group)

      let archived = await model.archive()

      XCTAssertTrue(archived)
      let call = try XCTUnwrap(server.calls(to: route).last)
      XCTAssertEqual(call.json["kind"] as? String, "dismiss")
      XCTAssertEqual(call.args["group"] as? Bool, group ? true : nil)
      XCTAssertFalse(model.item.leadsGroup)
    }
  }
  func testGroupSizeIsNotClaimedWhileItsMembersMayContinueOnTheNextPage() async throws {
    let grouped = #"{"groupId":"i1"}"#
    let head = Self.item("i1", triage: grouped)
    let member = Self.item("i2", triage: grouped)
    server.reply("GET /api/inbox", feed([head, member], next: "c1"))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    XCTAssertEqual(inbox.groupSize(inbox.items[0]), 1)
    server.reply(
      "GET /api/inbox",
      feed(
        [Self.item("i3", triage: grouped), Self.item("i4")],
        next: "c2"))

    await inbox.load(view: "open", loop: "all", reset: false)

    XCTAssertEqual(inbox.groupSize(inbox.items[0]), 3)
  }
  func testRefreshKeepsPagesAlreadyLoadedUntilTheQueryChanges() async throws {
    let rows = (0...5).map { Self.item("i\($0)") }
    let list = "GET /api/inbox"
    server.reply(list, feed([rows[1], rows[2]], next: "c1"))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    server.reply(list, feed([rows[3], rows[4]], next: "c2"))
    await inbox.load(view: "open", loop: "all", reset: false)
    XCTAssertEqual(inbox.items.map(\.id), ["i1", "i2", "i3", "i4"])

    server.reply(list, feed([rows[0], rows[1]], next: "c0"))
    await inbox.load(view: "open", loop: "all")

    XCTAssertNil(server.calls(to: list).last?.parameters["cursor"])
    XCTAssertEqual(inbox.items.map(\.id), ["i0", "i1", "i2", "i3", "i4"])
    XCTAssertEqual(inbox.nextCursor, "c2")

    server.reply(list, feed([rows[0], rows[2]], next: "c0"))
    await inbox.load(view: "open", loop: "all")

    XCTAssertEqual(inbox.items.map(\.id), ["i0", "i2", "i3", "i4"])

    server.reply(list, feed([rows[5]]))
    await inbox.load(view: "open", loop: "all", reset: false)

    XCTAssertEqual(server.calls(to: list).last?.parameters["cursor"], "c2")
    XCTAssertEqual(inbox.items.map(\.id), ["i0", "i2", "i3", "i4", "i5"])
    XCTAssertNil(inbox.nextCursor)

    server.reply(list, feed([rows[4]]))
    await inbox.load(view: "handled", loop: "all")

    XCTAssertEqual(inbox.items.map(\.id), ["i4"])
  }
  func testRefreshThatFitsOnOnePageDropsRowsLoadedEarlier() async throws {
    let rows = (1...3).map { Self.item("i\($0)") }
    server.reply("GET /api/inbox", feed([rows[0], rows[1]], next: "c1"))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    server.reply("GET /api/inbox", feed([rows[2]]))
    await inbox.load(view: "open", loop: "all", reset: false)
    server.reply("GET /api/inbox", feed([rows[0]]))

    await inbox.load(view: "open", loop: "all")

    XCTAssertEqual(inbox.items.map(\.id), ["i1"])
    XCTAssertNil(inbox.nextCursor)
  }
  func testOpenCountsFollowAnItemReopenedAndArchivedFromTheSameDetail() async throws {
    let original = Self.item("i1", state: "dismissed")
    server.reply(
      "GET /api/inbox",
      feed(
        [original, Self.item("i2", state: "actioned")],
        loops: #"{"id":"l1","name":"Mail","count":2}"#, total: 2))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "handled", loop: "all")
    let model = try await opened(original, in: inbox)
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    server.reply(action, #"{"item":\#(Self.item("i1"))}"#)
    let reopened = await model.reopen()
    XCTAssertTrue(reopened)
    XCTAssertEqual(inbox.items.map(\.id), ["i2"])
    XCTAssertEqual(inbox.openCount("all"), 3)
    XCTAssertEqual(inbox.openCount("l1"), 3)
    server.reply(action, #"{"item":\#(original)}"#)

    let archived = await model.archive()

    XCTAssertTrue(archived)
    XCTAssertEqual(inbox.items.map(\.id), ["i2"])
    XCTAssertEqual(inbox.openCount("all"), 2)
    XCTAssertEqual(inbox.openCount("l1"), 2)
  }
  func testItemHandledElsewhereLeavesTheOpenListWhenItsDetailRefreshes() async throws {
    let original = Self.item("i1")
    server.reply(
      "GET /api/inbox",
      feed(
        [original, Self.item("i2")],
        loops: #"{"id":"l1","name":"Mail","count":2}"#))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    let model = try await opened(original, in: inbox)
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    XCTAssertEqual(inbox.items.map(\.id), ["i1", "i2"])
    server.reply(
      detail, #"{"item":\#(Self.item("i1", state: "actioned"))}"#)

    await model.load()

    XCTAssertEqual(inbox.items.map(\.id), ["i2"])
    XCTAssertEqual(inbox.openCount("all"), 1)
    XCTAssertEqual(inbox.openCount("l1"), 1)
  }
  func testArchivingAnUngroupedItemLeavesOtherItemsAndSendsNoGroupFlag() async throws {
    let original = Self.item("i1")
    server.reply(
      "GET /api/inbox", feed([original, Self.item("i2")]))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    let model = try await opened(original, in: inbox)
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    server.reply(
      action, #"{"item":\#(Self.item("i1", state: "dismissed"))}"#)

    let archived = await model.archive()

    XCTAssertTrue(archived)
    XCTAssertTrue(try XCTUnwrap(server.calls(to: action).last).args.isEmpty)
    XCTAssertEqual(inbox.items.map(\.id), ["i2"])
    XCTAssertEqual(inbox.openCount("all"), 1)
  }
  func testRemoveFromGroupIsOnlyOfferedAndSentForGroupedOpenItems() async throws {
    let grouped = #"{"groupId":"i1"}"#
    let member = Self.item("i2", triage: grouped)
    let plain = Self.item("i3")
    server.reply(
      "GET /api/inbox",
      feed([Self.item("i1", triage: grouped), member, plain]))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    let ungrouped = try await opened(plain, in: inbox)
    defer { DraftStore.removeAccount(ungrouped.client.baseURL.absoluteString + "test") }
    XCTAssertFalse(ungrouped.canUngroup)
    let refused = await ungrouped.ungroup()
    XCTAssertFalse(refused)
    XCTAssertTrue(server.calls(to: "POST /api/loops/l1/items/i3/action").isEmpty)

    let model = try await opened(member, in: inbox)
    XCTAssertTrue(model.canUngroup)
    XCTAssertEqual(inbox.groupSize(inbox.items[0]), 2)
    let route = "POST /api/loops/l1/items/i2/action"
    server.reply(route, #"{"item":\#(Self.item("i2"))}"#)

    let removed = await model.ungroup()

    XCTAssertTrue(removed)
    let call = try XCTUnwrap(server.calls(to: route).last)
    XCTAssertEqual(call.json["kind"] as? String, "ungroup")
    XCTAssertFalse(model.canUngroup)
    XCTAssertEqual(inbox.groupSize(inbox.items[0]), 1)
    XCTAssertEqual(inbox.items.count, 3)
  }
  func testRemovingTheActiveSourceFallsBackToAllAndRefetches() async throws {
    let both =
      #"{"id":"l1","name":"Mail","count":0},{"id":"l2","name":"Chat","count":0}"#
    server.reply("GET /api/inbox", feed([], loops: both))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "handled", loop: "l2")
    server.reply("GET /api/inbox", feed([]))
    server.reply("POST /api/inbox/selection", "{}")

    let active = try await inbox.select(inbox.selected[1], view: "handled", active: "l2")

    XCTAssertEqual(active, "all")
    let saved = try XCTUnwrap(server.calls(to: "POST /api/inbox/selection").last)
    XCTAssertEqual(saved.json["loopIds"] as? [String], ["l1"])
    let refetch = try XCTUnwrap(server.calls.last)
    XCTAssertEqual(refetch.route, "GET /api/inbox")
    XCTAssertNil(refetch.parameters["loopId"])
    XCTAssertEqual(refetch.parameters["view"], "handled")
    XCTAssertEqual(inbox.selected.map(\.id), ["l1"])
    XCTAssertTrue(inbox.showsEmptyState(view: "handled", loop: "all"))
  }
  func testRemovingAnotherSourceKeepsTheActiveSource() async throws {
    let both =
      #"{"id":"l1","name":"Mail","count":0},{"id":"l2","name":"Chat","count":0}"#
    server.reply("GET /api/inbox", feed([], loops: both))
    server.reply("POST /api/inbox/selection", "{}")
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "l2")

    let active = try await inbox.select(inbox.selected[0], view: "open", active: "l2")

    XCTAssertEqual(active, "l2")
    XCTAssertEqual(server.calls.last?.parameters["loopId"], "l2")
  }
  private func refusal(_ change: () async throws -> Void) async -> String? {
    do {
      try await change()
      return nil
    } catch { return error.localizedDescription }
  }
  func testFailedSourceRemovalIsReportedToTheSheetAndKeepsTheSource() async throws {
    server.reply("GET /api/inbox", feed([]))
    server.reply(
      "POST /api/inbox/selection", status: 403,
      #"{"error":"forbidden","message":"not your inbox"}"#)
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "l1")

    let refused = await refusal {
      _ = try await inbox.select(inbox.selected[0], view: "open", active: "l1")
    }

    XCTAssertEqual(refused, "not your inbox")
    XCTAssertNil(inbox.error)
    XCTAssertFalse(inbox.busy)
    XCTAssertEqual(inbox.selected.map(\.id), ["l1"])
    XCTAssertEqual(server.calls(to: "GET /api/inbox").count, 1)
  }
  func testInboxShowsTheFilterTheServerResolvedWithoutSendingOne() async throws {
    server.reply("GET /api/inbox", feed([], filter: "triaged"))
    let inbox = InboxModel(client: client())

    await inbox.load(view: "open", loop: "all")

    XCTAssertEqual(inbox.filter, "triaged")
    XCTAssertNil(server.calls(to: "GET /api/inbox").last?.parameters["filter"])
  }
  func testChoosingAFilterSavesItThenShowsWhatTheServerApplied() async throws {
    server.reply("GET /api/inbox", feed([Self.item("i1")]))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "handled", loop: "l1")
    server.reply("PUT /api/ui-state", #"{"ok":true,"updatedAt":9}"#)
    server.reply("GET /api/inbox", feed([], filter: "all"))

    await inbox.selectFilter("all")

    let saved = try XCTUnwrap(server.calls(to: "PUT /api/ui-state").last)
    XCTAssertEqual(saved.json["key"] as? String, "inbox-filter")
    XCTAssertEqual(saved.json["value"] as? String, "all")
    XCTAssertGreaterThan(try XCTUnwrap(saved.json["updatedAt"] as? Double), 1_700_000_000_000)
    let reload = try XCTUnwrap(server.calls.last)
    XCTAssertEqual(reload.route, "GET /api/inbox")
    XCTAssertEqual(reload.parameters, ["view": "handled", "loopId": "l1"])
    XCTAssertEqual(inbox.filter, "all")
    XCTAssertTrue(inbox.items.isEmpty)
    XCTAssertNil(inbox.notice)
    XCTAssertFalse(inbox.busy)
  }
  func testFilterTheServerFailsToSaveIsLeftUnchangedAndTheErrorIsReported() async throws {
    server.reply("GET /api/inbox", feed([]))
    server.reply(
      "PUT /api/ui-state", status: 500, #"{"message":"Preferences are unavailable."}"#)
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")

    await inbox.selectFilter("triaged")

    XCTAssertEqual(inbox.filter, "human")
    XCTAssertEqual(inbox.notice, "Filter not saved. Preferences are unavailable.")
    XCTAssertEqual(server.calls(to: "GET /api/inbox").count, 1)
    XCTAssertFalse(inbox.busy)
  }
  func testFilterRefusedForANewerSavedOneShowsTheSavedOneWithoutOverwritingIt() async throws {
    server.reply("GET /api/inbox", feed([], filter: "all"))
    server.reply("PUT /api/ui-state", #"{"ok":false,"updatedAt":99}"#)
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")

    await inbox.selectFilter("triaged")

    XCTAssertEqual(server.calls(to: "PUT /api/ui-state").count, 1)
    XCTAssertEqual(server.calls(to: "GET /api/inbox").count, 2)
    XCTAssertEqual(inbox.filter, "all")
    XCTAssertNotNil(inbox.notice)
  }
  func testRefreshAfterTheFilterChangedElsewhereDropsPagesLoadedUnderTheOldFilter() async throws {
    let rows = (1...2).map { Self.item("i\($0)") }
    let list = "GET /api/inbox"
    server.reply(list, feed([rows[0]], next: "c1", filter: "all"))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    server.reply(list, feed([rows[1]], next: "c2", filter: "all"))
    await inbox.load(view: "open", loop: "all", reset: false)
    XCTAssertEqual(inbox.items.map(\.id), ["i1", "i2"])
    server.reply(list, feed([rows[0]], next: "c1", filter: "triaged"))

    await inbox.load(view: "open", loop: "all")

    XCTAssertEqual(inbox.filter, "triaged")
    XCTAssertEqual(inbox.items.map(\.id), ["i1"])
    XCTAssertEqual(inbox.nextCursor, "c1")
  }
  func testEmailFilterIsOnlyOfferedForAllAndMailSources() async throws {
    server.reply(
      "GET /api/inbox",
      feed(
        [],
        loops:
          #"{"id":"l1","name":"Mail","source":"gmail","sources":["gmail"]},{"id":"l2","name":"Chat","source":"slack","sources":["slack"]},{"id":"l3","name":"Mixed","sources":["slack","gmail"]}"#
      ))
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    XCTAssertEqual(
      ["all", "l1", "l2", "l3"].map(inbox.filtersEmail), [true, true, false, true])
  }
  private func synced(_ enabled: Bool) -> String {
    feed(
      [],
      loops:
        #"{"id":"l1","name":"Mail","source":"gmail","syncCron":{"id":"c1","enabled":\#(enabled)}}"#
    )
  }
  func testScheduledSyncCanBeTurnedOn() async throws {
    server.reply("GET /api/inbox", synced(false))
    server.reply("POST /api/inbox/sync-cron", "{}")
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")
    XCTAssertEqual(inbox.selected[0].syncCron?.enabled, false)
    server.reply("GET /api/inbox", synced(true))

    try await inbox.enableSync(inbox.selected[0], view: "open", active: "all")

    let call = try XCTUnwrap(server.calls(to: "POST /api/inbox/sync-cron").last)
    XCTAssertEqual(call.json["enabled"] as? Bool, true)
    XCTAssertEqual(call.json["loopId"] as? String, "l1")
    XCTAssertEqual(inbox.selected[0].syncCron?.enabled, true)
    XCTAssertNil(inbox.error)
  }
  func testRefusedSyncIsReportedToTheSheetAndLeavesSyncOff() async throws {
    server.reply("GET /api/inbox", synced(false))
    server.reply(
      "POST /api/inbox/sync-cron", status: 400,
      #"{"error":"bad_request","message":"a sync is running"}"#)
    let inbox = InboxModel(client: client())
    await inbox.load(view: "open", loop: "all")

    let refused = await refusal {
      try await inbox.enableSync(inbox.selected[0], view: "open", active: "all")
    }

    XCTAssertEqual(refused, "a sync is running")
    XCTAssertNil(inbox.error)
    XCTAssertEqual(inbox.selected[0].syncCron?.enabled, false)
    XCTAssertFalse(inbox.busy)
    XCTAssertEqual(server.calls(to: "GET /api/inbox").count, 1)
  }
  func testOnlyAnExplicitRefreshRePullsTheOriginal() async throws {
    let model = try model()
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    await model.load()
    XCTAssertNil(server.calls(to: detail).last?.parameters["refreshSource"])

    await model.load(refreshSource: true)

    XCTAssertEqual(server.calls(to: detail).last?.parameters["refreshSource"], "1")
    XCTAssertEqual(server.calls(to: detail).count, 2)
  }
  func testPriorityChangeOnADeletedItemSurfacesTheServerError() async throws {
    let model = try model()
    defer { DraftStore.removeAccount(model.client.baseURL.absoluteString + "test") }
    await model.load()
    let gone = #"{"error":"not_found","message":"no such ledger item"}"#
    server.reply(action, status: 404, gone)
    server.reply(detail, status: 404, gone)

    let changed = await model.action("prioritize", args: ["priority": "low"])

    XCTAssertFalse(changed)
    XCTAssertEqual(model.error, "no such ledger item")
    XCTAssertEqual(server.calls(to: detail).count, 1)
  }
  func testInboxDraftSurvivesReopeningWithOriginalProposalVersion() async throws {
    let first = try model()
    let account = first.client.baseURL.absoluteString + "test"
    defer { DraftStore.removeAccount(account) }
    await first.load()
    first.text = "My unsaved reply"
    first.to = "review@example.com"
    first.persistDraft()
    let reopened = InboxDetailModel(client: first.client, user: "test", item: first.item)
    await reopened.load()
    XCTAssertEqual(reopened.text, "My unsaved reply")
    XCTAssertEqual(reopened.to, "review@example.com")
    XCTAssertEqual(reopened.proposalAt, 123)
    XCTAssertTrue(reopened.dirty)
    XCTAssertTrue(DraftStore.conversations(account).isEmpty)
    await reopened.discardDraft()
    XCTAssertEqual(reopened.text, "Server draft")
    XCTAssertNil(reopened.drafts.read().inbox)
  }
  func testFollowupSurvivesReopeningAndReplyDiscard() async throws {
    let first = try model()
    defer { DraftStore.removeAccount(first.client.baseURL.absoluteString + "test") }
    await first.load()
    first.followup = "Check the proposed delivery date"
    first.persistDraft()
    let reopened = InboxDetailModel(client: first.client, user: "test", item: first.item)
    await reopened.load()
    XCTAssertEqual(reopened.followup, "Check the proposed delivery date")
    XCTAssertFalse(reopened.dirty)
    reopened.text = "Unsent reply"
    await reopened.discardDraft()
    XCTAssertEqual(reopened.drafts.read().text, "Check the proposed delivery date")
    reopened.followup = ""
    reopened.persistDraft()
    XCTAssertEqual(reopened.drafts.read().text, "")
  }
  func testSignOutPreventsLateInboxAndConversationDraftWrites() async throws {
    let inbox = try model()
    let account = inbox.client.baseURL.absoluteString + "test"
    defer { DraftStore.removeAccount(account) }
    let chat = DraftStore(account: account, thread: "chat")
    await inbox.load()
    inbox.text = "Private reply"
    inbox.persistDraft()
    DraftStore.removeAccount(account)
    inbox.persistDraft()
    XCTAssertThrowsError(try chat.write(.init(text: "Late private chat")))
    XCTAssertNil(inbox.drafts.read().inbox)
    let signedInAgain = DraftStore(account: account, thread: "chat")
    try signedInAgain.write(.init(text: "New session"))
    XCTAssertEqual(signedInAgain.read().text, "New session")
  }
  func testInboundDraftRequestUsesFollowupEndpoint() async throws {
    let inbox = try model()
    defer { DraftStore.removeAccount(inbox.client.baseURL.absoluteString + "test") }
    await inbox.load()
    let success = await inbox.requestDraft()
    XCTAssertTrue(success)
    XCTAssertEqual(
      server.calls.last?.url.path, "/api/loops/l1/items/i1/followup")
  }
  func testSentChatUsesMetadataHeadersOnlyWhenProposalDoesNotSpecifyThem() async throws {
    let inbox = try model()
    defer { DraftStore.removeAccount(inbox.client.baseURL.absoluteString + "test") }
    let data = Data(
      #"{"id":"sent","loopId":"l1","state":"processed","source":"gmail","sourcePayload":{"sentChat":true,"gmail":{"to":["recipient@example.com"],"cc":["copy@example.com"],"subject":"Original subject"}},"proposal":{"data":{"body":""},"by":"human","at":99},"thread":[],"updatedAt":99}"#
        .utf8)
    let item = try JSONDecoder().decode(NativeInboxItem.self, from: data)
    let detail = NativeInboxDetail(item: item, outputs: nil)
    inbox.accept(detail)
    XCTAssertEqual(inbox.to, "recipient@example.com")
    XCTAssertEqual(inbox.cc, "copy@example.com")
    XCTAssertEqual(inbox.subject, "Original subject")
    let cleared = String(data: data, encoding: .utf8)!.replacingOccurrences(
      of: #""data":{"body":""}"#, with: #""data":{"body":"","to":[],"cc":[],"subject":""}"#)
    inbox.accept(
      .init(
        item: try JSONDecoder().decode(NativeInboxItem.self, from: Data(cleared.utf8)), outputs: nil
      ))
    XCTAssertEqual(inbox.to, "")
    XCTAssertEqual(inbox.cc, "")
    XCTAssertEqual(inbox.subject, "")
  }
  func testSentMailTextDoesNotRenderExecutableOrRemoteHTML() {
    XCTAssertEqual(
      NativeSentEmail.plain(
        "<style>hide</style><p>Hello<br>world &amp; &#x1F44B;</p><script>secret()</script><img src='https://tracker.example'>"
      ), "Hello\nworld & 👋")
    XCTAssertEqual(
      NativeSentEmail.plain(
        "<!-- <p>hidden</p> --><a title=\"a>b\">1 &lt; 2</a> &bogus; <SCRIPT>if (a<b) {}</SCRIPT>&#39;ok&#39;"
      ), "1 < 2 &bogus; 'ok'")
  }
}
