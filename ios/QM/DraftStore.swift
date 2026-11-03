import CryptoKit
import SwiftUI
import os

struct DraftStore {
  let account: String
  let thread: String
  private let epoch: UUID
  private static let epochs = OSAllocatedUnfairLock(initialState: [String: UUID]())
  init(account: String, thread: String) {
    self.account = account
    self.thread = thread
    epoch = Self.epochs.withLock { epochs in
      let value = epochs[account] ?? UUID()
      epochs[account] = value
      return value
    }
  }

  struct Record: Codable {
    var text: String = ""
    var pending: PendingSend?
    var conversation: Conversation?
    var attachments: [UploadAttachment]?
    var inbox: NativeInboxDraft?
    var runtime: RuntimeSelection?
  }

  private static func directory(_ account: String) -> URL {
    let key = SHA256.hash(data: Data(account.utf8)).map { String(format: "%02x", $0) }.joined()
    return URL.applicationSupportDirectory.appendingPathComponent("Drafts/\(key)")
  }

  private var file: URL {
    let key = SHA256.hash(data: Data(thread.utf8)).map { String(format: "%02x", $0) }.joined()
    return Self.directory(account).appendingPathComponent(key + ".json")
  }

  func read() -> Record {
    guard let data = try? Data(contentsOf: file),
      let record = try? JSONDecoder().decode(Record.self, from: data)
    else { return Record() }
    return record
  }

  func write(_ record: Record) throws {
    try Self.epochs.withLock { epochs in
      guard epochs[account] == epoch else { throw CancellationError() }
      var directory = file.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var resources = URLResourceValues()
      resources.isExcludedFromBackup = true
      try directory.setResourceValues(resources)
      try JSONEncoder().encode(record).write(to: file, options: [.atomic, .completeFileProtection])
    }
  }

  static func merging(_ sessions: [Conversation], account: String) -> [Conversation] {
    let threads = Set(sessions.map(\.threadRef))
    let local = conversations(account).filter { !threads.contains($0.threadRef) }
    return (sessions + local).sorted {
      if ($0.pinned == true) != ($1.pinned == true) { return $0.pinned == true }
      return ($0.lastActivityAt ?? 0) > ($1.lastActivityAt ?? 0)
    }
  }

  static func conversations(_ account: String) -> [Conversation] {
    let files =
      (try? FileManager.default.contentsOfDirectory(
        at: directory(account), includingPropertiesForKeys: nil)) ?? []
    return files.compactMap { file in
      guard let data = try? Data(contentsOf: file),
        let record = try? JSONDecoder().decode(Record.self, from: data),
        !record.text.isEmpty || record.pending != nil || !(record.attachments ?? []).isEmpty,
        var conversation = record.conversation
      else { return nil }
      conversation.title = String((record.pending?.text ?? record.text).prefix(80))
      if conversation.title?.isEmpty == true {
        conversation.title = record.attachments?.first?.name
      }
      conversation.localOnly = true
      return conversation
    }
  }

  static func pruneAttachments(_ account: String) throws {
    let files =
      (try? FileManager.default.contentsOfDirectory(
        at: directory(account), includingPropertiesForKeys: nil)) ?? []
    var referenced: Set<String> = []
    for file in files {
      guard let data = try? Data(contentsOf: file),
        let record = try? JSONDecoder().decode(Record.self, from: data)
      else { continue }
      referenced.formUnion(
        ((record.attachments ?? []) + (record.pending?.attachments ?? [])).compactMap(\.localSHA))
    }
    try AttachmentCache.prune(account: account, keeping: referenced)
  }

  static func removeAccount(_ account: String) {
    Self.epochs.withLock { epochs in
      epochs[account] = UUID()
      try? FileManager.default.removeItem(at: directory(account))
      try? AttachmentCache.removeAccount(account: account)
    }
  }
}
