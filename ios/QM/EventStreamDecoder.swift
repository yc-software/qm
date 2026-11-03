import Foundation

struct EventStreamDecoder {
  private var line: [UInt8] = []
  private var data: [String]?
  private var afterCarriageReturn = false

  mutating func push(_ byte: UInt8) -> Data? {
    let continuesLineBreak = afterCarriageReturn && byte == 0x0A
    afterCarriageReturn = byte == 0x0D
    switch byte {
    case 0x0A where continuesLineBreak: return nil
    case 0x0A, 0x0D: return endLine()
    default:
      line.append(byte)
      return nil
    }
  }

  private mutating func endLine() -> Data? {
    defer { line.removeAll(keepingCapacity: true) }
    guard !line.isEmpty else {
      guard let lines = data else { return nil }
      data = nil
      return Data(lines.joined(separator: "\n").utf8)
    }
    let text = String(decoding: line, as: UTF8.self)
    guard let colon = text.firstIndex(of: ":") else {
      if text == "data" {
        data = data ?? []
        data?.append("")
      }
      return nil
    }
    guard text[..<colon] == "data" else { return nil }
    var value = text[text.index(after: colon)...]
    if value.first == " " { value = value.dropFirst() }
    data = data ?? []
    data?.append(String(value))
    return nil
  }
}
